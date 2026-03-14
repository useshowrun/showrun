/**
 * Exploration Agent: autonomous web exploration and roadmap creation.
 *
 * This agent uses browser tools to explore websites, understand data structures,
 * and create an implementation roadmap. It then delegates to the Editor Agent
 * to build the actual DSL flow.
 */

import { EXPLORATION_AGENT_TOOLS, executeAgentTool } from '../agentTools.js';
import { runAgentLoop } from './runAgentLoop.js';
import { runEditorAgent } from './editorAgent.js';
import type { AgentLoopOptions, AgentLoopResult } from './types.js';
import type { AgentToolContext } from '../agentTools.js';
import { TaskPackLoader } from '@showrun/core';

export interface ExplorationAgentOptions extends Omit<AgentLoopOptions, 'tools' | 'toolExecutor'> {
  toolContext: AgentToolContext;
}

/**
 * Run the Exploration Agent loop.
 *
 * This function orchestrates the exploration process:
 * 1. Runs the agent loop with exploration tools (browser, network, etc.)
 * 2. Handles tool execution via executeAgentTool
 * 3. Handles delegation to Editor Agent (agent_build_flow)
 */
export async function runExplorationAgent(options: ExplorationAgentOptions): Promise<AgentLoopResult> {
  const { toolContext, ...loopOptions } = options;

  // Custom tool executor that handles delegation to Editor Agent
  const toolExecutor = async (name: string, args: Record<string, unknown>) => {
    // 1. Handle delegation to Editor Agent
    if (name === 'agent_build_flow') {
      try {
        const instruction = args.instruction as string;
        const explorationContext = args.explorationContext as string;
        const testInputs = (args.testInputs as Record<string, unknown>) || {};

        if (!instruction || !explorationContext) {
          return { stringForLlm: JSON.stringify({ error: 'Missing required arguments: instruction and explorationContext' }) };
        }

        // Close the Exploration Agent's browser session before the Editor Agent starts
        // This prevents lock contention on the persistent context directory
        if (toolContext.conversationId) {
          const { getConversationBrowserSession, setConversationBrowserSession } = await import('../agentTools.js');
          const { closeSession } = await import('../browserInspector.js');
          const sessionId = getConversationBrowserSession(toolContext.conversationId);
          if (sessionId) {
            console.log('[ExplorationAgent] Closing browser session before delegating to Editor Agent');
            await closeSession(sessionId);
            setConversationBrowserSession(toolContext.conversationId, null);
          }
        }

        // Run the Editor Agent
        // We use the same packId and context
        if (!toolContext.packId) {
          return { stringForLlm: JSON.stringify({ error: 'No pack linked to this conversation. Cannot build flow.' }) };
        }

        // Load pack to determine kind
        const packData = await toolContext.taskPackEditor.readPack(toolContext.packId);
        const packKind = (packData as any).taskpackJson?.kind || 'json-dsl';

        const editorResult = await runEditorAgent({
          packKind,
          instruction,
          explorationContext,
          testInputs,
          llmProvider: options.llmProvider,
          toolExecutor: (name: string, args: Record<string, unknown>) => executeAgentTool(name, args, toolContext),
          onStreamEvent: options.onStreamEvent, // Pass stream events up
        });

        // Return summary to the Exploration Agent
        if (editorResult.success) {
          return {
            stringForLlm: JSON.stringify({
              success: true,
              summary: editorResult.summary,
              stepsCreated: editorResult.stepsCreated,
              collectibles: editorResult.collectiblesCount,
              message: 'Editor Agent succeeded. You can now verify the results or ask the user for next steps.',
            }, null, 2)
          };
        } else {
          return {
            stringForLlm: JSON.stringify({
              success: false,
              error: editorResult.error || 'Editor Agent failed',
              summary: editorResult.summary,
            }, null, 2)
          };
        }
      } catch (err) {
        return { stringForLlm: JSON.stringify({ error: `Editor Agent execution failed: ${err instanceof Error ? err.message : String(err)}` }) };
      }
    }

    // 2. Handle secrets requests for CLI/Headless mode
    if (name === 'request_secrets' && toolContext.packId) {
      try {
        const requested = args.secrets as Array<{ name: string }>;
        const packs = await toolContext.taskPackEditor.listPacks();
        const pack = packs.find(p => p.id === toolContext.packId);
        
        if (pack?.path) {
          const existing = TaskPackLoader.loadSecrets(pack.path);
          const missing = requested.filter(s => !existing[s.name]);

          if (missing.length === 0) {
            // Auto-resolve: secrets are already in the file
            return { 
              stringForLlm: JSON.stringify({ 
                success: true, 
                message: "All requested secrets are already present in .secrets.json. You can continue with the automation." 
              }) 
            };
          }
        }
      } catch (err) {
        console.warn('[ExplorationAgent] Failed to check secrets file:', err);
      }
    }

    // Default tool execution for everything else
    return executeAgentTool(name, args, toolContext);
  };

  return runAgentLoop({
    ...loopOptions,
    tools: EXPLORATION_AGENT_TOOLS,
    toolExecutor,
  });
}
