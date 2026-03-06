/**
 * Shared MCP tool registration logic.
 *
 * Both the stdio server (server.ts) and HTTP server (httpServer.ts) use this
 * module to register task-pack tools and result-query tools on an McpServer
 * instance — eliminating the previously duplicated ~120 lines.
 */
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskPack, InputSchema, ResultStoreProvider, CollectibleSchemaField } from '@showrun/core';
import { runTaskPack, generateResultKey, executePlaywrightJs } from '@showrun/core';
import { JSONLLogger } from '@showrun/harness';
import type { DiscoveredPack } from './packDiscovery.js';
import type { ConcurrencyLimiter } from './concurrency.js';
import { registerResultTools } from './resultTools.js';

/** Threshold (chars) above which results are summarized instead of returned in full */
export const LARGE_RESULT_THRESHOLD = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts Task Pack input schema to Zod schema for McpServer.
 */
export function inputSchemaToZodSchema(inputs: InputSchema): z.ZodRawShape {
  const shape: z.ZodRawShape = {};

  for (const [fieldName, fieldDef] of Object.entries(inputs)) {
    let zodType: z.ZodTypeAny;

    switch (fieldDef.type) {
      case 'string':
        zodType = z.string();
        break;
      case 'number':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      default:
        zodType = z.string();
    }

    if (fieldDef.description) {
      zodType = zodType.describe(fieldDef.description);
    }

    if (!fieldDef.required) {
      zodType = zodType.optional();
    }

    shape[fieldName] = zodType;
  }

  return shape;
}

/**
 * Build an enhanced tool description that includes collectible schema info.
 */
export function buildToolDescription(pack: TaskPack): string {
  let desc = `${pack.metadata.description || pack.metadata.name} (v${pack.metadata.version})`;

  if (pack.collectibles.length > 0) {
    const fields = pack.collectibles
      .map((c) => `  - ${c.name} (${c.type})${c.description ? ': ' + c.description : ''}`)
      .join('\n');
    desc += `\n\nCollectibles:\n${fields}`;
  }

  return desc;
}

/**
 * Derive CollectibleSchemaField[] from a TaskPack's collectibles.
 */
export function packToSchema(pack: TaskPack): CollectibleSchemaField[] {
  return pack.collectibles.map((c) => ({
    name: c.name,
    type: c.type,
    description: c.description,
  }));
}

// ---------------------------------------------------------------------------
// Main registration
// ---------------------------------------------------------------------------

export interface MCPRunStartInfo {
  packId: string;
  packName: string;
  runId: string;
  inputs: Record<string, unknown>;
  runDir: string;
}

export interface MCPRunCompleteInfo {
  packId: string;
  runId: string;
  success: boolean;
  error?: string;
  collectibles?: Record<string, unknown>;
  durationMs?: number;
}

export interface RegisterPackToolsOptions {
  packs: DiscoveredPack[];
  baseRunDir: string;
  limiter: ConcurrencyLimiter;
  headful: boolean;
  /** stdio: server-wide UUID; HTTP: per-client session ID */
  sessionId: string;
  /** Per-pack result stores, keyed by tool name */
  resultStores?: Map<string, ResultStoreProvider>;
  /** Called when a run starts (for tracking/logging) */
  onRunStart?: (info: MCPRunStartInfo) => void;
  /** Called when a run completes (for tracking/logging) */
  onRunComplete?: (info: MCPRunCompleteInfo) => void;
}

/**
 * Register pack tools + result query tools on an McpServer instance.
 */
