import { Router, type Request, type Response } from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

  // REST API: Get system info for MCP config generation
  router.get('/api/system-info', (_req: Request, res: Response) => {
    // Resolve the showrun CLI path relative to this package
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const cliPath = resolve(__dirname, '../../../showrun/dist/cli.js');

    res.json({
      nodePath: process.execPath,
      cliPath,
    });
  });

  return router;
}
