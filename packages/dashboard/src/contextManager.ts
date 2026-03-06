/**
 * Context Manager for Agent Conversations
 * Handles token estimation, message summarization, and plan storage
 */

import type { LlmProvider } from './llm/provider.js';
import { getConversationPlan, setConversationPlan } from './db.js';

// Fallback token estimation: ~4 characters per token
const FALLBACK_CHARS_PER_TOKEN = 4;

// Fixed token estimate per image (dimensions unavailable from base64)
const TOKENS_PER_IMAGE = 1600;

// Thresholds
const TOKEN_LIMIT_SOFT = 100_000;  // Start summarizing at this point
const TOKEN_LIMIT_HARD = 180_000;  // Absolute max before forced truncation
const RECENT_MESSAGES_TO_KEEP = 10; // Keep last N messages unsummarized

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

// Use a generic type to avoid conflicts with local type definitions
export type AgentMessage =
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: 'tool'; content: string; tool_call_id: string };

// Internal alias for backward compat within this file
type AgentMsg = AgentMessage;

/** Default tokenizer: chars / 4 heuristic */
function fallbackCountTokens(text: string): number {
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

/**
 * Estimate token count for a message using the provided tokenizer
 */
function estimateMessageTokens(msg: AgentMsg, countTokensFn: (text: string) => number): number {
  let tokens = 0;

  if (typeof msg.content === 'string') {
    tokens += msg.content ? countTokensFn(msg.content) : 0;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text') {
        tokens += countTokensFn(part.text);
      } else if (part.type === 'image_url') {
        // Fixed estimate per image — dimensions unavailable from base64
        tokens += TOKENS_PER_IMAGE;
      }
    }
  }

  // Add overhead for role, tool_calls structure, etc.
  if ('tool_calls' in msg && msg.tool_calls) {
    tokens += countTokensFn(JSON.stringify(msg.tool_calls));
  }
  if ('tool_call_id' in msg) {
    tokens += 15; // Overhead for tool response structure
  }

  return tokens;
}

/**
 * Estimate total tokens for system prompt + messages.
 * Accepts an optional countTokensFn from the LLM provider for accurate estimation.
 */
