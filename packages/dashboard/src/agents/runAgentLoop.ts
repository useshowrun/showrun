/**
 * Reusable agent loop: LLM call -> tool dispatch -> message building -> repeat
 *
 * Extracted from teach.ts to be shared by both Exploration and Editor agents.
 */

import type { StreamEvent, ChatWithToolsResult, ToolCall } from '../llm/provider.js';
import type { AgentMessage } from '../contextManager.js';
import { summarizeIfNeeded, estimateTotalTokens } from '../contextManager.js';
import type { AgentLoopOptions, AgentLoopResult } from './types.js';

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
type AgentMsg =
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

/**
 * Run a generic agent loop: call LLM, dispatch tools, repeat until final text or max iterations.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    tools,
    initialMessages,
    llmProvider,
    toolExecutor,
    maxIterations,
    onStreamEvent,
    onToolResult,
    onToolError,
    abortSignal,
    sessionKey,
    enableStreaming = false,
  } = options;

  let agentMessages: AgentMsg[] = initialMessages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool' as const, content: m.content as string, tool_call_id: (m as any).tool_call_id };
    }
    if (m.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: (m.content as string) ?? null,
        ...(('tool_calls' in m && m.tool_calls) ? { tool_calls: m.tool_calls as ToolCall[] } : {}),
      };
    }
    return { role: 'user' as const, content: m.content as string | ContentPart[] };
  });

  const toolTrace: Array<{ tool: string; args: Record<string, unknown>; result: unknown; success: boolean }> = [];
  let finalContent = '';

  const emit = (event: StreamEvent | Record<string, unknown>) => {
    onStreamEvent?.(event);
  };

  const supportsStreaming = typeof (llmProvider as any).chatWithToolsStream === 'function';

  async function callLlm(): Promise<ChatWithToolsResult> {
    if (supportsStreaming && enableStreaming) {
      const generator = (llmProvider as any).chatWithToolsStream({
        systemPrompt,
        messages: agentMessages,
        tools,
        enableThinking: true,
      }) as AsyncGenerator<StreamEvent, ChatWithToolsResult, unknown>;

      let iterResult = await generator.next();
      while (!iterResult.done) {
        emit(iterResult.value);
        iterResult = await generator.next();
      }
      return iterResult.value;
    } else {
      return await (llmProvider as any).chatWithTools({
        systemPrompt,
        messages: agentMessages,
        tools,
      });
    }
  }

  let iter = 0;
  for (; iter < maxIterations; iter++) {
    // Check abort
    if (abortSignal?.aborted) {
      return { finalContent, toolTrace, iterationsUsed: iter, aborted: true, messages: agentMessages as AgentMessage[] };
    }

    // Check token count and summarize if needed
    const tokenEstimate = estimateTotalTokens(systemPrompt, agentMessages);
    if (tokenEstimate > 100_000 && sessionKey) {
      console.log(`[AgentLoop] Token estimate ${tokenEstimate} exceeds threshold, summarizing...`);
      emit({ type: 'summarizing', tokensBefore: tokenEstimate });
      try {
        const summaryResult = await summarizeIfNeeded(
          systemPrompt,
          agentMessages,
          llmProvider,
          sessionKey
        );
        if (summaryResult.wasSummarized) {
          agentMessages = summaryResult.messages;
          console.log(`[AgentLoop] Summarized: ${summaryResult.tokensBefore} -> ${summaryResult.tokensAfter} tokens`);
          emit({ type: 'summarized', tokensBefore: summaryResult.tokensBefore, tokensAfter: summaryResult.tokensAfter });
        }
      } catch (err) {
        console.error('[AgentLoop] Summarization failed:', err);
      }
    }

    const result = await callLlm();

    if (result.toolCalls && result.toolCalls.length > 0) {
      // Add assistant message with tool calls
      agentMessages.push({
        role: 'assistant',
        content: result.content ?? null,
        tool_calls: result.toolCalls,
      });

      // Execute each tool call
      let browserSnapshot: { screenshotBase64: string; mimeType: string; url: string } | undefined;

      for (const tc of result.toolCalls) {
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(tc.arguments || '{}');
        } catch {
          // ignore
        }

        emit({ type: 'tool_start', tool: tc.name, args: toolArgs });

        const execResult = await toolExecutor(tc.name, toolArgs);
        let resultStr = execResult.stringForLlm;
        let resultParsed: unknown;
        try {
          resultParsed = JSON.parse(resultStr);
        } catch {
          resultParsed = resultStr;
        }

        const success = !(resultParsed && typeof resultParsed === 'object' && 'error' in resultParsed);
        toolTrace.push({ tool: tc.name, args: toolArgs, result: resultParsed, success });

        emit({ type: 'tool_result', tool: tc.name, args: toolArgs, result: resultParsed, success });
        onToolResult?.(tc.name, toolArgs, resultParsed, success);

        if (!success && onToolError) {
          const errorStr = resultParsed && typeof resultParsed === 'object' && 'error' in resultParsed
            ? String((resultParsed as any).error).slice(0, 2000)
            : String(resultStr).slice(0, 2000);
          onToolError(tc.name, toolArgs, errorStr, iter);
        }

        // Check abort after each tool
        if (abortSignal?.aborted) {
          return { finalContent, toolTrace, iterationsUsed: iter + 1, aborted: true, messages: agentMessages as AgentMessage[] };
        }

        // Track browser snapshot for screenshot injection
        if (execResult.browserSnapshot) {
          browserSnapshot = execResult.browserSnapshot;
        }

        agentMessages.push({ role: 'tool', content: resultStr, tool_call_id: tc.id });
      }

      // Inject screenshot if one was captured
      if (browserSnapshot) {
        const dataUrl = `data:${browserSnapshot.mimeType};base64,${browserSnapshot.screenshotBase64}`;
        agentMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Screenshot attached for analysis. Analyze the page and answer the user.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        });
      }

      continue; // Next iteration
    }

    // No tool calls — final text response
    finalContent = result.content ?? '';
    break;
  }

  return {
    finalContent,
    toolTrace,
    iterationsUsed: iter,
    aborted: false,
    messages: agentMessages as AgentMessage[],
  };
}
