/**
 * Headless Agent Runner
 *
 * Runs agents (Exploration, Editor) without the full dashboard server context.
 * Useful for CLI execution and scripting.
 */

import { join, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { TaskPackLoader } from '@showrun/core';
import { TaskPackEditorWrapper } from './mcpWrappers.js';
import { initDatabase, createConversation, getConversation, getMessagesForConversation, addMessage, updateConversation } from './db.js';
import { createLlmProvider } from './llm/index.js';
import { runExplorationAgent } from './agents/explorationAgent.js';
import { runEditorAgent } from './agents/editorAgent.js';
import { assembleSystemPrompt } from './promptAssembler.js';
import { FALLBACK_SYSTEM_PROMPT } from './fallbackPrompt.js';
import type { AgentLoopResult } from './agents/types.js';
import type { DashboardContext } from './types/context.js';
import type { AgentToolContext } from './agentTools.js';
import { executeAgentTool } from './agentTools.js';
import { reconstructAgentMessages } from './contextManager.js';
import { discoverPacks } from '@showrun/mcp-server';

export interface HeadlessAgentOptions {
  packId: string;
  prompt: string;
  agentType: 'explore' | 'editor';
  conversationId?: string;
  headful?: boolean;
  verbose?: boolean;
  dataDir?: string;
  packDirs?: string[];
}

export async function runHeadlessAgent(options: HeadlessAgentOptions): Promise<AgentLoopResult & { conversationId: string }> {
  const {
    packId,
    prompt,
    agentType,
    conversationId: providedConversationId,
    headful = false,
    verbose = false,
    dataDir = './data',
    packDirs = ['./taskpacks']
  } = options;

  // 1. Initialize DB
  initDatabase(dataDir);

  // 2. Initialize LLM Provider
  const llmProvider = createLlmProvider();

  // 3. Initialize TaskPackEditorWrapper (fs-connected)
  // We need a workspace dir - usually the first pack dir
  const workspaceDir = packDirs[0] ? resolve(packDirs[0]) : resolve('./taskpacks');
  if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });

  const taskPackEditor = new TaskPackEditorWrapper(
    packDirs.map(d => resolve(d)),
    workspaceDir,
    resolve(dataDir, 'runs'),
    headful
  );

  // 4. Verify pack exists
  try {
    // Force discovery to populate cache (though wrapper does it internally)
    await discoverPacks({ directories: packDirs.map(d => resolve(d)) });
    await taskPackEditor.readPack(packId);
  } catch (error) {
    throw new Error(`Pack "${packId}" not found in [${packDirs.join(', ')}]. Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 5. Setup Conversation
  let conversationId = providedConversationId;
  let conversation;

  if (conversationId) {
    conversation = getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation "${conversationId}" not found.`);
    }
    if (conversation.packId !== packId) {
      // Warn but allow, or update? Let's update if it's null, otherwise warn.
      if (!conversation.packId) {
        updateConversation(conversationId, { packId });
      } else {
        console.warn(`Warning: Conversation "${conversationId}" is linked to pack "${conversation.packId}", but you requested pack "${packId}". Switching context to "${packId}".`);
        updateConversation(conversationId, { packId });
      }
    }
  } else {
    conversation = createConversation(
      prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''),
      `CLI ${agentType} session`
    );
    conversationId = conversation.id;
    updateConversation(conversationId, { packId });
    if (verbose) console.log(`Created new conversation: ${conversationId}`);
  }

  // 6. Build Context
  // Mock minimal DashboardContext requirements
  // We don't have a real Socket.IO server, so we mock a dummy emitter
  const mockIo = {
    emit: (event: string, ...args: any[]) => {
      if (verbose) console.log(`[IO] ${event}`, args);
    }
  } as any;

  // 7. Prepare System Prompt
  // In headless mode, we skip TechniqueManager for now unless we want to initialize it too.
  // For simplicity, use fallback prompt.
  const systemPrompt = FALLBACK_SYSTEM_PROMPT;

  // 8. Prepare Messages
  let initialMessages: any[] = [];
  if (providedConversationId) {
    // Resume conversation
    // reconstructAgentMessages handles loading from DB and formatting for LLM
    initialMessages = reconstructAgentMessages(conversationId);
    // Add new user prompt
    initialMessages.push({ role: 'user', content: prompt });
  } else {
    // New conversation
    initialMessages = [{ role: 'user', content: prompt }];
  }

  // Add the new user message to DB immediately
  addMessage(conversationId, 'user', prompt);

  // 9. Run Agent
  const toolContext: AgentToolContext = {
    taskPackEditor,
    packId,
    conversationId,
    headful,
    // onSecretsRequest: ... (CLI would need interactive prompt, skipping for now)
  };

  const onStreamEvent = (event: any) => {
    if (verbose) {
       if (event.type === 'tool_start') console.log(`[Tool] ${event.tool}`);
       if (event.type === 'thinking_delta') process.stdout.write(event.delta);
    }
  };

  let secretsMissing = false;
  const onToolResult = (name: string, args: any, result: any, success: boolean) => {
    if (name === 'request_secrets' && result && typeof result === 'object' && result._type === 'secrets_request') {
      secretsMissing = true;
      const missing = result.secrets.map((s: any) => s.name).join(', ');
      console.log('\n\n=== ACTION REQUIRED: MISSING SECRETS ===');
      console.log(`The agent requires the following secrets: ${missing}`);
      console.log(`Please add them to the .secrets.json file in your task pack directory.`);
      console.log(`Then, resume this conversation using: showrun agent explore ${packId} "Continue" --conversation ${conversationId}`);
      console.log('==========================================\n');
    }
  };

  let result: AgentLoopResult;

  if (agentType === 'explore') {
    result = await runExplorationAgent({
      systemPrompt,
      initialMessages,
      llmProvider,
      toolContext,
      onStreamEvent,
      onToolResult,
      maxIterations: 50, // CLI limit
    });
  } else {
    // Editor Agent
    // We need to determine pack kind
    const packData = await taskPackEditor.readPack(packId);
    const packKind = (packData as any).taskpackJson?.kind || 'json-dsl';

    // Editor Agent takes instruction + context.
    // In CLI mode "showrun agent editor <pack> <prompt>", the prompt is the instruction.
    // But Editor Agent typically expects "explorationContext" too.
    // If we are continuing a conversation, maybe we can pull context from history?
    // For now, we'll pass the prompt as instruction and empty context if new.
    
    // NOTE: Editor Agent is usually invoked BY Exploration Agent via agent_build_flow.
    // Running it directly via CLI might be for "fix this specific thing".
    
    const editorResult = await runEditorAgent({
      packKind,
      instruction: prompt,
      explorationContext: "CLI invoked editor session. Use existing pack state.",
      testInputs: {}, // User would need to provide this via flags if we want to support it
      llmProvider,
      toolExecutor: (name: string, args: Record<string, unknown>) => {
        return executeAgentTool(name, args, toolContext);
      },
      onStreamEvent
    });

    result = {
      finalContent: editorResult.summary,
      toolTrace: [], // Not tracked by editor agent result
      iterationsUsed: editorResult.iterationsUsed,
      aborted: !!editorResult.error?.includes('Aborted'),
      messages: [], // Not tracked by editor agent result
    };
  }

  // 10. Save Assistant Response
  if (result.finalContent) {
    addMessage(conversationId, 'assistant', result.finalContent);
  }

  // 11. Cleanup: Close browser session
  try {
    const { getConversationBrowserSession } = await import('./agentTools.js');
    const { closeSession: closeBrowser } = await import('./browserInspector.js');
    const sessionId = getConversationBrowserSession(conversationId);
    if (sessionId) {
      if (verbose) console.log(`[Headless] Closing browser session: ${sessionId}`);
      await closeBrowser(sessionId);
    }
  } catch (err) {
    if (verbose) console.warn('[Headless] Cleanup failed:', err);
  }

  return { ...result, conversationId };
}
