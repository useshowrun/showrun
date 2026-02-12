import { createServer, IncomingMessage } from 'http';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { TaskPack, InputSchema } from '@showrun/core';
import { runTaskPack } from '@showrun/core';
import { JSONLLogger } from '@showrun/harness';
import type { DiscoveredPack } from './packDiscovery.js';
import { ConcurrencyLimiter } from './concurrency.js';

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

export interface MCPServerHTTPOptions {
  packs: DiscoveredPack[];
  baseRunDir: string;
  concurrency: number;
  headful: boolean;
  port: number;
  host?: string;
  /** Called when a run starts (for tracking/logging) */
  onRunStart?: (info: MCPRunStartInfo) => void;
  /** Called when a run completes (for tracking/logging) */
  onRunComplete?: (info: MCPRunCompleteInfo) => void;
}

interface ClientSession {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: Date;
  lastAccessedAt: Date;
}

// Session timeout in milliseconds (30 minutes)
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
// Cleanup interval (5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Parse cookies from request header
 */
function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return cookies;

  for (const cookie of cookieHeader.split(';')) {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (name && valueParts.length > 0) {
      cookies[name.trim()] = valueParts.join('=').trim();
    }
  }
  return cookies;
}

function inputSchemaToZodSchema(inputs: InputSchema): z.ZodRawShape {
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
    if (fieldDef.description) zodType = zodType.describe(fieldDef.description);
    if (!fieldDef.required) zodType = zodType.optional();
    shape[fieldName] = zodType;
  }
  return shape;
}

export interface MCPServerHTTPHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Creates and starts the MCP server with Streamable HTTP (HTTPS/SSE) transport.
 * Returns handle with port, url, and close() to stop the server.
 *
 * Session Management:
 * - Each client gets their own isolated session
 * - Client can provide session ID via 'mcp-session-id' header to resume a session
 * - New session ID is generated if client doesn't provide one
 */
export async function createMCPServerOverHTTP(
  options: MCPServerHTTPOptions
): Promise<MCPServerHTTPHandle> {
  const { packs, baseRunDir, concurrency, headful, port, host = '127.0.0.1', onRunStart, onRunComplete } = options;

  mkdirSync(baseRunDir, { recursive: true });
  const limiter = new ConcurrencyLimiter(concurrency);

  // Store sessions by client session ID
  const sessions = new Map<string, ClientSession>();

  /**
   * Create a new MCP server instance with all tools registered
   */
  function createMcpServerWithTools(clientSessionId: string): McpServer {
    const server = new McpServer({
      name: 'taskpack-mcp-server',
      version: '0.1.0',
    });

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
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const runDir = join(baseRunDir, `${toolName}-${timestamp}-${runId.slice(0, 8)}`);
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
                sessionId: clientSessionId, // Use client's session ID for once-cache
                profileId: pack.metadata.id,
                packPath: packDir,
                cacheDir: packDir,
              });
              const durationMs = Date.now() - startTime;

              // Notify run complete (success)
              onRunComplete?.({
                packId: pack.metadata.id,
                runId,
                success: true,
                collectibles: runResult.collectibles,
                durationMs,
              });

              return {
                content: [
                  { type: 'text' as const, text: JSON.stringify(runResult.collectibles, null, 2) },
                ],
              };
            } catch (error) {
              const durationMs = Date.now() - startTime;
              const errorMessage = error instanceof Error ? error.message : String(error);

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
        }
      );
    }

    return server;
  }

  /**
   * Get or create a session for the given session ID
   */
  async function getOrCreateSession(sessionId: string): Promise<ClientSession> {
    let session = sessions.get(sessionId);

    if (session) {
      session.lastAccessedAt = new Date();
      return session;
    }

    // Create new session
    const server = createMcpServerWithTools(sessionId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    await server.connect(transport);

    session = {
      id: sessionId,
      server,
      transport,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
    };

    sessions.set(sessionId, session);
    console.error(`[MCP Server] Created new session: ${sessionId}`);

    return session;
  }

  /**
   * Extract session ID from request headers or cookies
   */
  function getSessionIdFromRequest(req: IncomingMessage): string | undefined {
    // First check header (preferred for MCP clients)
    const headerSessionId = req.headers['mcp-session-id'];
    if (typeof headerSessionId === 'string' && headerSessionId.length > 0) {
      return headerSessionId;
    }

    // Fallback to cookie for simple HTTP clients
    const cookies = parseCookies(req);
    const cookieSessionId = cookies['mcp-session-id'];
    if (cookieSessionId && cookieSessionId.length > 0) {
      return cookieSessionId;
    }

    return undefined;
  }

  /**
   * Clean up inactive sessions
   */
  function cleanupInactiveSessions(): void {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of sessions) {
      const inactiveMs = now - session.lastAccessedAt.getTime();
      if (inactiveMs > SESSION_TIMEOUT_MS) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      sessions.delete(sessionId);
      console.error(`[MCP Server] Removed inactive session: ${sessionId} (inactive for ${Math.round(SESSION_TIMEOUT_MS / 60000)} minutes)`);
    }

    if (expiredSessions.length > 0) {
      console.error(`[MCP Server] Active sessions: ${sessions.size}`);
    }
  }

  // Start cleanup interval
  const cleanupInterval = setInterval(cleanupInactiveSessions, CLEANUP_INTERVAL_MS);

  const httpServer = createServer(async (req, res) => {
    try {
      // Get session ID from header or cookie, or generate new one
      let sessionId = getSessionIdFromRequest(req);
      const isNewSession = !sessionId;

      if (!sessionId) {
        sessionId = randomUUID();
      }

      // Inject session ID into headers for the transport
      req.headers['mcp-session-id'] = sessionId;

      const session = await getOrCreateSession(sessionId);

      // Set session ID in both header and cookie for client flexibility
      if (isNewSession) {
        res.setHeader('Mcp-Session-Id', sessionId);
      }
      // Always set/refresh the cookie
      res.setHeader('Set-Cookie', `mcp-session-id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TIMEOUT_MS / 1000)}`);

      await session.transport.handleRequest(req, res);
    } catch (err) {
      console.error('[MCP Server] Request error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  return new Promise<MCPServerHTTPHandle>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      const scheme = 'http';
      const url = `${scheme}://${host}:${actualPort}`;
      console.error(`[MCP Server] HTTP server listening on ${url}`);
      console.error(`[MCP Server] Session management enabled - each client gets isolated session`);
      resolve({
        port: actualPort,
        url,
        close: () =>
          new Promise<void>((closeResolve) => {
            clearInterval(cleanupInterval);
            sessions.clear();
            httpServer.close(() => closeResolve());
          }),
      });
    });
  });
}
