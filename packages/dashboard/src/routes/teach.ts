import { Router, type Request, type Response } from 'express';
import type { DashboardContext } from '../types/context.js';
import { createTokenChecker } from '../helpers/auth.js';
import { TaskPackLoader } from '@showrun/core';
import { discoverPacks } from '@showrun/mcp-server';
import { proposeStep, type ProposeStepRequest } from '../teachMode.js';
import { updateConversation, getConversation, getAllConversations } from '../db.js';
import type { ChatMessage, ToolCall, StreamEvent, ChatWithToolsResult, ToolDef } from '../llm/provider.js';
import {
  MAIN_AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  type AgentToolContext,
} from '../agentTools.js';
import { TaskPackEditorWrapper } from '../mcpWrappers.js';
import { summarizeIfNeeded, estimateTotalTokens } from '../contextManager.js';
import { createLlmProvider } from '../llm/index.js';

// MAX_NON_EDITOR_ITERATIONS: limits consecutive browser-only rounds (set to 0 to disable)
const MAX_NON_EDITOR_ITERATIONS = parseInt(process.env.AGENT_MAX_BROWSER_ROUNDS || '0', 10);
const MAX_TOTAL_ITERATIONS = 100; // Absolute safety cap

/** Tool definition for initializer agent - only pack creation */
const INITIALIZER_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'create_pack',
    description: 'Create a task pack for this automation',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Pack ID in reverse domain notation (e.g., "gmail.email.scraper", "yc.company.collector")',
        },
        name: {
          type: 'string',
          description: 'Human-readable name (e.g., "Gmail Email Scraper")',
        },
      },
      required: ['id', 'name'],
    },
  },
};

const INITIALIZER_SYSTEM_PROMPT = `You are a pack naming assistant. Given the user's automation request, create a task pack with an appropriate ID and name.

Rules for pack ID:
- Use reverse domain notation: site.purpose.action (e.g., "gmail.email.scraper", "yc.companies.collector")
- Lowercase, alphanumeric, dots and hyphens only
- Keep it short but descriptive

Rules for pack name:
- Human-readable title (e.g., "Gmail Email Scraper", "YC Companies Collector")
- Capitalize appropriately

Call create_pack with your chosen id and name.`;

/**
 * Run lightweight LLM call to create and name pack based on user's intent.
 * This runs BEFORE the main agent loop to ensure packId is always set.
 */
async function runPackInitializer(
  userMessage: string,
  editor: TaskPackEditorWrapper,
  convId: string,
  provider: ReturnType<typeof createLlmProvider>
): Promise<{ id: string; path: string; name: string }> {
  // Single LLM call with minimal context
  const result = await (provider as any).chatWithTools({
    systemPrompt: INITIALIZER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    tools: [INITIALIZER_TOOL],
  });

  // Extract tool call
  let packId: string;
  let packName: string;

  if (result.toolCalls && result.toolCalls.length > 0) {
    const tc = result.toolCalls[0];
    let args: { id?: string; name?: string } = {};
    try {
      args = JSON.parse(tc.arguments || '{}');
    } catch {
      // ignore parse errors
    }
    packId = args.id || `pack.${Date.now().toString(36)}`;
    packName = args.name || 'New Automation';
  } else {
    // Fallback if LLM didn't call tool
    packId = `pack.${Date.now().toString(36)}`;
    packName = userMessage.slice(0, 60) || 'New Automation';
  }

  // Sanitize pack ID: lowercase, only alphanumeric/dots/hyphens/underscores
  packId = packId.toLowerCase().replace(/[^a-z0-9._-]/g, '.');

  // Create pack via editor wrapper
  const packResult = await editor.createPack(packId, packName);

  // Link to conversation in database
  updateConversation(convId, { packId });

  console.log(`[PackInit] Created pack "${packId}" for conversation ${convId}`);

  return { id: packId, path: packResult.path, name: packName };
}

