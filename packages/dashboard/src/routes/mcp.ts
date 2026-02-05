import { Router, type Request, type Response } from 'express';
import type { DashboardContext } from '../types/context.js';
import { createTokenChecker } from '../helpers/auth.js';
import {
  discoverPacks,
  createMCPServerOverHTTP,
  type MCPRunStartInfo,
  type MCPRunCompleteInfo,
} from '@showrun/mcp-server';
import type { RunInfo } from '../runManager.js';

const MCP_DEFAULT_PORT = 3340;

export function createMcpRouter(ctx: DashboardContext): Router {
  const router = Router();
  const requireToken = createTokenChecker(ctx.sessionToken);

  // REST API: MCP server over HTTP/SSE
  router.get('/api/mcp/status', (_req: Request, res: Response) => {
    res.json({
      running: ctx.mcpServer.handle != null,
      url: ctx.mcpServer.handle?.url,
      port: ctx.mcpServer.handle?.port,
      packIds: ctx.mcpServer.packIds,
    });
  });

  router.post('/api/mcp/start', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (ctx.mcpServer.handle != null) {
      return res.status(409).json({
        error: 'MCP server already running',
        url: ctx.mcpServer.handle.url,
        port: ctx.mcpServer.handle.port,
      });
    }
    const { packIds, port: requestedPort } = req.body as { packIds?: string[]; port?: number };
    if (!Array.isArray(packIds) || packIds.length === 0) {
      return res.status(400).json({ error: 'packIds must be a non-empty array' });
    }
    // Re-discover packs to include any newly created packs
    const currentPacks = await discoverPacks({ directories: ctx.packDirs });
    const selectedPacks = currentPacks.filter((d) => packIds.includes(d.pack.metadata.id));
    if (selectedPacks.length === 0) {
      return res.status(400).json({ error: 'No valid pack IDs found' });
    }
    const port = typeof requestedPort === 'number' && requestedPort > 0 ? requestedPort : MCP_DEFAULT_PORT;
    try {
      const handle = await createMCPServerOverHTTP({
        packs: selectedPacks,
        baseRunDir: ctx.baseRunDir,
        concurrency: 1,
        headful: ctx.headful,
        port,
        host: '127.0.0.1',
        // Track MCP runs in the dashboard database
        onRunStart: (info: MCPRunStartInfo) => {
          const run = ctx.runManager.addRunAndGet(info.packId, info.packName, 'mcp');
          // Store the mapping from MCP runId to DB runId for later lookup
          ctx.mcpServer.runIdMap.set(info.runId, run.runId);
          ctx.runManager.updateRun(run.runId, {
            status: 'running',
            startedAt: Date.now(),
            runDir: info.runDir,
          });
          ctx.io.emit('runs:list', ctx.runManager.getAllRuns());
          console.log(`[MCP] Run started: ${info.runId} -> ${run.runId} (pack: ${info.packId})`);
        },
        onRunComplete: (info: MCPRunCompleteInfo) => {
          const dbRunId = ctx.mcpServer.runIdMap.get(info.runId);
          if (dbRunId) {
            const updates: Partial<RunInfo> = {
              status: info.success ? 'success' : 'failed',
              finishedAt: Date.now(),
            };
            if (info.error) {
              updates.error = info.error;
            }
            if (info.collectibles) {
              updates.collectibles = info.collectibles;
            }
            if (info.durationMs !== undefined) {
              updates.durationMs = info.durationMs;
            }
            ctx.runManager.updateRun(dbRunId, updates);
            ctx.mcpServer.runIdMap.delete(info.runId);
            ctx.io.emit('runs:list', ctx.runManager.getAllRuns());
            console.log(`[MCP] Run completed: ${info.runId} (success: ${info.success})`);
          }
        },
      });
      ctx.mcpServer.handle = handle;
      ctx.mcpServer.packIds = packIds;
      console.log(`[Dashboard] MCP server started at ${handle.url} with ${selectedPacks.length} pack(s)`);
      res.json({
        url: handle.url,
        port: handle.port,
        packIds,
        message: `MCP server running. Connect via Streamable HTTP (POST/GET) at ${handle.url}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Dashboard] MCP server start failed:', message);
      res.status(500).json({ error: 'Failed to start MCP server', details: message });
    }
  });

  router.post('/api/mcp/stop', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (ctx.mcpServer.handle == null) {
      return res.status(404).json({ error: 'MCP server is not running' });
    }
    try {
      await ctx.mcpServer.handle.close();
      const url = ctx.mcpServer.handle.url;
      const packIds = [...ctx.mcpServer.packIds];
      ctx.mcpServer.handle = null;
      ctx.mcpServer.packIds = [];
      console.log('[Dashboard] MCP server stopped');
      res.json({ stopped: true, url, packIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to stop MCP server', details: message });
    }
  });

  return router;
}