export function registerPackTools(
  server: McpServer,
  options: RegisterPackToolsOptions,
): void {
  const { packs, baseRunDir, limiter, headful, sessionId, resultStores, onRunStart, onRunComplete } = options;

  for (const { pack, toolName, path: packDir } of packs) {
    const inputSchema = inputSchemaToZodSchema(pack.inputs);
    const store = resultStores?.get(toolName);
    const schema = packToSchema(pack);

    server.registerTool(
      toolName,
      {
        title: pack.metadata.name,
        description: buildToolDescription(pack),
        inputSchema,
      },
      async (inputs: Record<string, unknown>) => {
        const runId = randomUUID();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const runDir = join(baseRunDir, `${toolName}-${timestamp}-${runId.slice(0, 8)}`);
        const ranAt = new Date().toISOString();

        return await limiter.execute(async () => {
          const logger = new JSONLLogger(runDir);
          const startTime = Date.now();

          // Notify run start
          onRunStart?.({
            packId: pack.metadata.id,
            packName: pack.metadata.name,
            runId,
            inputs,
            runDir,
          });

          try {
            const runResult = await runTaskPack(pack, inputs, {
              runDir,
              logger,
              headless: !headful,
              sessionId,
              profileId: pack.metadata.id,
              packPath: packDir,
              cacheDir: packDir,
              playwrightJsExecutor: executePlaywrightJs,
            });
            const durationMs = Date.now() - startTime;

            console.error(
              `[MCP Server] Tool completed: ${toolName} (runId: ${runId}) - Success`,
            );

            // Notify run complete (success)
            onRunComplete?.({
              packId: pack.metadata.id,
              runId,
              success: true,
              collectibles: runResult.collectibles,
              durationMs,
            });

            // Auto-store result (fire-and-forget)
            const resultKey = generateResultKey(pack.metadata.id, inputs);
            if (store) {
              store.store({
                key: resultKey,
                packId: pack.metadata.id,
                toolName,
                inputs,
                collectibles: runResult.collectibles,
                meta: runResult.meta,
                collectibleSchema: schema,
                storedAt: new Date().toISOString(),
                ranAt,
                version: 1, // store impl handles incrementing
              }).catch((err) => {
                console.error(`[MCP Server] Failed to store result for ${toolName}: ${err}`);
              });
            }

            // Smart return: summarize large results
            const fullJson = JSON.stringify(runResult.collectibles, null, 2);

            if (store && fullJson.length > LARGE_RESULT_THRESHOLD) {
              const preview = fullJson.slice(0, 2000) + '\n... (truncated)';
              const summary = {
                _resultKey: resultKey,
                _summary: `Result stored (${fullJson.length} chars). Use showrun_query_results with key="${resultKey}" and pack_tool_name="${toolName}" to retrieve, filter, or paginate.`,
                _message: 'Large result auto-stored. Use showrun_query_results to access the full data with optional JMESPath filtering.',
                _preview: preview,
              };
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
              };
            }

            // Small result: return full collectibles + key + hint
            const payload: Record<string, unknown> = { ...runResult.collectibles };
            if (store) {
              payload._resultKey = resultKey;
              payload._stored = true;
              payload._hint = `Result stored with key="${resultKey}". Use showrun_query_results with pack_tool_name="${toolName}" and this key to filter or paginate later.`;
            }

            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
              ],
            };
          } catch (error) {
            const durationMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);

            console.error(
              `[MCP Server] Tool failed: ${toolName} (runId: ${runId}) - ${errorMessage}`,
            );

            // Notify run complete (failure)
            onRunComplete?.({
              packId: pack.metadata.id,
              runId,
              success: false,
              error: errorMessage,
              durationMs,
            });

            return {
              content: [
                { type: 'text' as const, text: JSON.stringify({ error: errorMessage }, null, 2) },
              ],
              isError: true,
            };
          }
        });
      },
    );

    console.error(`[MCP Server] Registered tool: ${toolName} (${pack.metadata.id} v${pack.metadata.version})`);
  }

  // Register result query/list tools when stores are available
  if (resultStores && resultStores.size > 0) {
    registerResultTools(server, resultStores);
    console.error('[MCP Server] Registered result query tools (showrun_query_results, showrun_list_results)');
  }
}
