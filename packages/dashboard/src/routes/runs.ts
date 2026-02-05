import { Router, type Request, type Response } from 'express';
import { resolve } from 'path';
import type { DashboardContext } from '../types/context.js';
import { createTokenChecker } from '../helpers/auth.js';
import { runTaskPack } from '@showrun/core';
import { SocketLogger } from '../logger.js';

export function createRunsRouter(ctx: DashboardContext): Router {
  const router = Router();
  const requireToken = createTokenChecker(ctx.sessionToken);

  // REST API: Create run (requires token)
  router.post('/api/runs', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId, inputs, conversationId, source } = req.body;

    if (!packId || typeof packId !== 'string') {
      return res.status(400).json({ error: 'packId is required' });
    }

    if (!inputs || typeof inputs !== 'object') {
      return res.status(400).json({ error: 'inputs must be an object' });
    }

    // Verify pack exists
    const packInfo = ctx.packMap.get(packId);
    if (!packInfo) {
      return res.status(404).json({ error: `Task pack not found: ${packId}` });
    }

    // Create run using database-backed manager
    const runInfo = ctx.runManager.addRunAndGet(
      packId,
      packInfo.pack.metadata.name,
      source || 'dashboard',
      conversationId
    );
    const runId = runInfo.runId;

    // Emit run list update
    ctx.io.emit('runs:list', ctx.runManager.getAllRuns());

    // Queue execution
    ctx.concurrencyLimiter.execute(async () => {
      ctx.runManager.updateRun(runId, {
        status: 'running',
        startedAt: Date.now(),
      });
      ctx.io.emit('runs:list', ctx.runManager.getAllRuns());

      // Create run directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const runDir = resolve(ctx.baseRunDir, `${packId}-${timestamp}-${runId.slice(0, 8)}`);

      // Create socket logger that emits events
      const logger = new SocketLogger(runDir, ctx.io, runId);

      try {
        const result = await runTaskPack(packInfo.pack, inputs, {
          runDir,
          logger,
          headless: !ctx.headful,
          profileId: packId,
        });

        ctx.runManager.updateRun(runId, {
          status: 'success',
          finishedAt: Date.now(),
          durationMs: result.meta.durationMs,
          runDir: result.runDir,
          eventsPath: result.eventsPath,
          artifactsDir: result.artifactsDir,
          collectibles: result.collectibles,
          meta: result.meta,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        ctx.runManager.updateRun(runId, {
          status: 'failed',
          finishedAt: Date.now(),
          error: errorMessage,
          runDir,
          eventsPath: resolve(runDir, 'events.jsonl'),
          artifactsDir: resolve(runDir, 'artifacts'),
        });
      } finally {
        ctx.io.emit('runs:list', ctx.runManager.getAllRuns());
      }
    }).catch((error) => {
      // Handle execution errors
      ctx.runManager.updateRun(runId, {
        status: 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      ctx.io.emit('runs:list', ctx.runManager.getAllRuns());
    });

    res.json({ runId });
  });

  // REST API: List runs (with optional filters)
  router.get('/api/runs', (req: Request, res: Response) => {
    const source = req.query.source as 'dashboard' | 'mcp' | 'cli' | 'agent' | undefined;
    const conversationId = req.query.conversationId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    res.json(ctx.runManager.getAllRuns({ source, conversationId, limit }));
  });

  // REST API: Get run details
  router.get('/api/runs/:runId', (req: Request, res: Response) => {
    const { runId } = req.params;
    const run = ctx.runManager.getRun(runId);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(run);
  });

  return router;
}
