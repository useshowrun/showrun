import type { Server as SocketIOServer } from 'socket.io';
import type { TaskPack } from '@showrun/core';
import type { MCPServerHTTPHandle, ConcurrencyLimiter } from '@showrun/mcp-server';
import type { RunManager } from '../runManager.js';
import type { TaskPackEditorWrapper } from '../mcpWrappers.js';
import type { LlmProvider } from '../llm/provider.js';

/** Entry in the pack lookup cache */
export interface PackMapEntry {
  pack: TaskPack;
  path: string;
}

/** Pending secrets request waiting for user input */
export interface PendingSecretsRequest {
  resolve: (secretNames: string[]) => void;
  reject: (error: Error) => void;
}

/** MCP server runtime state */
export interface MCPServerState {
  handle: MCPServerHTTPHandle | null;
  packIds: string[];
  runIdMap: Map<string, string>; // MCP runId -> DB runId
}

/** Shared dashboard context passed to all route modules */
export interface DashboardContext {
  // Authentication
  sessionToken: string;

  // Configuration
  packDirs: string[];
  workspaceDir: string | null;
  baseRunDir: string;
  headful: boolean;

  // Pack management
  packMap: Map<string, PackMapEntry>;

  // Run management
  runManager: RunManager;
  concurrencyLimiter: ConcurrencyLimiter;

  // MCP server
  mcpServer: MCPServerState;

  // Socket.IO for real-time updates
  io: SocketIOServer;

  // Teach mode
  taskPackEditor: TaskPackEditorWrapper;
  llmProvider: LlmProvider | null;
  systemPrompt: string;
  pendingSecretsRequests: Map<string, PendingSecretsRequest>;
}
