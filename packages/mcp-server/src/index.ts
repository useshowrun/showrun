/**
 * @showrun/mcp-server - Public API
 * MCP server for Task Pack framework
 */

// Pack discovery
export { discoverPacks, packIdToToolName } from './packDiscovery.js';
export type { DiscoveredPack, PackDiscoveryOptions } from './packDiscovery.js';

// Concurrency
export { ConcurrencyLimiter } from './concurrency.js';

// Stdio server
export { createMCPServer } from './server.js';
export type { MCPServerOptions } from './server.js';

// HTTP server
export { createMCPServerOverHTTP } from './httpServer.js';
export type {
  MCPServerHTTPOptions,
  MCPServerHTTPHandle,
  MCPRunStartInfo,
  MCPRunCompleteInfo,
} from './httpServer.js';