export function createTeachRouter(ctx: DashboardContext): Router {
  const router = Router();
  const requireToken = createTokenChecker(ctx.sessionToken);

  // Helper: Find pack by ID
  function findPackById(packId: string) {
    return ctx.packMap.get(packId) || null;
  }

  // REST API: Propose step (Teach Mode)
  router.post('/api/teach/propose-step', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!ctx.llmProvider) {
      return res.status(503).json({ error: 'LLM provider not configured (OPENAI_API_KEY required)' });
    }

    const request = req.body as ProposeStepRequest;

    if (!request.packId || !request.userIntent || !request.elementFingerprint) {
      return res.status(400).json({ error: 'packId, userIntent, and elementFingerprint are required' });
    }

    // Verify pack exists and is JSON-DSL
    const packInfo = findPackById(request.packId);
    if (!packInfo) {
      return res.status(404).json({ error: `Pack not found: ${request.packId}` });
    }

    try {
      const manifest = TaskPackLoader.loadManifest(packInfo.path);
      if (manifest.kind !== 'json-dsl') {
        return res.status(400).json({ error: 'Pack is not a JSON-DSL pack' });
      }
    } catch {
      return res.status(400).json({ error: 'Pack is not a JSON-DSL pack' });
    }

    try {
      const proposal = await proposeStep(ctx.llmProvider, request);
      res.json(proposal);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Teach Mode chat (AI flow-writing assistant)
  router.post('/api/teach/chat', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!ctx.llmProvider) {
      return res.status(503).json({ error: 'LLM provider not configured (OPENAI_API_KEY required)' });
    }

    const { messages, systemPromptOverride, packId } = req.body as {
      messages: ChatMessage[];
      systemPromptOverride?: string;
      packId?: string;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required and must not be empty' });
    }

    let systemPrompt = systemPromptOverride ?? ctx.systemPrompt;
    if (packId) {
      const packInfo = findPackById(packId);
      if (packInfo) {
        try {
          const { flowJson } = await ctx.taskPackEditor.readPack(packId);
          const flowSummary = `Current pack "${packId}" flow: ${JSON.stringify(flowJson, null, 2).slice(0, 2000)}`;
          systemPrompt = `${systemPrompt}\n\n${flowSummary}`;
        } catch {
          // ignore
        }
      }
    }

    try {
      const reply = await ctx.llmProvider.chat({
        systemPrompt,
        messages,
      });
      res.json({ reply });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Teach Mode agent (MCPs ALWAYS ON – action-first)
  router.post('/api/teach/agent', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!ctx.llmProvider || typeof (ctx.llmProvider as any).chatWithTools !== 'function') {
      return res.status(503).json({ error: 'LLM provider with tool support not configured' });
    }

    const { messages, packId: requestPackId, conversationId, stream: streamFlowUpdates } = req.body as {
      messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; name?: string }>;
      packId?: string | null;
      conversationId?: string | null;
      /** If true, stream flow_updated after each editor_apply_flow_patch so the UI can update in real time */
      stream?: boolean;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required and must not be empty' });
    }

    // Auto-initialize pack if not linked yet
    let effectivePackId = requestPackId;
    if (!effectivePackId && conversationId && ctx.llmProvider) {
      const conversation = getConversation(conversationId);
      if (conversation && !conversation.packId) {
        // Get first user message for pack naming
        const firstUserMsg = messages.find((m) => m.role === 'user')?.content || '';

        try {
          const packInfo = await runPackInitializer(
            firstUserMsg,
            ctx.taskPackEditor,
            conversationId,
            ctx.llmProvider
          );
          effectivePackId = packInfo.id;

          // Emit update so frontend knows pack is linked
          ctx.io.emit('conversations:updated', getAllConversations());
          // Also emit packs:updated since a new pack was created
          discoverPacks({ directories: ctx.packDirs }).then((newPacks) => {
            ctx.packMap.clear();
            for (const { pack, path } of newPacks) {
              ctx.packMap.set(pack.metadata.id, { pack, path });
            }
            ctx.io.emit('packs:updated', ctx.packMap.size);
          });
        } catch (err) {
          console.error('[PackInit] Failed to create pack:', err);
          // Continue without pack - agent can still run, just no secrets
        }
      } else if (conversation?.packId) {
        // Use existing pack from conversation
        effectivePackId = conversation.packId;
      }
    }

    let systemPrompt = ctx.systemPrompt;
    if (effectivePackId) {
      systemPrompt = `${systemPrompt}\n\n**Pack "${effectivePackId}" is linked to this conversation. Use editor_read_pack("${effectivePackId}") to see its current state, then use editor_apply_flow_patch to modify it.**`;
    }
    // Note: Browser sessions are now managed automatically per-conversation.
    // No need to inform the AI about session management.

    type ContentPart =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } };
    type AgentMsg =
      | { role: 'user'; content: string | ContentPart[] }
      | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
      | { role: 'tool'; content: string; tool_call_id: string };

    let agentMessages: AgentMsg[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const toolTrace: Array<{ tool: string; args: Record<string, unknown>; result: unknown; success: boolean }> = [];
    let updatedFlow: unknown = undefined;
    let validation: { ok: boolean; errors: string[]; warnings: string[] } | undefined = undefined;
    let browserResponse:
      | { screenshotBase64?: string; mimeType?: string; url?: string; screenshotSentAt?: number }
      | undefined = undefined;

    let nonEditorRounds = 0;
    // Enable streaming whenever client requests it (stream: true)
    const streamFlow = !!streamFlowUpdates;
    if (streamFlow) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders?.();
    }

    // Track if request was aborted by client (stop button pressed)
    let aborted = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
        console.log('[Agent] Request aborted by client (stop button)');
      }
    });

    const writeStreamLine = (obj: object) => {
      if (streamFlow && !aborted) res.write(JSON.stringify(obj) + '\n');
    };

    // Check if provider supports streaming
    const supportsStreaming = typeof (ctx.llmProvider as any).chatWithToolsStream === 'function';

    // Session key for plan storage - prefer conversationId for persistence
    const sessionKey = conversationId || effectivePackId || `session_${Date.now()}`;

    // Helper to call LLM with or without streaming (uses agentMessages which may be modified by summarization)
    // Note: Uses MAIN_AGENT_TOOL_DEFINITIONS which excludes editor_create_pack and conversation_link_pack
    // since pack creation is now automatic via runPackInitializer
    async function callLlm(currentMessages: AgentMsg[]): Promise<ChatWithToolsResult> {
      if (supportsStreaming && streamFlow) {
        const generator = (ctx.llmProvider as any).chatWithToolsStream({
          systemPrompt,
          messages: currentMessages,
          tools: MAIN_AGENT_TOOL_DEFINITIONS,
          enableThinking: true,
        }) as AsyncGenerator<StreamEvent, ChatWithToolsResult, unknown>;

        let iterResult = await generator.next();
        while (!iterResult.done) {
          const event = iterResult.value as StreamEvent;
          // Forward streaming events to client
          writeStreamLine(event);
          iterResult = await generator.next();
        }
        return iterResult.value;
      } else {
        return await (ctx.llmProvider as any).chatWithTools({
          systemPrompt,
          messages: currentMessages,
          tools: MAIN_AGENT_TOOL_DEFINITIONS,
        });
      }
    }

    try {
      for (let iter = 0; iter < MAX_TOTAL_ITERATIONS; iter++) {
        // Check if client aborted (stop button pressed)
        if (aborted) {
          console.log('[Agent] Stopping agent loop - client aborted');
          if (streamFlow) {
            writeStreamLine({ type: 'done', error: 'Stopped by user' });
            res.end();
          }
          return;
        }

        // Check token count and summarize if needed
        const tokenEstimate = estimateTotalTokens(systemPrompt, agentMessages);
        if (tokenEstimate > 100_000) {
          console.log(`[Agent] Token estimate ${tokenEstimate} exceeds threshold, attempting summarization...`);
          writeStreamLine({ type: 'summarizing', tokensBefore: tokenEstimate });
          try {
            const summaryResult = await summarizeIfNeeded(
              systemPrompt,
              agentMessages,
              ctx.llmProvider!,
              sessionKey
            );
            if (summaryResult.wasSummarized) {
              agentMessages = summaryResult.messages;
              console.log(`[Agent] Summarized: ${summaryResult.tokensBefore} -> ${summaryResult.tokensAfter} tokens`);
              writeStreamLine({
                type: 'summarized',
                tokensBefore: summaryResult.tokensBefore,
                tokensAfter: summaryResult.tokensAfter,
              });
            }
          } catch (summaryError) {
            console.error('[Agent] Summarization failed:', summaryError);
            // Continue anyway, the API will fail if truly over limit
          }
        }

        const result = await callLlm(agentMessages);

        if (result.toolCalls && result.toolCalls.length > 0) {
          // Track consecutive browser-only rounds (only enforce if limit > 0)
          const hasNonEditorCall = result.toolCalls.some((tc: { name: string }) => tc.name.startsWith('browser_'));
          if (hasNonEditorCall) {
            nonEditorRounds++;
            if (MAX_NON_EDITOR_ITERATIONS > 0 && nonEditorRounds >= MAX_NON_EDITOR_ITERATIONS) {
              if (streamFlow) {
                writeStreamLine({ type: 'done', error: 'Agent exceeded max browser iterations' });
                res.end();
              } else {
                res.status(500).json({ error: 'Agent exceeded max browser iterations' });
              }
              return;
            }
          }

          agentMessages.push({
            role: 'assistant',
            content: result.content ?? null,
            tool_calls: result.toolCalls,
          });
          const toolCtx: AgentToolContext = {
            taskPackEditor: ctx.taskPackEditor,
            packId: effectivePackId ?? null,
            sessionKey,
            conversationId: conversationId ?? null,
            headful: ctx.headful, // Dashboard always runs headful
          };
          for (const tc of result.toolCalls) {
            let toolArgs: Record<string, unknown> = {};
            try {
              toolArgs = JSON.parse(tc.arguments || '{}');
            } catch {
              // ignore
            }

            // Emit tool_start event before executing the tool
            writeStreamLine({ type: 'tool_start', tool: tc.name, args: toolArgs });

            const execResult = await executeAgentTool(tc.name, toolArgs, toolCtx);
            let resultStr = execResult.stringForLlm;
            let resultParsed: unknown;
            try {
              resultParsed = JSON.parse(resultStr);
            } catch {
              resultParsed = resultStr;
            }
            const success = !(resultParsed && typeof resultParsed === 'object' && 'error' in resultParsed);
            toolTrace.push({ tool: tc.name, args: toolArgs, result: resultParsed, success });

            // Emit conversation updates when conversation_* tools are called
            if (tc.name.startsWith('conversation_') && success && conversationId) {
              ctx.io.emit('conversations:updated', getAllConversations());
            }

            // Emit packs:updated when a new pack is created
            if (tc.name === 'editor_create_pack' && success) {
              // Re-discover packs and update packMap
              discoverPacks({ directories: ctx.packDirs }).then((newPacks) => {
                ctx.packMap.clear();
                for (const { pack, path } of newPacks) {
                  ctx.packMap.set(pack.metadata.id, { pack, path });
                }
                ctx.io.emit('packs:updated', ctx.packMap.size);
              });
            }

            // Emit tool_result event after executing the tool
            writeStreamLine({ type: 'tool_result', tool: tc.name, args: toolArgs, result: resultParsed, success });

            // Check for abort after each tool execution
            if (aborted) {
              console.log('[Agent] Stopping mid-tool-loop - client aborted');
              if (streamFlow) {
                writeStreamLine({ type: 'done', error: 'Stopped by user' });
                res.end();
              }
              return;
            }

            // Browser sessions are now managed automatically - no need to track sessionId
            if (execResult.browserSnapshot) {
              browserResponse = {
                screenshotBase64: execResult.browserSnapshot.screenshotBase64,
                mimeType: execResult.browserSnapshot.mimeType,
                url: execResult.browserSnapshot.url,
              };
            }
            if (tc.name === 'editor_apply_flow_patch' && effectivePackId) {
              try {
                const { flowJson } = await ctx.taskPackEditor.readPack(effectivePackId);
                updatedFlow = flowJson;
                const val = await ctx.taskPackEditor.validateFlow(JSON.stringify(flowJson));
                validation = { ok: val.ok, errors: val.errors, warnings: val.warnings };
                writeStreamLine({ type: 'flow_updated', flow: flowJson, validation: val });
              } catch {
                // ignore
              }
            }

            // Handle secrets request - block until user provides secrets
            if (tc.name === 'request_secrets' && conversationId) {
              try {
                const parsed = resultParsed as { _type?: string; secrets?: unknown[]; message?: string };
                if (parsed?._type === 'secrets_request' && parsed.secrets && parsed.message) {
                  // Use the effectivePackId that was set at the start of the request
                  // (pack is auto-initialized before the agent loop starts)

                  // Emit streaming event to show the modal
                  writeStreamLine({
                    type: 'secrets_request',
                    secrets: parsed.secrets,
                    message: parsed.message,
                    packId: effectivePackId,
                    conversationId,
                  });

                  // Block execution until user provides secrets
                  console.log(`[Agent] Waiting for user to provide secrets for conversation ${conversationId}...`);
                  const secretNames = await new Promise<string[]>((resolve, reject) => {
                    // Store the resolve function so the secrets-filled endpoint can call it
                    ctx.pendingSecretsRequests.set(conversationId, { resolve, reject });

                    // Set a timeout (5 minutes) to prevent hanging forever
                    setTimeout(() => {
                      if (ctx.pendingSecretsRequests.has(conversationId)) {
                        ctx.pendingSecretsRequests.delete(conversationId);
                        reject(new Error('Timeout waiting for secrets - user did not respond within 5 minutes'));
                      }
                    }, 5 * 60 * 1000);
                  });

                  console.log(`[Agent] User provided secrets: ${secretNames.join(', ')}`);

                  // Update the tool result to indicate success
                  resultStr = JSON.stringify({
                    success: true,
                    message: `User provided secrets: ${secretNames.join(', ')}. You can now use {{secret.NAME}} templates in steps.`,
                    secretsProvided: secretNames,
                  });
                }
              } catch (secretsError) {
                console.error('[Agent] Error waiting for secrets:', secretsError);
                resultStr = JSON.stringify({
                  error: secretsError instanceof Error ? secretsError.message : String(secretsError),
                });
              }
            }

            agentMessages.push({ role: 'tool', content: resultStr, tool_call_id: tc.id });
          }
          // Redaction guard: attach screenshot to LLM only when agent explicitly requested it (browser_screenshot was called)
          if (browserResponse?.screenshotBase64 && browserResponse?.mimeType) {
            const dataUrl = `data:${browserResponse.mimeType};base64,${browserResponse.screenshotBase64}`;
            agentMessages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Screenshot attached for analysis. Analyze the page and answer the user.',
                },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            });
            browserResponse.screenshotSentAt = Date.now();
          }
          continue;
        }

        if (streamFlow) {
          writeStreamLine({
            type: 'done',
            assistantMessage: { role: 'assistant' as const, content: result.content ?? '' },
            toolTrace,
            ...(updatedFlow !== undefined && { updatedFlow }),
            ...(validation !== undefined && { validation }),
            ...(browserResponse !== undefined && { browser: browserResponse }),
          });
          res.end();
        } else {
          res.json({
            assistantMessage: { role: 'assistant' as const, content: result.content ?? '' },
            toolTrace,
            ...(updatedFlow !== undefined && { updatedFlow }),
            ...(validation !== undefined && { validation }),
            ...(browserResponse !== undefined && { browser: browserResponse }),
          });
        }
        return;
      }

      if (streamFlow) {
        writeStreamLine({ type: 'done', error: 'Agent exceeded max iterations' });
        res.end();
      } else {
        res.status(500).json({ error: 'Agent exceeded max iterations' });
      }
    } catch (error) {
      if (streamFlow) {
        writeStreamLine({ type: 'done', error: error instanceof Error ? error.message : String(error) });
        res.end();
      } else {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  // REST API: Resume agent after secrets have been filled
  router.post('/api/teach/agent/:conversationId/secrets-filled', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { conversationId } = req.params;
    const { secretNames } = req.body as { secretNames?: string[] };

    // Verify conversation exists
    const conversation = getConversation(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const secretsList = secretNames || [];

    // Resolve the pending secrets request to unblock the agent
    const pending = ctx.pendingSecretsRequests.get(conversationId);
    if (pending) {
      console.log(`[Agent] Resolving pending secrets request for conversation ${conversationId}`);
      ctx.pendingSecretsRequests.delete(conversationId);
      pending.resolve(secretsList);
    } else {
      console.log(`[Agent] No pending secrets request found for conversation ${conversationId}`);
    }

    // Emit event so UI knows secrets were filled
    ctx.io.emit('conversations:updated', getAllConversations());

    res.json({
      success: true,
      message: 'Secrets recorded. Agent will continue automatically.',
      secretsProvided: secretsList,
    });
  });

  // REST API: Apply flow patch (Teach Mode)
  router.post('/api/teach/apply-patch', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId, patch } = req.body;

    if (!packId || !patch) {
      return res.status(400).json({ error: 'packId and patch are required' });
    }

    try {
      const result = await ctx.taskPackEditor.applyFlowPatch(packId, patch);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
