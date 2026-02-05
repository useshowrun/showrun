import { Router, type Request, type Response } from 'express';
import type { DashboardContext } from '../types/context.js';
import { createTokenChecker } from '../helpers/auth.js';
import { validatePathInAllowedDir } from '@showrun/core';
import {
  getSecretNamesWithValues,
  setSecretValue,
  deleteSecretValue,
  updateSecretDefinitions,
} from '../secretsUtils.js';

export function createSecretsRouter(ctx: DashboardContext): Router {
  const router = Router();
  const requireToken = createTokenChecker(ctx.sessionToken);

  // Helper: Find pack by ID
  function findPackById(packId: string) {
    return ctx.packMap.get(packId) || null;
  }

  // REST API: Get secrets for a pack (names only, no values)
  router.get('/api/packs/:packId/secrets', (req: Request, res: Response) => {
    const { packId } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    try {
      const secrets = getSecretNamesWithValues(packInfo.path);
      res.json({ secrets });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Set a secret value
  router.put('/api/packs/:packId/secrets/:secretName', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId, secretName } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Validate path is in workspace
    if (ctx.workspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, ctx.workspaceDir);
      } catch {
        return res.status(403).json({ error: 'Pack is not in workspace directory' });
      }
    }

    const { value } = req.body;

    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value (string) is required' });
    }

    try {
      setSecretValue(packInfo.path, secretName, value);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Delete a secret value
  router.delete('/api/packs/:packId/secrets/:secretName', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId, secretName } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Validate path is in workspace
    if (ctx.workspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, ctx.workspaceDir);
      } catch {
        return res.status(403).json({ error: 'Pack is not in workspace directory' });
      }
    }

    try {
      deleteSecretValue(packInfo.path, secretName);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Update secret definitions in manifest
  router.put('/api/packs/:packId/secrets-schema', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Validate path is in workspace
    if (ctx.workspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, ctx.workspaceDir);
      } catch {
        return res.status(403).json({ error: 'Pack is not in workspace directory' });
      }
    }

    const { secrets } = req.body;

    if (!Array.isArray(secrets)) {
      return res.status(400).json({ error: 'secrets must be an array' });
    }

    // Validate each secret definition
    for (const secret of secrets) {
      if (typeof secret.name !== 'string' || !secret.name) {
        return res.status(400).json({ error: 'Each secret must have a name (string)' });
      }
    }

    try {
      updateSecretDefinitions(packInfo.path, secrets);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
