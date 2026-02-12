import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as z from 'zod';
import type { TaskPack, InputSchema, PrimitiveType } from '@showrun/core';
import { runTaskPack } from '@showrun/core';
import { JSONLLogger } from '@showrun/harness';
import type { DiscoveredPack } from './packDiscovery.js';
import { ConcurrencyLimiter } from './concurrency.js';

/**
 * Options for MCP server
 */
export interface MCPServerOptions {
  /**
   * Discovered task packs
   */
  packs: DiscoveredPack[];
  /**
   * Base directory for run outputs
   */
  baseRunDir: string;
  /**
   * Maximum concurrent executions
   */
  concurrency: number;
  /**
   * Whether to run browser in headful mode
   */
  headful: boolean;
}

/**
 * Converts Task Pack input schema to Zod schema for McpServer
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

    // Add description if provided
    if (fieldDef.description) {
      zodType = zodType.describe(fieldDef.description);
    }

    // Make optional if not required
    if (!fieldDef.required) {
      zodType = zodType.optional();
    }

    shape[fieldName] = zodType;
  }

  return shape;
}

/**
 * Creates and starts the MCP server
 */
export async function createMCPServer(
  options: MCPServerOptions
): Promise<void> {
  const { packs, baseRunDir, concurrency, headful } = options;

  // Generate unique session ID for this server instance
  const serverSessionId = randomUUID();

  // Ensure base run directory exists
  mkdirSync(baseRunDir, { recursive: true });

  // Create concurrency limiter
  const limiter = new ConcurrencyLimiter(concurrency);

  // Log server startup
  console.error(`[MCP Server] Starting with ${packs.length} task pack(s)`);
  console.error(`[MCP Server] Session ID: ${serverSessionId}`);
  console.error(`[MCP Server] Concurrency: ${concurrency}, Headful: ${headful}`);
  console.error(`[MCP Server] Base run directory: ${baseRunDir}`);

  // Create MCP server using the recommended high-level API
  const server = new McpServer({
    name: 'taskpack-mcp-server',
    version: '0.1.0',
  });

  // Register each discovered pack as a tool
  for (const { pack, toolName, path: packDir } of packs) {
    const inputSchema = inputSchemaToZodSchema(pack.inputs);
    
    server.registerTool(
      toolName,
      {
        title: pack.metadata.name,
        description: `${pack.metadata.description || pack.metadata.name} (v${pack.metadata.version})`,
        inputSchema,
      },
      async (inputs: Record<string, unknown>) => {
        const runId = randomUUID();

        console.error(
          `[MCP Server] Tool invocation: ${toolName} (runId: ${runId})`
        );

        // Create run directory
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const runDir = join(baseRunDir, `${toolName}-${timestamp}-${runId.slice(0, 8)}`);

        // Execute with concurrency control
        return await limiter.execute(async () => {
          const logger = new JSONLLogger(runDir);
          
          try {
            const runResult = await runTaskPack(pack, inputs, {
              runDir,
              logger,
              headless: !headful,
              sessionId: serverSessionId,
              profileId: pack.metadata.id,
              packPath: packDir,
              cacheDir: packDir,
            });

            console.error(
              `[MCP Server] Tool completed: ${toolName} (runId: ${runId}) - Success`
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(runResult.collectibles, null, 2),
                },
              ],
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            console.error(
              `[MCP Server] Tool failed: ${toolName} (runId: ${runId}) - ${errorMessage}`
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: errorMessage }, null, 2),
                },
              ],
              isError: true,
            };
          }
        });
      }
    );

    console.error(`[MCP Server] Registered tool: ${toolName} (${pack.metadata.id} v${pack.metadata.version})`);
  }

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP Server] Server started and ready');
}
