/**
 * MCP Server Wrappers
 * Direct function wrappers for MCP server functionality (for use in dashboard)
 * These can be called directly without MCP protocol overhead
 */

import type { DslStep, CollectibleDefinition, TaskPackManifest } from '@showrun/core';
import {
  TaskPackLoader,
  validateJsonTaskPack,
  runTaskPack,
  readJsonFile,
  writeFlowJson,
  validatePathInAllowedDir,
  ensureDir,
  writeTaskPackManifest,
  sanitizePackId,
  generateResultKey,
} from '@showrun/core';
import type { ResultStoreProvider, CollectibleSchemaField } from '@showrun/core';
import { discoverPacks } from '@showrun/mcp-server';
import { JSONLLogger } from '@showrun/harness';
import { randomBytes } from 'crypto';
import { resolve } from 'path';
import { existsSync } from 'fs';

/**
 * Flow patch operation
 */
export type FlowPatchOp =
  | { op: 'append'; step: DslStep }
  | { op: 'batch_append'; steps: DslStep[] }
  | { op: 'insert'; index: number; step: DslStep }
  | { op: 'replace'; index: number; step: DslStep }
  | { op: 'delete'; index: number }
  | { op: 'update_collectibles'; collectibles: CollectibleDefinition[] }
  | { op: 'update_inputs'; inputs: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }> };

/**
 * Result of running a task pack
 * Simplified for AI agent consumption - no paths or IDs that fill context
 */
export interface RunPackResult {
  success: boolean;
  collectibles: Record<string, unknown>;
  meta: { url?: string; durationMs: number; notes?: string };
  error?: string;
  /** Step ID that caused the failure (only on error) */
  failedStepId?: string;
  /**
   * Diagnostic hints from JSONPath operations (e.g., unsupported syntax, empty results).
   * These help AI agents understand why data extraction may have failed.
   */
  _hints?: string[];
  /** Key for retrieving stored result via showrun_query_results */
  _resultKey?: string;
}

/**
 * Maps step type to required/optional params hint for validation error messages.
 */
function getStepParamsHint(stepType: string): string {
  const hints: Record<string, string> = {
    extract_text: 'Required: target (object with kind) OR selector (string), out (string). Optional: first, trim, default.',
    extract_attribute: 'Required: target OR selector, attribute (string), out (string). Optional: first, default.',
    extract_title: 'Required: out (string).',
    network_find: 'Required: where ({urlIncludes?, method?, ...}), saveAs (string). Optional: pick, waitForMs. Note: "url" is NOT valid in where — use "urlIncludes".',
    network_replay: 'Required: requestId, auth ("browser_context"), out (string), response ({as: "json"|"text"}). Optional: overrides, saveAs, response.path.',
    network_extract: 'Required: fromVar (string), as ("json"|"text"), out (string). Optional: path (JMESPath).',
    wait_for: 'Required: at least ONE of target, selector, url, or loadState. Optional: visible, timeoutMs. Note: "waitForMs" is NOT valid.',
    set_var: 'Required: name (string), value (string|number|boolean). Arrays/objects not allowed.',
    click: 'Required: target (object with kind) OR selector. Optional: first.',
    fill: 'Required: target OR selector, value (string). Optional: first, clear.',
    navigate: 'Required: url (string). Optional: waitUntil.',
  };
  return hints[stepType] || '';
}

/**
 * TaskPack Editor wrapper functions
 */
export class TaskPackEditorWrapper {
  constructor(
    private packDirs: string[],
    private workspaceDir: string,
    private baseRunDir: string,
    private headful: boolean = false,
    private resultStores?: Map<string, ResultStoreProvider>,
  ) {}

  async listPacks() {
    const currentPacks = await discoverPacks({ directories: this.packDirs });
    return currentPacks.map(({ pack, path }) => {
      return {
        id: pack.metadata.id,
        name: pack.metadata.name,
        version: pack.metadata.version,
        description: pack.metadata.description || '',
        path, // Include path for secrets management
      };
    });
  }

  async createPack(id: string, name: string, description?: string): Promise<{
    id: string;
    name: string;
    version: string;
    description: string;
    path: string;
  }> {
    // Validate pack ID format
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error('Pack ID must contain only alphanumeric characters, underscores, and hyphens');
    }

    // Check if pack already exists
    const currentPacks = await discoverPacks({ directories: this.packDirs });
    const existingPack = currentPacks.find(({ pack }) => pack.metadata.id === id);
    if (existingPack) {
      throw new Error(`Pack with ID "${id}" already exists`);
    }

