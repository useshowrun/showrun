/**
 * Shared types for the two-agent architecture (Exploration + Editor)
 */

import type { ToolDef, ToolCall, StreamEvent, ChatWithToolsResult, LlmProvider } from '../llm/provider.js';
import type { AgentMessage } from '../contextManager.js';
import type { ExecuteToolResult, AgentToolContext } from '../agentTools.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Agent Loop Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentLoopOptions {
  /** System prompt for the agent */
  systemPrompt: string;
  /** Tool definitions available to this agent */
  tools: ToolDef[];
  /** Initial conversation messages */
  initialMessages: AgentMessage[];
  /** LLM provider for API calls */
  llmProvider: LlmProvider;
  /** Function to execute a tool call and return result */
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<ExecuteToolResult>;
  /** Maximum iterations before stopping */
  maxIterations: number;
  /** Callback for streaming events (optional) */
  onStreamEvent?: (event: StreamEvent | Record<string, unknown>) => void;
  /** Callback after each tool execution (optional) */
  onToolResult?: (toolName: string, args: Record<string, unknown>, result: unknown, success: boolean) => void;
  /** Callback when a tool call fails — for centralized error logging */
  onToolError?: (toolName: string, args: Record<string, unknown>, error: string, iteration: number) => void;
  /** AbortSignal to cancel the loop */
  abortSignal?: { aborted: boolean };
  /** Session key for plan storage / summarization */
  sessionKey?: string;
  /** Enable streaming from LLM provider */
  enableStreaming?: boolean;
}

export interface AgentLoopResult {
  /** Final text content from the agent */
  finalContent: string;
  /** Trace of all tool calls made */
  toolTrace: Array<{ tool: string; args: Record<string, unknown>; result: unknown; success: boolean }>;
  /** Number of iterations used */
  iterationsUsed: number;
  /** Whether the loop was aborted */
  aborted: boolean;
  /** The final set of messages (for reuse) */
  messages: AgentMessage[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Editor Agent Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface EditorAgentOptions {
  /** Implementation instructions (approved roadmap + what to build) */
  instruction: string;
  /** All exploration findings: API endpoints, DOM structure, auth info, pagination */
  explorationContext: string;
  /** Input values for testing with editor_run_pack */
  testInputs?: Record<string, unknown>;
  /** LLM provider */
  llmProvider: LlmProvider;
  /** Tool executor scoped to editor tools */
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<ExecuteToolResult>;
  /** Callback for streaming events (optional, tagged with agent: 'editor') */
  onStreamEvent?: (event: StreamEvent | Record<string, unknown>) => void;
  /** Callback when flow is updated (for UI real-time updates) */
  onFlowUpdated?: (flow: unknown, validation?: unknown) => void;
  /** Callback when an editor tool call fails — for centralized error logging */
  onToolError?: (toolName: string, args: Record<string, unknown>, error: string, iteration: number) => void;
  /** AbortSignal */
  abortSignal?: { aborted: boolean };
  /** Session key for plan storage */
  sessionKey?: string;
}

export interface EditorAgentResult {
  /** Whether the editor agent succeeded */
  success: boolean;
  /** Human-readable summary of what was done */
  summary: string;
  /** Number of DSL steps created/modified */
  stepsCreated: number;
  /** Number of collectibles defined */
  collectiblesCount: number;
  /** Test result if editor_run_pack was called */
  testResult?: {
    success: boolean;
    collectiblesPreview: string;
    error?: string;
  };
  /** Error message if failed */
  error?: string;
  /** How many loop iterations were used */
  iterationsUsed: number;
}