export function estimateTotalTokens<T extends { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>(
  systemPrompt: string,
  messages: T[],
  countTokensFn?: (text: string) => number
): number {
  const counter = countTokensFn ?? fallbackCountTokens;
  let total = counter(systemPrompt);
  for (const msg of messages) {
    total += estimateMessageTokens(msg as unknown as AgentMsg, counter);
  }
  return total;
}

/**
 * Session plan storage (in-memory cache + database persistence)
 * Keys can be packId, sessionId, or conversationId
 */
const planStorageCache = new Map<string, string>();

/**
 * Check if a key looks like a conversation ID (UUID format)
 */
function isConversationId(key: string): boolean {
  // UUID v4 pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
}

/**
 * Save a plan for a session
 * If the sessionKey is a conversation ID, persists to database
 */
export function savePlan(sessionKey: string, plan: string): void {
  // Always update in-memory cache
  planStorageCache.set(sessionKey, plan);

  // Persist to database if it's a conversation ID
  if (isConversationId(sessionKey)) {
    try {
      setConversationPlan(sessionKey, plan);
      console.log(`[ContextManager] Plan saved to DB for conversation ${sessionKey} (${plan.length} chars)`);
    } catch (err) {
      console.warn(`[ContextManager] Failed to persist plan to DB:`, err);
    }
  } else {
    console.log(`[ContextManager] Plan saved in-memory for ${sessionKey} (${plan.length} chars)`);
  }
}

/**
 * Get a plan for a session
 * If the sessionKey is a conversation ID, checks database if not in cache
 */
export function getPlan(sessionKey: string): string | null {
  // Check in-memory cache first
  const cached = planStorageCache.get(sessionKey);
  if (cached) {
    return cached;
  }

  // If it's a conversation ID, try loading from database
  if (isConversationId(sessionKey)) {
    try {
      const dbPlan = getConversationPlan(sessionKey);
      if (dbPlan) {
        // Cache it for future access
        planStorageCache.set(sessionKey, dbPlan);
        console.log(`[ContextManager] Plan loaded from DB for conversation ${sessionKey}`);
        return dbPlan;
      }
    } catch (err) {
      console.warn(`[ContextManager] Failed to load plan from DB:`, err);
    }
  }

  return null;
}

/**
 * Summarize older messages to reduce context size
 * Returns a new message array with older messages summarized
 *
 * @template T - The message type (must have role, content properties)
 */
export async function summarizeIfNeeded<T extends AgentMessage>(
  systemPrompt: string,
  messages: T[],
  llmProvider: LlmProvider,
  sessionKey?: string,
  options?: { force?: boolean }
): Promise<{ messages: T[]; wasSummarized: boolean; tokensBefore: number; tokensAfter: number }> {
  const countTokensFn = llmProvider.countTokens.bind(llmProvider);
  const tokensBefore = estimateTotalTokens(systemPrompt, messages, countTokensFn);

  // Check if we need to summarize (skip check when force is true)
  if (!options?.force && tokensBefore < TOKEN_LIMIT_SOFT) {
    return { messages, wasSummarized: false, tokensBefore, tokensAfter: tokensBefore };
  }

  console.log(`[ContextManager] Token count ${tokensBefore} exceeds soft limit ${TOKEN_LIMIT_SOFT}, summarizing...`);

  // Split messages: keep recent, summarize older
  const recentCount = Math.min(RECENT_MESSAGES_TO_KEEP, messages.length);
  const olderMessages = messages.slice(0, -recentCount);
  const recentMessages = messages.slice(-recentCount);

  if (olderMessages.length === 0) {
    // Nothing to summarize, all messages are "recent"
    console.log(`[ContextManager] All messages are recent, cannot summarize further`);
    return { messages, wasSummarized: false, tokensBefore, tokensAfter: tokensBefore };
  }

  // Get existing plan if any
  const existingPlan = sessionKey ? getPlan(sessionKey) : null;

  // Build summary prompt
  const olderContent = olderMessages.map((m, i) => {
    const role = m.role.toUpperCase();
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content || '(empty)';
    } else if (Array.isArray(m.content)) {
      content = m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join('\n') || '(media content)';
    }
    if ('tool_calls' in m && m.tool_calls) {
      const toolNames = (m.tool_calls as Array<{ name: string }>).map(tc => tc.name).join(', ');
      content += `\n[Called tools: ${toolNames}]`;
    }
    if ('tool_call_id' in m) {
      content = `[Tool result for ${m.tool_call_id}]: ${content.slice(0, 500)}${content.length > 500 ? '...' : ''}`;
    }
    // Truncate very long messages in the summary input
    if (content.length > 2000) {
      content = content.slice(0, 2000) + '... (truncated)';
    }
    return `[${i + 1}] ${role}: ${content}`;
  }).join('\n\n');

  const summarySystemPrompt = `You are a conversation summarizer. Create a concise summary of the conversation that preserves:
1. The user's original goal/request
2. Key decisions made
3. Important findings or results
4. Current state/progress
5. Any errors encountered and how they were resolved

${existingPlan ? `\nEXISTING PLAN (keep this intact):\n${existingPlan}\n` : ''}

Keep the summary under 2000 words. Focus on information needed to continue the conversation.`;

  const summaryPrompt = `Summarize this conversation history:\n\n${olderContent}`;

  try {
    const summary = await llmProvider.chat({
      systemPrompt: summarySystemPrompt,
      messages: [{ role: 'user', content: summaryPrompt }],
    });

    // Create summarized message array
    // Cast to T since summary message has compatible structure with user messages
    const summaryMessage = {
      role: 'user' as const,
      content: `[CONVERSATION SUMMARY - Earlier messages have been summarized to save context]\n\n${summary}\n\n[END SUMMARY - Recent messages follow]`,
    } as T;

    const newMessages: T[] = [summaryMessage, ...recentMessages];
    const tokensAfter = estimateTotalTokens(systemPrompt, newMessages, countTokensFn);

    console.log(`[ContextManager] Summarized ${olderMessages.length} messages. Tokens: ${tokensBefore} -> ${tokensAfter}`);

    // If still over hard limit, we need to be more aggressive
    if (tokensAfter > TOKEN_LIMIT_HARD) {
      console.log(`[ContextManager] Still over hard limit, truncating recent messages`);
      // Keep only the summary and last 3 messages
      const truncatedMessages: T[] = [summaryMessage, ...recentMessages.slice(-3)];
      const tokensFinal = estimateTotalTokens(systemPrompt, truncatedMessages, countTokensFn);
      return { messages: truncatedMessages, wasSummarized: true, tokensBefore, tokensAfter: tokensFinal };
    }

    return { messages: newMessages, wasSummarized: true, tokensBefore, tokensAfter };
  } catch (error) {
    // C3: Summarization failed — return wasSummarized: false since we only truncated
    console.error(`[ContextManager] Summarization FAILED — falling back to message truncation (information may be lost)`);
    const fallbackMessages = messages.slice(-RECENT_MESSAGES_TO_KEEP);
    const tokensAfter = estimateTotalTokens(systemPrompt, fallbackMessages, countTokensFn);
    return { messages: fallbackMessages, wasSummarized: false, tokensBefore, tokensAfter };
  }
}

/**
 * Force summarization regardless of token count.
 * Convenience wrapper around summarizeIfNeeded with force: true.
 */
export async function forceSummarize<T extends AgentMessage>(
  systemPrompt: string,
  messages: T[],
  llmProvider: LlmProvider,
  sessionKey?: string
): Promise<{ messages: T[]; wasSummarized: boolean; tokensBefore: number; tokensAfter: number }> {
  return summarizeIfNeeded(systemPrompt, messages, llmProvider, sessionKey, { force: true });
}

/**
 * Execute plan tools
 */
export function executePlanTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionKey: string
): string {
  if (toolName === 'agent_save_plan') {
    const plan = args.plan as string;
    if (!plan) {
      return JSON.stringify({ error: 'plan parameter is required' });
    }
    savePlan(sessionKey, plan);
    return JSON.stringify({ success: true, message: 'Plan saved successfully' });
  }

  if (toolName === 'agent_get_plan') {
    const plan = getPlan(sessionKey);
    if (plan) {
      return JSON.stringify({ success: true, plan });
    }
    return JSON.stringify({ success: true, plan: null, message: 'No plan saved yet' });
  }

  return JSON.stringify({ error: `Unknown plan tool: ${toolName}` });
}