    // Create directory
    const sanitizedId = sanitizePackId(id);
    const packDir = resolve(this.workspaceDir, sanitizedId);

    if (existsSync(packDir)) {
      throw new Error(`Pack directory already exists: ${sanitizedId}`);
    }

    ensureDir(packDir);

    // Create taskpack.json
    const manifest: TaskPackManifest = {
      id,
      name,
      version: '0.1.0',
      description: description || '',
      kind: 'json-dsl',
    };

    writeTaskPackManifest(packDir, manifest);

    // Create empty flow.json
    const flowData = {
      inputs: {},
      collectibles: [],
      flow: [],
    };

    writeFlowJson(packDir, flowData, true); // Skip validation for empty flow

    return {
      id,
      name,
      version: '0.1.0',
      description: description || '',
      path: packDir,
    };
  }

  async readPack(packId: string) {
    const currentPacks = await discoverPacks({ directories: this.packDirs });
    const packInfo = currentPacks.find(({ pack }) => pack.metadata.id === packId);
    
    if (!packInfo) {
      throw new Error(`Pack not found: ${packId}`);
    }

    const resolvedWorkspaceDir = resolve(this.workspaceDir);
    try {
      validatePathInAllowedDir(packInfo.path, resolvedWorkspaceDir);
    } catch {
      throw new Error(`Pack ${packId} is not in workspace directory`);
    }

    const manifest = TaskPackLoader.loadManifest(packInfo.path);
    if (manifest.kind !== 'json-dsl') {
      throw new Error(`Pack ${packId} is not a JSON-DSL pack`);
    }

    const flowPath = resolve(packInfo.path, 'flow.json');
    const flowJson = readJsonFile<{
      inputs?: any;
      collectibles?: CollectibleDefinition[];
      flow: DslStep[];
    }>(flowPath);

    return {
      taskpackJson: manifest,
      flowJson,
    };
  }

  async validateFlow(flowJsonText: string) {
    try {
      const flowData = JSON.parse(flowJsonText) as {
        inputs?: any;
        collectibles?: CollectibleDefinition[];
        flow: DslStep[];
      };

      if (!flowData.flow || !Array.isArray(flowData.flow)) {
        return {
          ok: false,
          errors: ['flow must be an array'],
          warnings: [],
        };
      }

      const tempPack = {
        metadata: {
          id: 'temp',
          name: 'temp',
          version: '0.0.0',
        },
        inputs: flowData.inputs || {},
        collectibles: flowData.collectibles || [],
        flow: flowData.flow,
      };

      const errors: string[] = [];
      const warnings: string[] = [];

      try {
        validateJsonTaskPack(tempPack);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      return { ok: errors.length === 0, errors, warnings };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return {
          ok: false,
          errors: [`Invalid JSON: ${error.message}`],
          warnings: [],
        };
      }
      throw error;
    }
  }

  async applyFlowPatch(packId: string, patch: FlowPatchOp) {
    const currentPacks = await discoverPacks({ directories: this.packDirs });
    const packInfo = currentPacks.find(({ pack }) => pack.metadata.id === packId);
    
    if (!packInfo) {
      throw new Error(`Pack not found: ${packId}`);
    }

    const resolvedWorkspaceDir = resolve(this.workspaceDir);
    try {
      validatePathInAllowedDir(packInfo.path, resolvedWorkspaceDir);
    } catch {
      throw new Error(`Pack ${packId} is not in workspace directory`);
    }

    const manifest = TaskPackLoader.loadManifest(packInfo.path);
    if (manifest.kind !== 'json-dsl') {
      throw new Error(`Pack ${packId} is not a JSON-DSL pack`);
    }

    const flowPath = resolve(packInfo.path, 'flow.json');
    const flowData = readJsonFile<{
      inputs?: any;
      collectibles?: CollectibleDefinition[];
      flow: DslStep[];
    }>(flowPath);

    const newFlow = [...flowData.flow];
    const newCollectibles = [...(flowData.collectibles || [])];
    let newInputs = { ...(flowData.inputs || {}) };

    const p = patch as Record<string, unknown>;
    const proposal = p.proposal as Record<string, unknown> | undefined;
    const step = p.step ?? proposal?.step;
    const resolvedPatch = { ...patch, step } as FlowPatchOp;

    const stepError = (op: string, reason: string, hint: string) =>
      new Error(
        `Patch "${op}" failed: ${reason}. ${hint} Received: step=${step === undefined ? 'undefined' : step === null ? 'null' : typeof step}${typeof step === 'object' && step && !Array.isArray(step) ? ', keys=' + Object.keys(step as object).join(',') : ''}.`
      );

    switch (resolvedPatch.op) {
      case 'append':
        if (!resolvedPatch.step || typeof resolvedPatch.step !== 'object' || Array.isArray(resolvedPatch.step)) {
          throw stepError(
            'append',
            'step is missing or not an object',
            "Send patch.step (or patch.proposal.step) with id, type, and params. Example network_replay: { id: 'network_replay_1', type: 'network_replay', params: { requestId: '{{vars.req}}', auth: 'browser_context', out: 'data', response: { as: 'json' } } }."
          );
        }
        if (!('id' in resolvedPatch.step) || !('type' in resolvedPatch.step) || !('params' in resolvedPatch.step)) {
          throw stepError(
            'append',
            "step must have id, type, and params",
            "Example: { id: 'step_id', type: 'network_replay', params: { requestId, auth: 'browser_context', out, response: { as: 'json' } } }."
          );
        }
        newFlow.push(resolvedPatch.step as DslStep);
        break;
      case 'batch_append': {
        const batchSteps = (resolvedPatch as { op: 'batch_append'; steps: unknown }).steps;
        if (!Array.isArray(batchSteps) || batchSteps.length === 0) {
          throw new Error("batch_append requires steps (non-empty array of { id, type, params }).");
        }
        for (let i = 0; i < batchSteps.length; i++) {
          const s = batchSteps[i];
          if (!s || typeof s !== 'object' || Array.isArray(s)) {
            throw new Error(`batch_append: steps[${i}] is not an object. Each step must have id, type, and params.`);
          }
          if (!('id' in s) || !('type' in s) || !('params' in s)) {
            throw new Error(`batch_append: steps[${i}] must have id, type, and params.`);
          }
          newFlow.push(s as DslStep);
        }
        break;
      }
      case 'insert':
        if (resolvedPatch.index === undefined || !resolvedPatch.step || typeof resolvedPatch.step !== 'object' || Array.isArray(resolvedPatch.step)) {
          throw new Error(
            "insert requires index (number) and step (object with id, type, params). You sent: " +
            `index=${resolvedPatch.index === undefined ? 'undefined' : resolvedPatch.index}, step=${resolvedPatch.step === undefined ? 'undefined' : typeof resolvedPatch.step}.`
          );
        }
        if (resolvedPatch.index < 0 || resolvedPatch.index > newFlow.length) {
          throw new Error(`insert index must be 0..${newFlow.length}. Received: ${resolvedPatch.index}`);
        }
        newFlow.splice(resolvedPatch.index, 0, resolvedPatch.step as DslStep);
        break;
      case 'replace':
        if (resolvedPatch.index === undefined || !resolvedPatch.step || typeof resolvedPatch.step !== 'object' || Array.isArray(resolvedPatch.step)) {
          throw new Error("replace requires index and step (object with id, type, params).");
        }
        if (resolvedPatch.index < 0 || resolvedPatch.index >= newFlow.length) {
          throw new Error(`replace index must be 0..${newFlow.length - 1}. Received: ${resolvedPatch.index}`);
        }
        newFlow[resolvedPatch.index] = resolvedPatch.step as DslStep;
        break;
      case 'delete':
        if (resolvedPatch.index === undefined) {
          throw new Error("delete requires index (number). Example: { op: 'delete', index: 0 }");
        }
        if (resolvedPatch.index < 0 || resolvedPatch.index >= newFlow.length) {
          throw new Error(`delete index must be 0..${newFlow.length - 1}. Received: ${resolvedPatch.index}`);
        }
        newFlow.splice(resolvedPatch.index, 1);
        break;
      case 'update_collectibles':
        if (!resolvedPatch.collectibles || !Array.isArray(resolvedPatch.collectibles)) {
          throw new Error("update_collectibles requires collectibles (array of { name, type, description }).");
        }
        newCollectibles.length = 0;
        newCollectibles.push(...resolvedPatch.collectibles);
        break;
      case 'update_inputs':
        if (!resolvedPatch.inputs || typeof resolvedPatch.inputs !== 'object' || Array.isArray(resolvedPatch.inputs)) {
          throw new Error("update_inputs requires inputs (object of { fieldName: { type, description?, required?, default? } }).");
        }
        // Merge new inputs with existing (allows adding/updating individual fields)
        newInputs = { ...newInputs, ...resolvedPatch.inputs };
        break;
    }

    const tempPack = {
      metadata: manifest,
      inputs: newInputs,
      collectibles: newCollectibles,
      flow: newFlow,
    };

    try {
      validateJsonTaskPack(tempPack);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // For batch_append, try to identify the failing step from the error message
      let hint = '';
      if (resolvedPatch.op === 'batch_append' && Array.isArray((resolvedPatch as any).steps)) {
        const idxMatch = msg.match(/steps\[(\d+)\]/);
        if (idxMatch) {
          const failedStep = (resolvedPatch as any).steps[parseInt(idxMatch[1])];
          const stepType = failedStep?.type;
          hint = stepType ? getStepParamsHint(stepType) : '';
        }
      }
      if (!hint) {
        const stepType = (step as any)?.type;
        hint = stepType ? getStepParamsHint(stepType) : '';
      }
      throw new Error(
        `Step validation failed:\n${msg}${hint ? `\n\nHint: ${hint}` : ''}`
      );
    }

    writeFlowJson(packInfo.path, {
      inputs: newInputs,
      collectibles: newCollectibles,
      flow: newFlow,
    });

    return {
      success: true,
      flow: {
        stepsCount: newFlow.length,
        collectiblesCount: newCollectibles.length,
      },
    };
  }

  async runPack(packId: string, inputs: Record<string, unknown>): Promise<RunPackResult> {
    const currentPacks = await discoverPacks({ directories: this.packDirs });
    const packInfo = currentPacks.find(({ pack }) => pack.metadata.id === packId);

    if (!packInfo) {
      throw new Error(`Pack not found: ${packId}`);
    }

    const pack = await TaskPackLoader.loadTaskPack(packInfo.path);
    const runId = randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = resolve(this.baseRunDir, `${packId}-${timestamp}-${runId.slice(0, 8)}`);
    const ranAt = new Date().toISOString();

    const logger = new JSONLLogger(runDir);

    try {
      const result = await runTaskPack(pack, inputs, {
        runDir,
        logger,
        headless: !this.headful,
        profileId: packId,
        packPath: packInfo.path,
        skipHttpReplay: true,
      });

      // Auto-store result if a store exists for this pack
      const store = this.resultStores?.get(packId);
      const resultKey = store ? generateResultKey(packId, inputs) : undefined;
      if (store && resultKey) {
        const schema: CollectibleSchemaField[] = pack.collectibles.map((c) => ({
          name: c.name,
          type: c.type,
          description: c.description,
        }));
        try {
          await store.store({
            key: resultKey,
            packId,
            toolName: packInfo.toolName,
            inputs,
            collectibles: result.collectibles,
            meta: result.meta,
            collectibleSchema: schema,
            storedAt: new Date().toISOString(),
            ranAt,
            version: 1,
          });
        } catch (err) {
          console.error(`[Dashboard] Failed to store result for ${packId}: ${err}`);
        }
      }

      // Detect failure from runner result (runner catches errors and returns partial results)
      const hasError = !!(result as any).failedStepId || result.meta.notes?.startsWith('Error');
      const packResult: RunPackResult = {
        success: !hasError,
        collectibles: result.collectibles,
        meta: result.meta,
      };

      // Surface failedStepId and error info from runner
      if ((result as any).failedStepId) {
        packResult.failedStepId = (result as any).failedStepId;
        packResult.error = result.meta.notes;
      }

      // Propagate diagnostic hints if present
      if (result._hints && result._hints.length > 0) {
        packResult._hints = result._hints;
      }

      // Include result key so the caller knows how to query stored data
      if (resultKey) {
        packResult._resultKey = resultKey;
      }

      return packResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Extract partial results from enriched error (set by interpreter via runner)
      const partialResult = (error as any)?.partialResult as
        | { collectibles: Record<string, unknown>; stepsExecuted: number; failedStepId: string }
        | undefined;

      const failResult: RunPackResult = {
        success: false,
        collectibles: partialResult?.collectibles ?? {},
        meta: { durationMs: 0 },
        error: errorMessage,
      };
      if (partialResult?.failedStepId) {
        failResult.failedStepId = partialResult.failedStepId;
      }
      return failResult;
    }
  }
}
