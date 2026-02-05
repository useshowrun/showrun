import { Router, type Request, type Response } from 'express';
import type { DashboardContext } from '../types/context.js';
import { discoverPacks } from '@showrun/mcp-server';
import { TaskPackLoader } from '@showrun/core';

export function createConfigRouter(ctx: DashboardContext): Router {
  const router = Router();

  // REST API: Get config (includes session token)
  router.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      token: ctx.sessionToken,
      packsCount: ctx.packMap.size,
    });
  });

  // REST API: List packs
  router.get('/api/packs', async (_req: Request, res: Response) => {
    // Reload packs to get latest state
    const currentPacks = await discoverPacks({ directories: ctx.packDirs });

    // Update pack map
    ctx.packMap.clear();
    for (const { pack, path } of currentPacks) {
      ctx.packMap.set(pack.metadata.id, { pack, path });
    }

    const packsList = currentPacks.map(({ pack, path }) => {
      // Check if it's a JSON-DSL pack
      let kind: string | undefined;
      try {
        const manifest = TaskPackLoader.loadManifest(path);
        kind = manifest.kind;
      } catch {
        // Ignore errors
      }

      return {
        id: pack.metadata.id,
        name: pack.metadata.name,
        version: pack.metadata.version,
        description: pack.metadata.description || '',
        inputs: pack.inputs,
        collectibles: pack.collectibles,
        path,
        kind,
      };
    });
    res.json(packsList);
  });

  return router;
}
