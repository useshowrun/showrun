/**
 * TaskPack Editor MCP Server
 * Provides tools for reading, validating, and patching JSON Task Packs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve, join } from 'path';
import * as z from 'zod';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'fs';
import type { TaskPackManifest, DslStep, CollectibleDefinition, InputSchema, SecretDefinition } from '@showrun/core';
import { TaskPackLoader, validateJsonTaskPack } from '@showrun/core';
import { discoverPacks } from '@showrun/mcp-server';
import { runTaskPack } from '@showrun/core';
import { JSONLLogger } from '@showrun/harness';
import { randomBytes } from 'crypto';

// Helper functions (copied from dashboard packUtils)
function readJsonFile<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Failed to parse JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp`;
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        renameSync(tempPath, filePath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

function writeFlowJson(
  packDir: string,
  flowData: {
    inputs?: InputSchema;
    collectibles?: CollectibleDefinition[];
    flow: DslStep[];
  }
): void {
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
  
  validateJsonTaskPack(tempPack);

  const flowPath = join(packDir, 'flow.json');
  const content = JSON.stringify(flowData, null, 2) + '\n';
  atomicWrite(flowPath, content);
}

function validatePathInAllowedDir(path: string, allowedDir: string): void {
  const resolvedPath = resolve(path);
  const resolvedAllowed = resolve(allowedDir);
  
  if (!resolvedPath.startsWith(resolvedAllowed + '/') && resolvedPath !== resolvedAllowed) {
    throw new Error(`Path ${resolvedPath} is outside allowed directory ${resolvedAllowed}`);
  }
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

export interface TaskPackEditorOptions {
  /**
   * Directories containing task packs (for discovery)
   */
  packDirs: string[];
  /**
   * Workspace directory (writable, for editing)
   */
  workspaceDir: string;
  /**
   * Base directory for runs
   */
  baseRunDir: string;
  /**
   * Auth token for HTTP access (if using HTTP transport)
   */
  authToken?: string;
}

/**
 * Flow patch operation types
 */
type FlowPatchOp =
  | { op: 'append'; step: DslStep }
  | { op: 'insert'; index: number; step: DslStep }
  | { op: 'replace'; index: number; step: DslStep }
  | { op: 'delete'; index: number }
  | { op: 'update_collectibles'; collectibles: CollectibleDefinition[] };

