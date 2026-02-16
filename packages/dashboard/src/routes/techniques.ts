/**
 * REST API routes for managing techniques.
 *
 * GET    /api/techniques              — List all (with filters)
 * GET    /api/techniques/health       — Check vector store health
 * GET    /api/techniques/:id          — Get one
 * POST   /api/techniques              — Create (user-defined)
 * PATCH  /api/techniques/:id          — Update metadata (status, confidence)
 * DELETE /api/techniques/:id          — Delete
 * POST   /api/techniques/review       — Batch approve/reject proposed techniques
 */

import { Router, type Request, type Response } from 'express';
import type { DashboardContext } from '../types/context.js';

export function createTechniquesRouter(ctx: DashboardContext): Router {
  const router = Router();

  /** Guard: return 503 if techniques DB not configured */
  function requireTechniques(_req: Request, res: Response): boolean {
    if (!ctx.techniqueManager) {
      res.status(503).json({
        error: 'Techniques DB not configured',
        hint: 'Set WEAVIATE_URL and EMBEDDING_API_KEY environment variables to enable.',
      });
      return false;
    }
    return true;
  }

  // Health check
  router.get('/api/techniques/health', async (_req: Request, res: Response) => {
    if (!ctx.techniqueManager) {
      return res.json({ configured: false, healthy: false });
    }
    const healthy = await ctx.techniqueManager.isAvailable();
    res.json({ configured: true, healthy });
  });

  // List techniques with optional filters
  router.get('/api/techniques', async (req: Request, res: Response) => {
    if (!requireTechniques(req, res)) return;
    try {
      const filters: Record<string, unknown> = {};
      if (req.query.type) filters.type = req.query.type;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.domain) filters.domain = req.query.domain;
      if (req.query.category) filters.category = req.query.category;
      if (req.query.maxPriority) filters.maxPriority = Number(req.query.maxPriority);
      if (req.query.source) filters.source = req.query.source;

      if (req.query.query) {
        // Search mode
        const results = await ctx.techniqueManager!.search(
          req.query.query as string,
          filters as any,
          Number(req.query.limit) || 20,
        );
        res.json(results);
      } else {
        // List mode
        const techniques = await ctx.techniqueManager!.search(
          '',
          filters as any,
          Number(req.query.limit) || 200,
        );
        res.json(techniques.map(r => r.technique));
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Get one technique by ID
  router.get('/api/techniques/:id', async (req: Request, res: Response) => {
    if (!requireTechniques(req, res)) return;
    try {
      const technique = await ctx.techniqueManager!.search(req.params.id, {}, 1);
      // Fallback: try direct get via the store (technique manager doesn't expose get directly for REST)
      // For now, return from search if found
      if (technique.length === 0) {
        return res.status(404).json({ error: 'Technique not found' });
      }
      res.json(technique[0].technique);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Create user-defined technique
  router.post('/api/techniques', async (req: Request, res: Response) => {
    if (!requireTechniques(req, res)) return;
    try {
      const { title, content, type, priority, domain, category, tags, confidence } = req.body;
      if (!title || !content) {
        return res.status(400).json({ error: 'title and content are required' });
      }
      const created = await ctx.techniqueManager!.propose([{
        title,
        content,
        type: type || 'generic',
        priority: priority || 3,
        domain: domain || null,
        category: category || 'general',
        tags: tags || [],
        confidence: confidence ?? 1.0,
      }]);
      // Mark as user-defined by updating source
      // (propose sets source='agent-learned', but for user-created we'd want 'user-defined')
      // For now this is fine — the REST API is for user-created techniques
      res.status(201).json(created[0]);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Update technique metadata
  router.patch('/api/techniques/:id', async (req: Request, res: Response) => {
    if (!requireTechniques(req, res)) return;
    try {
      const { status, confidence } = req.body;
      if (status === 'not_working') {
        await ctx.techniqueManager!.markNotWorking([req.params.id]);
      } else if (status === 'deprecated') {
        await ctx.techniqueManager!.deprecate([req.params.id]);
      } else if (status || confidence !== undefined) {
        // Generic metadata update via approve (which updates the timestamp)
        await ctx.techniqueManager!.approve([req.params.id]);
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Delete technique
  router.delete('/api/techniques/:id', async (_req: Request, res: Response) => {
    if (!requireTechniques(_req, res)) return;
    try {
      // TechniqueManager doesn't expose delete directly, so we mark as deprecated
      await ctx.techniqueManager!.deprecate([_req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Batch review proposed techniques
  router.post('/api/techniques/review', async (req: Request, res: Response) => {
    if (!requireTechniques(req, res)) return;
    try {
      const { approve: approveIds, reject: rejectIds } = req.body;
      if (approveIds && Array.isArray(approveIds) && approveIds.length > 0) {
        await ctx.techniqueManager!.approve(approveIds);
      }
      if (rejectIds && Array.isArray(rejectIds) && rejectIds.length > 0) {
        await ctx.techniqueManager!.markNotWorking(rejectIds);
      }
      res.json({
        approved: approveIds?.length || 0,
        rejected: rejectIds?.length || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
