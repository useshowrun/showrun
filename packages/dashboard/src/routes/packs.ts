import { Router, type Request, type Response } from 'express';
import { resolve } from 'path';
import { existsSync, rmSync } from 'fs';
import type { DashboardContext } from '../types/context.js';
import { createTokenChecker } from '../helpers/auth.js';
import { discoverPacks } from '@showrun/mcp-server';
import {
  TaskPackLoader,
  validateJsonTaskPack,
  sanitizePackId,
  ensureDir,
  writeTaskPackManifest,
  writeFlowJson,
  validatePathInAllowedDir,
  readJsonFile,
} from '@showrun/core';
import type { TaskPackManifest, InputSchema, CollectibleDefinition, DslStep } from '@showrun/core';

export function createPacksRouter(ctx: DashboardContext): Router {
  const router = Router();
  const requireToken = createTokenChecker(ctx.sessionToken);

  // Helper: Find pack by ID
  function findPackById(packId: string) {
    return ctx.packMap.get(packId) || null;
  }

  // REST API: Create new JSON pack
  router.post('/api/packs', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!ctx.workspaceDir) {
      return res.status(403).json({ error: 'No workspace directory configured' });
    }

    const { id, name, version, description } = req.body;

    if (!id || !name || !version) {
      return res.status(400).json({ error: 'id, name, and version are required' });
    }

    // Validate pack ID format
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
      return res.status(400).json({
        error: 'Pack ID must contain only alphanumeric characters, dots, underscores, and hyphens',
      });
    }

    // Check if pack already exists
    if (ctx.packMap.has(id)) {
      return res.status(409).json({ error: `Pack with ID "${id}" already exists` });
    }

    // Sanitize and create directory
    const sanitizedId = sanitizePackId(id);
    const packDir = resolve(ctx.workspaceDir, sanitizedId);

    if (existsSync(packDir)) {
      return res.status(409).json({ error: `Pack directory already exists: ${sanitizedId}` });
    }

    try {
      ensureDir(packDir);

      // Create taskpack.json
      const manifest: TaskPackManifest = {
        id,
        name,
        version,
        description: description || '',
        kind: 'json-dsl',
      };

      writeTaskPackManifest(packDir, manifest);

      // Create flow.json skeleton (skip validation for empty flow)
      const flowData = {
        inputs: {} as InputSchema,
        collectibles: [] as CollectibleDefinition[],
        flow: [] as DslStep[],
      };

      writeFlowJson(packDir, flowData, true); // Skip validation for empty flow

      // Reload packs to include the new one
      discoverPacks({ directories: ctx.packDirs }).then((newPacks) => {
        for (const { pack, path } of newPacks) {
          if (!ctx.packMap.has(pack.metadata.id)) {
            ctx.packMap.set(pack.metadata.id, { pack, path });
          }
        }
        ctx.io.emit('packs:updated', ctx.packMap.size);
      });

      res.json({
        id,
        name,
        version,
        description: manifest.description,
        kind: 'json-dsl',
        path: packDir,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Get pack files (taskpack.json and flow.json)
  router.get('/api/packs/:packId/files', async (req: Request, res: Response) => {
    const { packId } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Only allow JSON-DSL packs - check manifest kind
    try {
      const manifest = TaskPackLoader.loadManifest(packInfo.path);
      if (manifest.kind !== 'json-dsl') {
        return res.status(400).json({ error: 'Pack is not a JSON-DSL pack' });
      }
    } catch (error) {
      // If we can't load manifest, assume it's not json-dsl
      return res.status(400).json({
        error: 'Pack is not a JSON-DSL pack or manifest is invalid',
        details: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const taskpackPath = resolve(packInfo.path, 'taskpack.json');
      const flowPath = resolve(packInfo.path, 'flow.json');

      const taskpackJson = readJsonFile<TaskPackManifest>(taskpackPath);
      const flowJson = readJsonFile<{
        inputs?: InputSchema;
        collectibles?: CollectibleDefinition[];
        flow: DslStep[];
      }>(flowPath);

      res.json({
        taskpackJson,
        flowJson,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Delete pack (only JSON-DSL packs in workspace)
  router.delete('/api/packs/:packId', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Only allow deleting JSON-DSL packs
    try {
      const manifest = TaskPackLoader.loadManifest(packInfo.path);
      if (manifest.kind !== 'json-dsl') {
        return res.status(400).json({ error: 'Only JSON-DSL packs can be deleted' });
      }
    } catch (error) {
      return res.status(400).json({
        error: 'Pack is not a JSON-DSL pack or manifest is invalid',
        details: error instanceof Error ? error.message : String(error),
      });
    }

    // Validate path is in workspace (security check)
    if (ctx.workspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, ctx.workspaceDir);
      } catch {
        return res.status(403).json({ error: 'Pack is not in workspace directory - cannot delete' });
      }
    } else {
      return res.status(403).json({ error: 'No workspace directory configured - cannot delete packs' });
    }

    try {
      // Remove the pack directory
      rmSync(packInfo.path, { recursive: true, force: true });

      // Remove from packMap
      ctx.packMap.delete(packId);

      // Emit update
      ctx.io.emit('packs:updated', ctx.packMap.size);

      console.log(`[Dashboard] Pack deleted: ${packId} (${packInfo.path})`);
      res.json({ success: true, packId, message: `Pack "${packId}" has been deleted` });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Update pack metadata
  router.put('/api/packs/:packId/meta', async (req: Request, res: Response) => {
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

    const { name, version, description } = req.body;

    try {
      // Load existing manifest
      const manifest = TaskPackLoader.loadManifest(packInfo.path);
      if (manifest.kind !== 'json-dsl') {
        return res.status(400).json({ error: 'Pack is not a JSON-DSL pack' });
      }

      // Update metadata (id is immutable)
      const updated: TaskPackManifest = {
        ...manifest,
        name: name !== undefined ? name : manifest.name,
        version: version !== undefined ? version : manifest.version,
        description: description !== undefined ? description : manifest.description,
      };

      if (!updated.name || !updated.version) {
        return res.status(400).json({ error: 'name and version are required' });
      }

      writeTaskPackManifest(packInfo.path, updated);

      // Reload pack
      const reloaded = await TaskPackLoader.loadTaskPack(packInfo.path);
      ctx.packMap.set(packId, { pack: reloaded, path: packInfo.path });

      res.json({
        id: updated.id,
        name: updated.name,
        version: updated.version,
        description: updated.description,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Update pack flow
  router.put('/api/packs/:packId/flow', async (req: Request, res: Response) => {
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

    const { flowJsonText } = req.body;

    if (!flowJsonText || typeof flowJsonText !== 'string') {
      return res.status(400).json({ error: 'flowJsonText (string) is required' });
    }

    // Enforce size limit (1MB)
    if (flowJsonText.length > 1024 * 1024) {
      return res.status(400).json({ error: 'flowJsonText exceeds 1MB limit' });
    }

    try {
      // Parse JSON
      const flowData = JSON.parse(flowJsonText) as {
        inputs?: InputSchema;
        collectibles?: CollectibleDefinition[];
        flow: DslStep[];
      };

      if (!flowData.flow || !Array.isArray(flowData.flow)) {
        return res.status(400).json({ error: 'flow must be an array' });
      }

      // Validate before writing
      const manifest = TaskPackLoader.loadManifest(packInfo.path);
      const tempPack = {
        metadata: manifest,
        inputs: flowData.inputs || {},
        collectibles: flowData.collectibles || [],
        flow: flowData.flow,
      };

      const warnings: string[] = [];
      try {
        validateJsonTaskPack(tempPack);
      } catch (error) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error instanceof Error ? error.message : String(error),
        });
      }

      // Write flow.json
      writeFlowJson(packInfo.path, flowData);

      // Reload pack
      const reloaded = await TaskPackLoader.loadTaskPack(packInfo.path);
      ctx.packMap.set(packId, { pack: reloaded, path: packInfo.path });

      res.json({
        success: true,
        warnings,
      });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return res.status(400).json({
          error: 'Invalid JSON',
          details: error.message,
        });
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Validate pack without saving
  router.post('/api/packs/:packId/validate', (req: Request, res: Response) => {
    const { packId } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    const { flowJsonText, metaOverride } = req.body;

    try {
      const manifest = TaskPackLoader.loadManifest(packInfo.path);
      const finalMeta = metaOverride ? { ...manifest, ...metaOverride } : manifest;

      let flowData: {
        inputs?: InputSchema;
        collectibles?: CollectibleDefinition[];
        flow: DslStep[];
      };

      if (flowJsonText) {
        if (typeof flowJsonText !== 'string') {
          return res.status(400).json({ error: 'flowJsonText must be a string' });
        }
        flowData = JSON.parse(flowJsonText);
      } else {
        const flowPath = resolve(packInfo.path, 'flow.json');
        flowData = readJsonFile(flowPath);
      }

      const tempPack = {
        metadata: finalMeta,
        inputs: flowData.inputs || {},
        collectibles: flowData.collectibles || [],
        flow: flowData.flow || [],
      };

      const errors: string[] = [];
      const warnings: string[] = [];

      try {
        validateJsonTaskPack(tempPack);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      res.json({
        ok: errors.length === 0,
        errors,
        warnings,
      });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return res.json({
          ok: false,
          errors: [`Invalid JSON: ${error.message}`],
          warnings: [],
        });
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
