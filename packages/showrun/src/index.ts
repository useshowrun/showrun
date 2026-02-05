/**
 * @showrun/showrun - Public API
 * Re-export utilities from @showrun/core for backwards compatibility
 */

export {
  sanitizePackId,
  ensureDir,
  atomicWrite,
  validatePathInAllowedDir,
  readJsonFile,
  writeTaskPackManifest,
  writeFlowJson,
} from '@showrun/core';

// Export command interfaces for programmatic use
export { runPack } from '@showrun/harness';
export type { RunPackOptions, RunPackResult } from '@showrun/harness';

export { startDashboard } from '@showrun/dashboard';
export type { DashboardOptions } from '@showrun/dashboard';

export { createBrowserInspectorServer } from '@showrun/browser-inspector-mcp';
export type { BrowserInspectorOptions } from '@showrun/browser-inspector-mcp';

export { createTaskPackEditorServer } from '@showrun/taskpack-editor-mcp';
export type { TaskPackEditorOptions } from '@showrun/taskpack-editor-mcp';

export {
  discoverPacks,
  createMCPServer,
  createMCPServerOverHTTP,
} from '@showrun/mcp-server';
export type { DiscoveredPack, MCPServerOptions } from '@showrun/mcp-server';
