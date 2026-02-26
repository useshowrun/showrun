/**
 * Dashboard API proxy for registry operations.
 *
 * Proxies registry requests through the dashboard backend so the frontend
 * doesn't need to know the registry URL or handle auth tokens directly.
 */

import { Router, type Request, type Response } from 'express';
import { RegistryClient, RegistryError } from '@showrun/core';
import type { DashboardContext } from '../types/context.js';

function getClient(): RegistryClient | null {
  try {
    return new RegistryClient();
  } catch {
    return null;
  }
}

function handleRegistryError(res: Response, err: unknown): void {
  if (err instanceof RegistryError) {
    res.status(err.status || 500).json({ error: err.message });
  } else {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function createRegistryRouter(ctx: DashboardContext): Router {
  const router = Router();

  // Check registry status
  router.get('/api/registry/status', (_req: Request, res: Response) => {
    const client = getClient();
    if (!client) {
      res.json({ configured: false, authenticated: false });
      return;
    }
    res.json({
      configured: true,
      authenticated: client.isAuthenticated(),
    });
  });

  // Start device login (OAuth Device Flow)
  router.post('/api/registry/device-login', async (_req: Request, res: Response) => {
    const client = getClient();
    if (!client) {
      res.status(400).json({ error: 'Registry not configured. Set SHOWRUN_REGISTRY_URL.' });
      return;
    }

    try {
      const device = await client.startDeviceLogin();
      res.json(device);
    } catch (err) {
      handleRegistryError(res, err);
    }
  });

  // Poll device login
  router.post('/api/registry/device-poll', async (req: Request, res: Response) => {
    const client = getClient();
    if (!client) {
      res.status(400).json({ error: 'Registry not configured' });
      return;
    }

    const { deviceCode } = req.body;
    if (!deviceCode) {
      res.status(400).json({ error: 'deviceCode is required' });
      return;
    }

    try {
      const result = await client.pollDeviceLogin(deviceCode);
      res.json(result);
    } catch (err) {
      handleRegistryError(res, err);
    }
  });

  // Logout
  router.post('/api/registry/logout', async (_req: Request, res: Response) => {
    const client = getClient();
    if (!client) {
      res.status(400).json({ error: 'Registry not configured' });
      return;
    }

    try {
      await client.logout();
      res.json({ ok: true });
    } catch (err) {
      handleRegistryError(res, err);
    }
  });

  // Whoami
  router.get('/api/registry/whoami', async (_req: Request, res: Response) => {
    const client = getClient();
    if (!client) {
      res.status(400).json({ error: 'Registry not configured' });
      return;
    }

    try {
      const user = await client.whoami();
      res.json(user);
    } catch (err) {
      handleRegistryError(res, err);
    }
  });

  // Publish a pack
  router.post('/api/registry/publish/:packId', async (req: Request, res: Response) => {
    const client = getClient();
    if (!client) {
      res.status(400).json({ error: 'Registry not configured' });
      return;
    }

    if (!client.isAuthenticated()) {
      res.status(401).json({ error: 'Not authenticated. Please log in first.' });
      return;
    }

    const { packId } = req.params;
    const entry = ctx.packMap.get(packId);
    if (!entry) {
      res.status(404).json({ error: `Pack not found: ${packId}` });
      return;
    }

    const { slug, visibility, changelog } = req.body;

    try {
      const result = await client.publishPack({
        packPath: entry.path,
        slug,
        visibility,
        changelog,
      });
      res.json(result);
    } catch (err) {
      handleRegistryError(res, err);
    }
  });

  // Search packs
  router.get('/api/registry/search', async (req: Request, res: Response) => {
    const client = getClient();
    if (!client) {
      res.status(400).json({ error: 'Registry not configured' });
      return;
    }

    const { q, page, limit } = req.query;

    try {
      const result = await client.searchPacks({
        q: q as string,
        page: page ? parseInt(page as string, 10) : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
      });
      res.json(result);
    } catch (err) {
      handleRegistryError(res, err);
    }
  });

  return router;
}