export async function createTaskPackEditorServer(
  options: TaskPackEditorOptions
): Promise<void> {
  const { packDirs, workspaceDir, baseRunDir } = options;

  const resolvedWorkspaceDir = resolve(workspaceDir);
  const resolvedBaseRunDir = resolve(baseRunDir);

  // Discover packs
  const discoveredPacks = await discoverPacks({ directories: packDirs });
  const packMap = new Map<string, { packPath: string }>();
  for (const { pack, path } of discoveredPacks) {
    packMap.set(pack.metadata.id, { packPath: path });
  }

  const server = new McpServer({
    name: 'taskpack-editor-mcp',
    version: '0.1.0',
  });

  // Tool: list_packs
  server.registerTool(
    'list_packs',
    {
      title: 'List Task Packs',
      description: 'Returns JSON packs (id/name/version/description)',
      inputSchema: z.object({}),
    },
    async () => {
      const currentPacks = await discoverPacks({ directories: packDirs });
      
      // Update pack map
      packMap.clear();
      for (const { pack, path } of currentPacks) {
        packMap.set(pack.metadata.id, { packPath: path });
      }

      const packsList = currentPacks.map(({ pack, path }) => {
        let kind: string | undefined;
        try {
          const manifest = TaskPackLoader.loadManifest(path);
          kind = manifest.kind;
        } catch {
          // Ignore
        }

        return {
          id: pack.metadata.id,
          name: pack.metadata.name,
          version: pack.metadata.version,
          description: pack.metadata.description || '',
        };
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(packsList, null, 2),
          },
        ],
        structuredContent: packsList as unknown as Record<string, unknown>,
      };
    }
  );

  // Tool: read_pack
  server.registerTool(
    'read_pack',
    {
      title: 'Read Task Pack',
      description: 'Returns taskpack.json and flow.json for a pack',
      inputSchema: z.object({
        packId: z.string().describe('Pack ID'),
      }),
    },
    async ({ packId }) => {
      const packInfo = packMap.get(packId);
      if (!packInfo) {
        throw new Error(`Pack not found: ${packId}`);
      }

      // Validate path is in workspace
      try {
        validatePathInAllowedDir(packInfo.packPath, resolvedWorkspaceDir);
      } catch {
        throw new Error(`Pack ${packId} is not in workspace directory`);
      }

      const manifest = TaskPackLoader.loadManifest(packInfo.packPath);
      if (manifest.kind !== 'json-dsl') {
        throw new Error(`Pack ${packId} is not a JSON-DSL pack`);
      }

      const flowPath = resolve(packInfo.packPath, 'flow.json');
      const flowJson = readJsonFile<{
        inputs?: InputSchema;
        collectibles?: CollectibleDefinition[];
        flow: DslStep[];
      }>(flowPath);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ taskpackJson: manifest, flowJson }, null, 2),
          },
        ],
        structuredContent: {
          taskpackJson: manifest,
          flowJson,
        },
      };
    }
  );

  // Tool: list_secrets
  server.registerTool(
    'list_secrets',
    {
      title: 'List Secrets',
      description: 'List secrets for a pack. Returns names and descriptions only (no values for security). Use {{secret.NAME}} in templates.',
      inputSchema: z.object({
        packId: z.string().describe('Pack ID'),
      }),
    },
    async ({ packId }) => {
      const packInfo = packMap.get(packId);
      if (!packInfo) {
        throw new Error(`Pack not found: ${packId}`);
      }

      // Validate path is in workspace
      try {
        validatePathInAllowedDir(packInfo.packPath, resolvedWorkspaceDir);
      } catch {
        throw new Error(`Pack ${packId} is not in workspace directory`);
      }

      // Get secret definitions from manifest
      const definitions = TaskPackLoader.getSecretDefinitions(packInfo.packPath);

      // Get which secrets have values (without revealing values)
      const secrets = TaskPackLoader.loadSecrets(packInfo.packPath);
      const secretsInfo = definitions.map((def) => ({
        name: def.name,
        description: def.description,
        required: def.required,
        hasValue: !!secrets[def.name],
      }));

      // Also include any secrets that exist but aren't defined
      for (const name of Object.keys(secrets)) {
        if (!definitions.find((d) => d.name === name)) {
          secretsInfo.push({
            name,
            description: undefined,
            required: undefined,
            hasValue: true,
          });
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              secrets: secretsInfo,
              note: 'Use {{secret.NAME}} in templates to reference secret values. Never ask for secret values.',
            }, null, 2),
          },
        ],
        structuredContent: {
          secrets: secretsInfo,
          note: 'Use {{secret.NAME}} in templates to reference secret values. Never ask for secret values.',
        },
      };
    }
  );

  // Tool: validate_flow
  server.registerTool(
    'validate_flow',
    {
      title: 'Validate Flow',
      description: 'Validates DSL steps and collectible outputs',
      inputSchema: z.object({
        flowJsonText: z.string().describe('Flow JSON as string'),
      }),
    },
    async ({ flowJsonText }) => {
      try {
        const flowData = JSON.parse(flowJsonText) as {
          inputs?: InputSchema;
          collectibles?: CollectibleDefinition[];
          flow: DslStep[];
        };

        if (!flowData.flow || !Array.isArray(flowData.flow)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  errors: ['flow must be an array'],
                  warnings: [],
                }),
              },
            ],
            structuredContent: {
              ok: false,
              errors: ['flow must be an array'],
              warnings: [],
            },
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

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: errors.length === 0, errors, warnings }, null, 2),
            },
          ],
          structuredContent: {
            ok: errors.length === 0,
            errors,
            warnings,
          },
        };
      } catch (error) {
        if (error instanceof SyntaxError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  errors: [`Invalid JSON: ${error.message}`],
                  warnings: [],
                }),
              },
            ],
            structuredContent: {
              ok: false,
              errors: [`Invalid JSON: ${error.message}`],
              warnings: [],
            },
          };
        }
        throw error;
      }
    }
  );

  // Tool: apply_flow_patch
  server.registerTool(
    'apply_flow_patch',
    {
      title: 'Apply Flow Patch',
      description:
        'Applies a patch to flow.json (append/insert/replace/delete steps, update collectibles). Supported step types: navigate, wait_for, click, fill, extract_text, extract_attribute, extract_title, sleep, assert, set_var, network_find (where; pick, saveAs, waitForMs), network_replay (requestId {{vars.<saveAs>}}; overrides: url/setQuery/setHeaders/body support {{vars.xxx}}/{{inputs.xxx}}; optional urlReplace/bodyReplace { find, replace } regex, replace can use $1,$2 and templates; auth, out, response.as), network_extract (fromVar, as, jsonPath?, out).',
      inputSchema: z.object({
        packId: z.string().describe('Pack ID'),
        patch: z.object({
          op: z.enum(['append', 'insert', 'replace', 'delete', 'update_collectibles']),
          step: z.any().optional(),
          index: z.number().optional(),
          collectibles: z.array(z.any()).optional(),
        }),
      }),
    },
    async ({ packId, patch }) => {
      const packInfo = packMap.get(packId);
      if (!packInfo) {
        throw new Error(`Pack not found: ${packId}`);
      }

      // Validate path is in workspace
      try {
        validatePathInAllowedDir(packInfo.packPath, resolvedWorkspaceDir);
      } catch {
        throw new Error(`Pack ${packId} is not in workspace directory`);
      }

      const manifest = TaskPackLoader.loadManifest(packInfo.packPath);
      if (manifest.kind !== 'json-dsl') {
        throw new Error(`Pack ${packId} is not a JSON-DSL pack`);
      }

      // Load current flow
      const flowPath = resolve(packInfo.packPath, 'flow.json');
      const flowData = readJsonFile<{
        inputs?: InputSchema;
        collectibles?: CollectibleDefinition[];
        flow: DslStep[];
      }>(flowPath);

      // Apply patch (accept step from patch.step or patch.proposal.step)
      const newFlow = [...flowData.flow];
      const newCollectibles = [...(flowData.collectibles || [])];

      const patchOp = patch as Record<string, unknown>;
      const step = patchOp.step ?? (patchOp.proposal as Record<string, unknown> | undefined)?.step;
      const resolved = { ...patchOp, step } as FlowPatchOp;

      const stepErr = (op: string, reason: string, hint: string) =>
        new Error(
          `Patch "${op}" failed: ${reason}. ${hint} Received: step=${step === undefined ? 'undefined' : step === null ? 'null' : typeof step}${typeof step === 'object' && step && !Array.isArray(step) ? ', keys=' + Object.keys(step as object).join(',') : ''}.`
        );

      switch (resolved.op) {
        case 'append':
          if (!resolved.step || typeof resolved.step !== 'object' || Array.isArray(resolved.step)) {
            throw stepErr(
              'append',
              'step is missing or not an object',
              "Send patch.step (or patch.proposal.step) with id, type, and params. For network_replay, requestId must be a template like {{vars.<saveAs>}} from the preceding network_find (e.g. {{vars.martiniRequestId}}). Never use a literal request ID. Example: { id: 'replay_martini', type: 'network_replay', params: { requestId: '{{vars.martiniRequestId}}', auth: 'browser_context', out: 'data', response: { as: 'json' } } }."
            );
          }
          if (!('id' in resolved.step) || !('type' in resolved.step) || !('params' in resolved.step)) {
            throw stepErr(
              'append',
              "step must have id, type, and params",
              "Example: { id: 'step_id', type: 'network_replay', params: { requestId: '{{vars.<saveAs>}}', auth: 'browser_context', out, response: { as: 'json' } } }."
            );
          }
          newFlow.push(resolved.step);
          break;
        case 'insert':
          if (resolved.index === undefined || !resolved.step || typeof resolved.step !== 'object' || Array.isArray(resolved.step)) {
            throw new Error(
              "insert requires index (number) and step (object with id, type, params). You sent: " +
              `index=${resolved.index === undefined ? 'undefined' : resolved.index}, step=${resolved.step === undefined ? 'undefined' : typeof resolved.step}.`
            );
          }
          if (resolved.index < 0 || resolved.index > newFlow.length) {
            throw new Error(`insert index must be 0..${newFlow.length}. Received: ${resolved.index}`);
          }
          newFlow.splice(resolved.index, 0, resolved.step);
          break;
        case 'replace':
          if (resolved.index === undefined || !resolved.step || typeof resolved.step !== 'object' || Array.isArray(resolved.step)) {
            throw new Error("replace requires index and step (object with id, type, params).");
          }
          if (resolved.index < 0 || resolved.index >= newFlow.length) {
            throw new Error(`replace index must be 0..${newFlow.length - 1}. Received: ${resolved.index}`);
          }
          newFlow[resolved.index] = resolved.step;
          break;
        case 'delete':
          if (resolved.index === undefined) {
            throw new Error("delete requires index (number). Example: { op: 'delete', index: 0 }");
          }
          if (resolved.index < 0 || resolved.index >= newFlow.length) {
            throw new Error(`delete index must be 0..${newFlow.length - 1}. Received: ${resolved.index}`);
          }
          newFlow.splice(resolved.index, 1);
          break;
        case 'update_collectibles':
          if (!resolved.collectibles || !Array.isArray(resolved.collectibles)) {
            throw new Error("update_collectibles requires collectibles (array of { name, type, description }).");
          }
          newCollectibles.length = 0;
          newCollectibles.push(...resolved.collectibles);
          break;
        default:
          throw new Error(`Unknown patch operation: ${(resolved as { op?: string }).op}`);
      }

      // Validate after applying
      const tempPack = {
        metadata: manifest,
        inputs: flowData.inputs || {},
        collectibles: newCollectibles,
        flow: newFlow,
      };

      try {
        validateJsonTaskPack(tempPack);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const stepType = (step as any)?.type;
        const hint = stepType ? getStepParamsHint(stepType) : '';
        throw new Error(
          `Step validation failed:\n${msg}${hint ? `\n\nHint for "${stepType}": ${hint}` : ''}`
        );
      }

      // Write atomically
      writeFlowJson(packInfo.packPath, {
        inputs: flowData.inputs,
        collectibles: newCollectibles,
        flow: newFlow,
      });

      // Reload pack to get updated state
      const reloaded = await TaskPackLoader.loadTaskPack(packInfo.packPath);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              flow: {
                stepsCount: newFlow.length,
                collectiblesCount: newCollectibles.length,
              },
            }),
          },
        ],
        structuredContent: {
          success: true,
          flow: {
            stepsCount: newFlow.length,
            collectiblesCount: newCollectibles.length,
          },
        },
      };
    }
  );

  // Tool: run_pack
  server.registerTool(
    'run_pack',
    {
      title: 'Run Task Pack',
      description: 'Triggers a run of the pack',
      inputSchema: z.object({
        packId: z.string().describe('Pack ID'),
        inputs: z.record(z.unknown()).describe('Input values'),
      }),
    },
    async ({ packId, inputs }) => {
      const packInfo = packMap.get(packId);
      if (!packInfo) {
        throw new Error(`Pack not found: ${packId}`);
      }

      const pack = await TaskPackLoader.loadTaskPack(packInfo.packPath);

      const runId = randomBytes(16).toString('hex');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const runDir = resolve(resolvedBaseRunDir, `${packId}-${timestamp}-${runId.slice(0, 8)}`);

      const logger = new JSONLLogger(runDir);

      try {
        const result = await runTaskPack(pack, inputs, {
          runDir,
          logger,
          headless: true, // Default to headless for MCP runs
          profileId: packId,
          packPath: packInfo.packPath,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                runId,
                runDir: result.runDir,
                eventsPath: result.eventsPath,
                artifactsDir: result.artifactsDir,
              }),
            },
          ],
          structuredContent: {
            runId,
            runDir: result.runDir,
            eventsPath: result.eventsPath,
            artifactsDir: result.artifactsDir,
          },
        };
      } catch (error) {
        throw new Error(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[TaskPack Editor MCP] Server started and ready');
}
