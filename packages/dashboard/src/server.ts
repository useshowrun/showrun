import express, { type Request, type Response } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { randomBytes } from 'crypto';
import { resolve, dirname } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { TaskPack, LogEvent } from '@mcpify/core';
import { runTaskPack } from '@mcpify/core';
import { discoverPacks } from '@mcpify/mcp-server/dist/packDiscovery.js';
import { ConcurrencyLimiter } from '@mcpify/mcp-server/dist/concurrency.js';
import {
  createMCPServerOverHTTP,
  type MCPServerHTTPHandle,
  type MCPRunStartInfo,
  type MCPRunCompleteInfo,
} from '@mcpify/mcp-server/dist/httpServer.js';
import { SocketLogger } from './logger.js';
import { RunManager, type RunInfo } from './runManager.js';
import {
  initDatabase,
  createConversation,
  getConversation,
  getAllConversations,
  updateConversation,
  deleteConversation,
  addMessage,
  getMessagesForConversation,
  type Conversation,
  type Message,
} from './db.js';
import {
  sanitizePackId,
  ensureDir,
  writeTaskPackManifest,
  writeFlowJson,
  validatePathInAllowedDir,
  readJsonFile,
} from './packUtils.js';
import { TaskPackLoader } from '@mcpify/core';
import { validateJsonTaskPack } from '@mcpify/core';
import type { TaskPackManifest, InputSchema, CollectibleDefinition } from '@mcpify/core';
import type { DslStep } from '@mcpify/core';
import { createLlmProvider } from './llm/index.js';
import type { ChatMessage, ToolCall, StreamEvent, ChatWithToolsResult } from './llm/provider.js';
import { proposeStep, type ProposeStepRequest } from './teachMode.js';
import {
  MCP_AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  type AgentToolContext,
} from './agentTools.js';
import { TaskPackEditorWrapper } from './mcpWrappers.js';
import {
  getSecretNamesWithValues,
  setSecretValue,
  deleteSecretValue,
  updateSecretDefinitions,
} from './secretsUtils.js';
import {
  summarizeIfNeeded,
  estimateTotalTokens,
} from './contextManager.js';
import {
  startBrowserSession,
  gotoUrl,
  goBack,
  typeInElement,
  takeScreenshot,
  getLinks,
  getDomSnapshot,
  networkList,
  networkSearch,
  networkGet,
  networkGetResponse,
  networkReplay,
  networkClear,
  getLastActions,
  closeSession,
} from './browserInspector.js';

export interface DashboardOptions {
  packs: string[];
  port: number;
  host?: string;
  headful: boolean;
  baseRunDir: string;
  workspaceDir?: string; // Writable directory for JSON pack creation/editing
  dataDir?: string; // Database directory (default: ./data)
}

/**
 * Starts the dashboard server
 */
export async function startDashboard(options: DashboardOptions): Promise<void> {
  const { packs: packDirs, port, host = '127.0.0.1', headful, baseRunDir, workspaceDir, dataDir = './data' } = options;

  // Initialize database
  console.log(`[Dashboard] Initializing database...`);
  initDatabase(dataDir);

  // Generate session token for security
  const sessionToken = randomBytes(32).toString('hex');

  // Determine workspace directory (writable directory for JSON packs)
  // Use workspaceDir if provided, otherwise use first packs directory
  const resolvedWorkspaceDir = workspaceDir
    ? resolve(workspaceDir)
    : packDirs.length > 0
    ? resolve(packDirs[0])
    : null;

  if (resolvedWorkspaceDir) {
    ensureDir(resolvedWorkspaceDir);
    console.log(`[Dashboard] Workspace directory (writable): ${resolvedWorkspaceDir}`);
  }

  // Ensure base run directory exists
  const resolvedBaseRunDir = resolve(baseRunDir);
  mkdirSync(resolvedBaseRunDir, { recursive: true });

  // Discover task packs
  console.log(`[Dashboard] Discovering task packs from: ${packDirs.join(', ')}`);
  const discoveredPacks = await discoverPacks({ directories: packDirs });
  console.log(`[Dashboard] Found ${discoveredPacks.length} task pack(s)`);

  if (discoveredPacks.length === 0) {
    console.error('[Dashboard] No task packs found. Exiting.');
    process.exit(1);
  }

  // Create pack map for quick lookup
  const packMap = new Map<string, { pack: TaskPack; path: string }>();
  for (const { pack, path } of discoveredPacks) {
    packMap.set(pack.metadata.id, { pack, path });
  }

  // MCP server over HTTP/SSE (started from dashboard)
  let mcpServerHandle: MCPServerHTTPHandle | null = null;
  let mcpServerPackIds: string[] = [];
  // Map MCP run IDs to database run IDs for tracking
  const mcpRunIdMap = new Map<string, string>();
  const MCP_DEFAULT_PORT = 3340;

  // Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static UI files (built by Vite)
  const uiPath = resolve(__dirname, 'ui');
  app.use(express.static(uiPath));

  // Create HTTP server
  const httpServer = createServer(app);

  // Create Socket.IO server with CORS
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*', // In production, restrict this
      methods: ['GET', 'POST'],
    },
  });

  // Socket authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token !== sessionToken) {
      return next(new Error('Authentication failed'));
    }
    next();
  });

  // Create run manager
  const runManager = new RunManager();
  const concurrencyLimiter = new ConcurrencyLimiter(1); // Default concurrency: 1

  // Create TaskPack Editor wrapper
  const taskPackEditor = new TaskPackEditorWrapper(
    packDirs,
    resolvedWorkspaceDir || packDirs[0],
    resolvedBaseRunDir,
    headful
  );

  // REST API: Get config (includes session token)
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      token: sessionToken,
      packsCount: discoveredPacks.length,
    });
  });

  // REST API: List packs
  app.get('/api/packs', async (_req: Request, res: Response) => {
    // Reload packs to get latest state
    const currentPacks = await discoverPacks({ directories: packDirs });
    
    // Update pack map
    packMap.clear();
    for (const { pack, path } of currentPacks) {
      packMap.set(pack.metadata.id, { pack, path });
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

  // REST API: Create run (requires token)
  app.post('/api/runs', (req: Request, res: Response) => {
    const token = req.headers['x-mcpify-token'];
    if (token !== sessionToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId, inputs, conversationId, source } = req.body;

    if (!packId || typeof packId !== 'string') {
      return res.status(400).json({ error: 'packId is required' });
    }

    if (!inputs || typeof inputs !== 'object') {
      return res.status(400).json({ error: 'inputs must be an object' });
    }

    // Verify pack exists
    const packInfo = packMap.get(packId);
    if (!packInfo) {
      return res.status(404).json({ error: `Task pack not found: ${packId}` });
    }

    // Create run using database-backed manager
    const runInfo = runManager.addRunAndGet(
      packId,
      packInfo.pack.metadata.name,
      source || 'dashboard',
      conversationId
    );
    const runId = runInfo.runId;

    // Emit run list update
    io.emit('runs:list', runManager.getAllRuns());

    // Queue execution
    concurrencyLimiter.execute(async () => {
      runManager.updateRun(runId, {
        status: 'running',
        startedAt: Date.now(),
      });
      io.emit('runs:list', runManager.getAllRuns());

      // Create run directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const runDir = resolve(resolvedBaseRunDir, `${packId}-${timestamp}-${runId.slice(0, 8)}`);

      // Create socket logger that emits events
      const logger = new SocketLogger(runDir, io, runId);

      try {
        const result = await runTaskPack(packInfo.pack, inputs, {
          runDir,
          logger,
          headless: !headful,
          profileId: packId,
        });

        runManager.updateRun(runId, {
          status: 'success',
          finishedAt: Date.now(),
          durationMs: result.meta.durationMs,
          runDir: result.runDir,
          eventsPath: result.eventsPath,
          artifactsDir: result.artifactsDir,
          collectibles: result.collectibles,
          meta: result.meta,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        runManager.updateRun(runId, {
          status: 'failed',
          finishedAt: Date.now(),
          error: errorMessage,
          runDir,
          eventsPath: resolve(runDir, 'events.jsonl'),
          artifactsDir: resolve(runDir, 'artifacts'),
        });
      } finally {
        io.emit('runs:list', runManager.getAllRuns());
      }
    }).catch((error) => {
      // Handle execution errors
      runManager.updateRun(runId, {
        status: 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      io.emit('runs:list', runManager.getAllRuns());
    });

    res.json({ runId });
  });

  // REST API: List runs (with optional filters)
  app.get('/api/runs', (req: Request, res: Response) => {
    const source = req.query.source as 'dashboard' | 'mcp' | 'cli' | 'agent' | undefined;
    const conversationId = req.query.conversationId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    res.json(runManager.getAllRuns({ source, conversationId, limit }));
  });

  // REST API: Get run details
  app.get('/api/runs/:runId', (req: Request, res: Response) => {
    const { runId } = req.params;
    const run = runManager.getRun(runId);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(run);
  });

  // ============================================================================
  // REST API: Conversations
  // ============================================================================

  // List all conversations
  app.get('/api/conversations', (_req: Request, res: Response) => {
    const conversations = getAllConversations();
    res.json(conversations);
  });

  // Create new conversation
  app.post('/api/conversations', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, description } = req.body;
    const conversationTitle = title || 'New Conversation';

    try {
      const conversation = createConversation(conversationTitle, description || null);
      io.emit('conversations:updated', getAllConversations());
      res.json(conversation);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Get conversation with messages
  app.get('/api/conversations/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const conversation = getConversation(id);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = getMessagesForConversation(id);
    res.json({
      ...conversation,
      messages,
    });
  });

  // Update conversation
  app.put('/api/conversations/:id', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const { title, description, status, packId } = req.body;

    try {
      const updated = updateConversation(id, {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(status !== undefined && { status }),
        ...(packId !== undefined && { packId }),
      });

      if (!updated) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      io.emit('conversations:updated', getAllConversations());
      res.json(updated);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Delete conversation
  app.delete('/api/conversations/:id', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    try {
      const deleted = deleteConversation(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      io.emit('conversations:updated', getAllConversations());
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Get messages for conversation
  app.get('/api/conversations/:id/messages', (req: Request, res: Response) => {
    const { id } = req.params;
    const conversation = getConversation(id);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = getMessagesForConversation(id);
    res.json(messages);
  });

  // Add message to conversation
  app.post('/api/conversations/:id/messages', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const { role, content, toolCalls, thinkingContent } = req.body;

    if (!role) {
      return res.status(400).json({ error: 'role is required' });
    }

    // Allow empty content if there are tool calls (AI might only use tools without text response)
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    if (!content && !hasToolCalls) {
      return res.status(400).json({ error: 'content is required (unless toolCalls are provided)' });
    }

    if (!['user', 'assistant', 'system'].includes(role)) {
      return res.status(400).json({ error: 'role must be user, assistant, or system' });
    }

    const conversation = getConversation(id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    try {
      const message = addMessage(id, role, content, toolCalls, thinkingContent);
      res.json(message);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: MCP server over HTTP/SSE
  app.get('/api/mcp/status', (_req: Request, res: Response) => {
    res.json({
      running: mcpServerHandle != null,
      url: mcpServerHandle?.url,
      port: mcpServerHandle?.port,
      packIds: mcpServerPackIds,
    });
  });

  app.post('/api/mcp/start', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (mcpServerHandle != null) {
      return res.status(409).json({
        error: 'MCP server already running',
        url: mcpServerHandle.url,
        port: mcpServerHandle.port,
      });
    }
    const { packIds, port: requestedPort } = req.body as { packIds?: string[]; port?: number };
    if (!Array.isArray(packIds) || packIds.length === 0) {
      return res.status(400).json({ error: 'packIds must be a non-empty array' });
    }
    // Re-discover packs to include any newly created packs
    const currentPacks = await discoverPacks({ directories: packDirs });
    const selectedPacks = currentPacks.filter((d) => packIds.includes(d.pack.metadata.id));
    if (selectedPacks.length === 0) {
      return res.status(400).json({ error: 'No valid pack IDs found' });
    }
    const port = typeof requestedPort === 'number' && requestedPort > 0 ? requestedPort : MCP_DEFAULT_PORT;
    try {
      const handle = await createMCPServerOverHTTP({
        packs: selectedPacks,
        baseRunDir: resolvedBaseRunDir,
        concurrency: 1,
        headful,
        port,
        host: host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
        // Track MCP runs in the dashboard database
        onRunStart: (info: MCPRunStartInfo) => {
          const run = runManager.addRunAndGet(info.packId, info.packName, 'mcp');
          // Store the mapping from MCP runId to DB runId for later lookup
          mcpRunIdMap.set(info.runId, run.runId);
          runManager.updateRun(run.runId, {
            status: 'running',
            startedAt: Date.now(),
            runDir: info.runDir,
          });
          io.emit('runs:list', runManager.getAllRuns());
          console.log(`[MCP] Run started: ${info.runId} -> ${run.runId} (pack: ${info.packId})`);
        },
        onRunComplete: (info: MCPRunCompleteInfo) => {
          const dbRunId = mcpRunIdMap.get(info.runId);
          if (dbRunId) {
            const updates: Partial<RunInfo> = {
              status: info.success ? 'success' : 'failed',
              finishedAt: Date.now(),
            };
            if (info.error) {
              updates.error = info.error;
            }
            if (info.collectibles) {
              updates.collectibles = info.collectibles;
            }
            if (info.durationMs !== undefined) {
              updates.durationMs = info.durationMs;
            }
            runManager.updateRun(dbRunId, updates);
            mcpRunIdMap.delete(info.runId);
            io.emit('runs:list', runManager.getAllRuns());
            console.log(`[MCP] Run completed: ${info.runId} (success: ${info.success})`);
          }
        },
      });
      mcpServerHandle = handle;
      mcpServerPackIds = packIds;
      console.log(`[Dashboard] MCP server started at ${handle.url} with ${selectedPacks.length} pack(s)`);
      res.json({
        url: handle.url,
        port: handle.port,
        packIds,
        message: `MCP server running. Connect via Streamable HTTP (POST/GET) at ${handle.url}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Dashboard] MCP server start failed:', message);
      res.status(500).json({ error: 'Failed to start MCP server', details: message });
    }
  });

  app.post('/api/mcp/stop', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (mcpServerHandle == null) {
      return res.status(404).json({ error: 'MCP server is not running' });
    }
    try {
      await mcpServerHandle.close();
      const url = mcpServerHandle.url;
      const packIds = [...mcpServerPackIds];
      mcpServerHandle = null;
      mcpServerPackIds = [];
      console.log('[Dashboard] MCP server stopped');
      res.json({ stopped: true, url, packIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to stop MCP server', details: message });
    }
  });

  // Helper: Check authentication token
  function requireToken(req: Request): boolean {
    const token = req.headers['x-mcpify-token'];
    return token === sessionToken;
  }

  // Helper: Find pack by ID
  function findPackById(packId: string): { pack: TaskPack; path: string } | null {
    return packMap.get(packId) || null;
  }

  // REST API: Create new JSON pack
  app.post('/api/packs', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!resolvedWorkspaceDir) {
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
    if (packMap.has(id)) {
      return res.status(409).json({ error: `Pack with ID "${id}" already exists` });
    }

    // Sanitize and create directory
    const sanitizedId = sanitizePackId(id);
    const packDir = resolve(resolvedWorkspaceDir, sanitizedId);

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
      discoverPacks({ directories: packDirs }).then((newPacks) => {
        for (const { pack, path } of newPacks) {
          if (!packMap.has(pack.metadata.id)) {
            packMap.set(pack.metadata.id, { pack, path });
          }
        }
        io.emit('packs:updated', packMap.size);
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
  app.get('/api/packs/:packId/files', async (req: Request, res: Response) => {
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
        details: error instanceof Error ? error.message : String(error)
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

  // REST API: Update pack metadata
  app.put('/api/packs/:packId/meta', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Validate path is in workspace
    if (resolvedWorkspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, resolvedWorkspaceDir);
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
      packMap.set(packId, { pack: reloaded, path: packInfo.path });

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
  app.put('/api/packs/:packId/flow', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Validate path is in workspace
    if (resolvedWorkspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, resolvedWorkspaceDir);
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
      packMap.set(packId, { pack: reloaded, path: packInfo.path });

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

  // REST API: Get secrets for a pack (names only, no values)
  app.get('/api/packs/:packId/secrets', (req: Request, res: Response) => {
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
  app.put('/api/packs/:packId/secrets/:secretName', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId, secretName } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Validate path is in workspace
    if (resolvedWorkspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, resolvedWorkspaceDir);
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
  app.delete('/api/packs/:packId/secrets/:secretName', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId, secretName } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Validate path is in workspace
    if (resolvedWorkspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, resolvedWorkspaceDir);
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
  app.put('/api/packs/:packId/secrets-schema', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId } = req.params;
    const packInfo = findPackById(packId);

    if (!packInfo) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Validate path is in workspace
    if (resolvedWorkspaceDir) {
      try {
        validatePathInAllowedDir(packInfo.path, resolvedWorkspaceDir);
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

  // Initialize LLM provider for Teach Mode (lazy, only if OPENAI_API_KEY is set)
  let llmProvider: ReturnType<typeof createLlmProvider> | null = null;
  try {
    llmProvider = createLlmProvider();
    console.log('[Dashboard] LLM provider initialized for Teach Mode');
  } catch (error) {
    console.warn('[Dashboard] LLM provider not available (OPENAI_API_KEY not set)');
  }

  // REST API: Propose step (Teach Mode)
  app.post('/api/teach/propose-step', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!llmProvider) {
      return res.status(503).json({ error: 'LLM provider not configured (OPENAI_API_KEY required)' });
    }

    const request = req.body as ProposeStepRequest;

    if (!request.packId || !request.userIntent || !request.elementFingerprint) {
      return res.status(400).json({ error: 'packId, userIntent, and elementFingerprint are required' });
    }

    // Verify pack exists and is JSON-DSL
    const packInfo = findPackById(request.packId);
    if (!packInfo) {
      return res.status(404).json({ error: `Pack not found: ${request.packId}` });
    }

    try {
      const manifest = TaskPackLoader.loadManifest(packInfo.path);
      if (manifest.kind !== 'json-dsl') {
        return res.status(400).json({ error: 'Pack is not a JSON-DSL pack' });
      }
    } catch {
      return res.status(400).json({ error: 'Pack is not a JSON-DSL pack' });
    }

    try {
      const proposal = await proposeStep(llmProvider, request);
      res.json(proposal);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // System prompt for Teach Mode flow-writing chat: env > TEACH_MODE_SYSTEM_PROMPT.md file > inline default
  // Supports two modes:
  // 1. AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md - Full autonomous exploration & roadmap system
  // 2. TEACH_MODE_SYSTEM_PROMPT.md - Original reactive step proposal system
  let TEACH_CHAT_SYSTEM_PROMPT = process.env.TEACH_CHAT_SYSTEM_PROMPT;
  if (!TEACH_CHAT_SYSTEM_PROMPT) {
    // Try autonomous exploration prompt first (preferred for agent mode)
    // __dirname is packages/dashboard/dist, so ../../../ goes to repo root
    const explorationPromptPath =
      process.env.AUTONOMOUS_EXPLORATION_PROMPT_PATH ||
      resolve(process.cwd(), 'AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md');
    const explorationAltPath = resolve(__dirname, '../../../AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md');

    // Fall back to teach mode prompt
    const teachPromptPath =
      process.env.TEACH_MODE_SYSTEM_PROMPT_PATH ||
      resolve(process.cwd(), 'TEACH_MODE_SYSTEM_PROMPT.md');
    const teachAltPath = resolve(__dirname, '../../../TEACH_MODE_SYSTEM_PROMPT.md');

    // Priority: exploration prompt > teach mode prompt > inline default
    const explorationPath = existsSync(explorationPromptPath) ? explorationPromptPath
      : existsSync(explorationAltPath) ? explorationAltPath
      : null;
    const teachPath = existsSync(teachPromptPath) ? teachPromptPath
      : existsSync(teachAltPath) ? teachAltPath
      : null;

    // Use exploration prompt if available, otherwise fall back to teach mode prompt
    const pathToLoad = explorationPath ?? teachPath;

    if (pathToLoad) {
      try {
        TEACH_CHAT_SYSTEM_PROMPT = readFileSync(pathToLoad, 'utf-8').trim();
        console.log(`[Dashboard] System prompt loaded from ${pathToLoad}`);
      } catch (e) {
        console.warn('[Dashboard] Failed to load system prompt:', e);
      }
    }
    if (!TEACH_CHAT_SYSTEM_PROMPT) {
      console.error('[Dashboard] ERROR: No system prompt found. Create AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md in the project root.');
      console.error('[Dashboard] The agent will not work correctly without a system prompt.');
      TEACH_CHAT_SYSTEM_PROMPT = 'System prompt not configured. Please create AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md in the project root.';
    }
  }

  // REST API: Teach Mode chat (AI flow-writing assistant)
  app.post('/api/teach/chat', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!llmProvider) {
      return res.status(503).json({ error: 'LLM provider not configured (OPENAI_API_KEY required)' });
    }

    const { messages, systemPromptOverride, packId } = req.body as {
      messages: ChatMessage[];
      systemPromptOverride?: string;
      packId?: string;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required and must not be empty' });
    }

    let systemPrompt = systemPromptOverride ?? TEACH_CHAT_SYSTEM_PROMPT;
    if (packId) {
      const packInfo = findPackById(packId);
      if (packInfo) {
        try {
          const { flowJson } = await taskPackEditor.readPack(packId);
          const flowSummary = `Current pack "${packId}" flow: ${JSON.stringify(flowJson, null, 2).slice(0, 2000)}`;
          systemPrompt = `${systemPrompt}\n\n${flowSummary}`;
        } catch {
          // ignore
        }
      }
    }

    try {
      const reply = await llmProvider.chat({
        systemPrompt,
        messages,
      });
      res.json({ reply });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Action-first system addon: agent MUST use tools, never passive advice
  const TEACH_AGENT_ACTION_FIRST =
    `\n\nTEACH MODE AGENT RULES (MANDATORY):
- You MUST use tools. Editor MCP and Browser MCP are ALWAYS available. Tool calls are expected, not optional.
- PACK CREATION WORKFLOW:
  - If packId IS provided (a pack is already linked to this conversation): DO NOT create a new pack. Use the existing pack. FIRST call editor_read_pack(packId) to see current state, then use editor_apply_flow_patch to make changes.
  - Only create a new pack when NO packId is provided (packId is null/undefined). In that case:
    1. First call editor_create_pack with a unique id (e.g., "mycompany.sitename.collector"), name, and description
    2. Then call conversation_link_pack with the new packId to associate it with this conversation
    3. Then use editor_apply_flow_patch to add steps to the flow
    4. Use editor_run_pack to test the flow
  - IMPORTANT: Once a pack is linked to a conversation, ALL subsequent messages in that conversation should edit that same pack. Never create a second pack unless the user explicitly asks for a new/different one.
- If the user asks to create a flow, add a step, or extract data: propose a DSL step and apply it via editor_apply_flow_patch. One step per patch; multiple steps = multiple patches in sequence. Supported step types include navigate, click, fill, extract_text, extract_attribute, wait_for, set_var, and network_find, network_replay, network_extract (for API-first flows: find a captured request, replay it with overrides, optionally extract from the response). Steps can include an optional "once" field ("session" or "profile") to mark them as run-once steps that are skipped on subsequent runs when auth is still valid (useful for login/setup steps).
- When the user asks to execute/run the flow in the browser or to run the steps in the open browser: use browser_* tools (browser_goto, browser_click, browser_type, etc.) to perform the steps. Do NOT use editor_run_pack for this—editor_run_pack runs the pack in a separate run, not in the current browser session.
- When the user asks you to CLICK a link or button (e.g. "click the Sign in link"): use browser_click with linkText and role "link" or "button". For batch names, filter options, tabs, or list items (e.g. "Winter 2026", "Spring 2026") that are not <a> or <button>, use browser_click with linkText and role "text".
- To understand page structure: use browser_get_dom_snapshot (returns interactive elements, forms, headings, navigation with target hints). Prefer it for exploration—it's text-based, cheap, and provides element targets for step proposals.
- To find which links are on the page: use browser_get_links (returns href and visible text for each link). Prefer it over screenshot when you need to choose or click a link; it is cheaper and accurate.
- For visual layout context (images, complex UI): use browser_screenshot. The image will be attached for analysis. Use sparingly—only when visual layout matters.
- You HAVE network inspection tools: browser_network_list, browser_network_search, browser_network_get, browser_network_get_response. Use them when the user wants to inspect a request, capture an API call, or provides a request ID from the Network list. Do NOT say that "the task pack does not support network operations" or suggest "manual extraction from the page" instead—use the network tools to inspect requests and browser tools (click, type, extract_text, etc.) as appropriate.
- When the user provides a request ID (e.g. "use request req-123" or pastes an id from the Network list): call browser_network_get(sessionId, requestId) to get metadata (no response body). If you need the response body, call browser_network_get_response(sessionId, requestId, full?) next.
- When the user asks for a request by description (e.g. "the company request") and did not give an id: use browser_network_search with a query substring (e.g. "companies", "api/") to find matching entries, then browser_network_get for the one they want.
- When you need page context (e.g. user asks "what page am I on?", "what buttons do you see?", "look at the page"): prefer browser_get_dom_snapshot for structure; use browser_screenshot only when visual layout is needed. Do NOT attach screenshots automatically for every message—only when explicitly needed.
- For element context (e.g. to add a step to the flow): use browser_get_dom_snapshot to get element targets; optionally use browser_get_links for navigation. Do NOT ask the user to describe the page.
- Prefer action over explanation. Explanations are optional; tool usage is mandatory when relevant.
- Never reply with generic "here is what you can do" without calling tools. Always read_pack, apply_flow_patch, or use browser tools as needed.
- Never refuse to use network tools or suggest manual extraction instead; use browser_network_* when the user cares about a request, and use browser_click/browser_type/extract steps for page interaction.
- When the user wants to add "capture this request" or "replay this API" to the flow: propose network_find (where, pick, saveAs) then network_replay (requestId from vars, overrides, auth: browser_context, out, response.as). Use network_extract when extracting from a replayed response stored in vars.
- Templating: step params use Nunjucks. Use {{inputs.x}} and {{vars.x}}; for values that go in URLs (e.g. urlReplace.replace, setQuery, fill) use the urlencode filter: {{ inputs.x | urlencode }}.
- If a tool call returns an error: do NOT retry the same call. Reply to the user with the error message and suggest a different action or ask them to fix the issue. One retry at most; then stop and respond.
- CONVERSATION MANAGEMENT: Use conversation_update_title to set a concise title (e.g., "Gmail Email Scraper") after the first user message. Use conversation_update_description to update progress (e.g., "Creating login flow"). Use conversation_set_status("ready") when the flow is complete and working. Use conversation_link_pack to associate a packId with this conversation.`;

  // REST API: Teach Mode agent (MCPs ALWAYS ON – action-first)
  // MAX_NON_EDITOR_ITERATIONS: limits consecutive browser-only rounds (set to 0 to disable)
  const MAX_NON_EDITOR_ITERATIONS = parseInt(process.env.AGENT_MAX_BROWSER_ROUNDS || '0', 10);
  const MAX_TOTAL_ITERATIONS = 100; // Absolute safety cap
  app.post('/api/teach/agent', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!llmProvider || typeof (llmProvider as any).chatWithTools !== 'function') {
      return res.status(503).json({ error: 'LLM provider with tool support not configured' });
    }

    const { messages, packId, browserSessionId, conversationId, stream: streamFlowUpdates } = req.body as {
      messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; name?: string }>;
      packId?: string | null;
      browserSessionId?: string | null;
      conversationId?: string | null;
      /** If true, stream flow_updated after each editor_apply_flow_patch so the UI can update in real time */
      stream?: boolean;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required and must not be empty' });
    }

    let systemPrompt = TEACH_CHAT_SYSTEM_PROMPT + TEACH_AGENT_ACTION_FIRST;
    if (packId) {
      systemPrompt = `${systemPrompt}\n\npackId for this session: ${packId}. You MUST call editor.read_pack with this packId before proposing flow changes.`;
    }
    if (browserSessionId) {
      systemPrompt = `${systemPrompt}\n\nCurrent browser sessionId (use browser_goto, browser_go_back, browser_type, browser_screenshot, browser_get_links, browser_get_dom_snapshot, browser_click, browser_network_list, browser_network_search, browser_network_get, browser_network_get_response, browser_network_replay, browser_last_actions): ${browserSessionId}`;
    }

    type ContentPart =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } };
    type AgentMsg =
      | { role: 'user'; content: string | ContentPart[] }
      | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
      | { role: 'tool'; content: string; tool_call_id: string };

    let agentMessages: AgentMsg[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    let lastBrowserSessionId: string | null = browserSessionId ?? null;
    const toolTrace: Array<{ tool: string; args: Record<string, unknown>; result: unknown; success: boolean }> = [];
    let updatedFlow: unknown = undefined;
    let validation: { ok: boolean; errors: string[]; warnings: string[] } | undefined = undefined;
    let browserResponse:
      | { screenshotBase64?: string; mimeType?: string; url?: string; screenshotSentAt?: number }
      | undefined = undefined;

    let nonEditorRounds = 0;
    // Enable streaming whenever client requests it (stream: true)
    const streamFlow = !!streamFlowUpdates;
    if (streamFlow) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders?.();
    }

    // Track if request was aborted by client (stop button pressed)
    let aborted = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
        console.log('[Agent] Request aborted by client (stop button)');
      }
    });

    const writeStreamLine = (obj: object) => {
      if (streamFlow && !aborted) res.write(JSON.stringify(obj) + '\n');
    };

    // Check if provider supports streaming
    const supportsStreaming = typeof (llmProvider as any).chatWithToolsStream === 'function';

    // Session key for plan storage
    const sessionKey = packId || `session_${Date.now()}`;

    // Helper to call LLM with or without streaming (uses agentMessages which may be modified by summarization)
    async function callLlm(currentMessages: AgentMsg[]): Promise<ChatWithToolsResult> {
      if (supportsStreaming && streamFlow) {
        const generator = (llmProvider as any).chatWithToolsStream({
          systemPrompt,
          messages: currentMessages,
          tools: MCP_AGENT_TOOL_DEFINITIONS,
          enableThinking: true,
        }) as AsyncGenerator<StreamEvent, ChatWithToolsResult, unknown>;

        let iterResult = await generator.next();
        while (!iterResult.done) {
          const event = iterResult.value as StreamEvent;
          // Forward streaming events to client
          writeStreamLine(event);
          iterResult = await generator.next();
        }
        return iterResult.value;
      } else {
        return await (llmProvider as any).chatWithTools({
          systemPrompt,
          messages: currentMessages,
          tools: MCP_AGENT_TOOL_DEFINITIONS,
        });
      }
    }

    try {
      for (let iter = 0; iter < MAX_TOTAL_ITERATIONS; iter++) {
        // Check if client aborted (stop button pressed)
        if (aborted) {
          console.log('[Agent] Stopping agent loop - client aborted');
          if (streamFlow) {
            writeStreamLine({ type: 'done', error: 'Stopped by user' });
            res.end();
          }
          return;
        }

        // Check token count and summarize if needed
        const tokenEstimate = estimateTotalTokens(systemPrompt, agentMessages);
        if (tokenEstimate > 100_000) {
          console.log(`[Agent] Token estimate ${tokenEstimate} exceeds threshold, attempting summarization...`);
          writeStreamLine({ type: 'summarizing', tokensBefore: tokenEstimate });
          try {
            const summaryResult = await summarizeIfNeeded(
              systemPrompt,
              agentMessages,
              llmProvider!,
              sessionKey
            );
            if (summaryResult.wasSummarized) {
              agentMessages = summaryResult.messages;
              console.log(`[Agent] Summarized: ${summaryResult.tokensBefore} -> ${summaryResult.tokensAfter} tokens`);
              writeStreamLine({
                type: 'summarized',
                tokensBefore: summaryResult.tokensBefore,
                tokensAfter: summaryResult.tokensAfter,
              });
            }
          } catch (summaryError) {
            console.error('[Agent] Summarization failed:', summaryError);
            // Continue anyway, the API will fail if truly over limit
          }
        }

        const result = await callLlm(agentMessages);

        if (result.toolCalls && result.toolCalls.length > 0) {
          // Track consecutive browser-only rounds (only enforce if limit > 0)
          const hasNonEditorCall = result.toolCalls.some((tc: { name: string }) => tc.name.startsWith('browser_'));
          if (hasNonEditorCall) {
            nonEditorRounds++;
            if (MAX_NON_EDITOR_ITERATIONS > 0 && nonEditorRounds >= MAX_NON_EDITOR_ITERATIONS) {
              if (streamFlow) {
                writeStreamLine({ type: 'done', error: 'Agent exceeded max browser iterations' });
                res.end();
              } else {
                res.status(500).json({ error: 'Agent exceeded max browser iterations' });
              }
              return;
            }
          }

          agentMessages.push({
            role: 'assistant',
            content: result.content ?? null,
            tool_calls: result.toolCalls,
          });
          const ctx: AgentToolContext = {
            taskPackEditor,
            browserSessionId: lastBrowserSessionId,
            packId: packId ?? null,
            sessionKey,
            conversationId: conversationId ?? null,
          };
          for (const tc of result.toolCalls) {
            let toolArgs: Record<string, unknown> = {};
            try {
              toolArgs = JSON.parse(tc.arguments || '{}');
            } catch {
              // ignore
            }

            // Emit tool_start event before executing the tool
            writeStreamLine({ type: 'tool_start', tool: tc.name, args: toolArgs });

            const execResult = await executeAgentTool(tc.name, toolArgs, ctx);
            const resultStr = execResult.stringForLlm;
            let resultParsed: unknown;
            try {
              resultParsed = JSON.parse(resultStr);
            } catch {
              resultParsed = resultStr;
            }
            const success = !(resultParsed && typeof resultParsed === 'object' && 'error' in resultParsed);
            toolTrace.push({ tool: tc.name, args: toolArgs, result: resultParsed, success });

            // Emit conversation updates when conversation_* tools are called
            if (tc.name.startsWith('conversation_') && success && conversationId) {
              io.emit('conversations:updated', getAllConversations());
            }

            // Emit packs:updated when a new pack is created
            if (tc.name === 'editor_create_pack' && success) {
              // Re-discover packs and update packMap
              discoverPacks({ directories: packDirs }).then((newPacks) => {
                packMap.clear();
                for (const { pack, path } of newPacks) {
                  packMap.set(pack.metadata.id, { pack, path });
                }
                io.emit('packs:updated', packMap.size);
              });
            }

            // Emit tool_result event after executing the tool
            writeStreamLine({ type: 'tool_result', tool: tc.name, args: toolArgs, result: resultParsed, success });

            // Check for abort after each tool execution
            if (aborted) {
              console.log('[Agent] Stopping mid-tool-loop - client aborted');
              if (streamFlow) {
                writeStreamLine({ type: 'done', error: 'Stopped by user' });
                res.end();
              }
              return;
            }

            if (tc.name === 'browser_start_session') {
              try {
                const parsed = resultParsed as { sessionId?: string };
                if (parsed?.sessionId) lastBrowserSessionId = parsed.sessionId;
              } catch {
                // ignore
              }
            }
            if (execResult.browserSnapshot) {
              browserResponse = {
                screenshotBase64: execResult.browserSnapshot.screenshotBase64,
                mimeType: execResult.browserSnapshot.mimeType,
                url: execResult.browserSnapshot.url,
              };
            }
            if (tc.name === 'editor_apply_flow_patch' && packId) {
              try {
                const { flowJson } = await taskPackEditor.readPack(packId);
                updatedFlow = flowJson;
                const val = await taskPackEditor.validateFlow(JSON.stringify(flowJson));
                validation = { ok: val.ok, errors: val.errors, warnings: val.warnings };
                writeStreamLine({ type: 'flow_updated', flow: flowJson, validation: val });
              } catch {
                // ignore
              }
            }

            agentMessages.push({ role: 'tool', content: resultStr, tool_call_id: tc.id });
          }
          // Redaction guard: attach screenshot to LLM only when agent explicitly requested it (browser_screenshot was called)
          if (browserResponse?.screenshotBase64 && browserResponse?.mimeType) {
            const dataUrl = `data:${browserResponse.mimeType};base64,${browserResponse.screenshotBase64}`;
            agentMessages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Screenshot attached for analysis. Analyze the page and answer the user.',
                },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            });
            browserResponse.screenshotSentAt = Date.now();
          }
          continue;
        }

        if (streamFlow) {
          writeStreamLine({
            type: 'done',
            assistantMessage: { role: 'assistant' as const, content: result.content ?? '' },
            toolTrace,
            ...(updatedFlow !== undefined && { updatedFlow }),
            ...(validation !== undefined && { validation }),
            ...(browserResponse !== undefined && { browser: browserResponse }),
            browserSessionId: lastBrowserSessionId ?? undefined,
          });
          res.end();
        } else {
          res.json({
            assistantMessage: { role: 'assistant' as const, content: result.content ?? '' },
            toolTrace,
            ...(updatedFlow !== undefined && { updatedFlow }),
            ...(validation !== undefined && { validation }),
            ...(browserResponse !== undefined && { browser: browserResponse }),
            browserSessionId: lastBrowserSessionId ?? undefined,
          });
        }
        return;
      }

      if (streamFlow) {
        writeStreamLine({ type: 'done', error: 'Agent exceeded max iterations' });
        res.end();
      } else {
        res.status(500).json({ error: 'Agent exceeded max iterations' });
      }
    } catch (error) {
      if (streamFlow) {
        writeStreamLine({ type: 'done', error: error instanceof Error ? error.message : String(error) });
        res.end();
      } else {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  // REST API: Apply flow patch (Teach Mode)
  app.post('/api/teach/apply-patch', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { packId, patch } = req.body;

    if (!packId || !patch) {
      return res.status(400).json({ error: 'packId and patch are required' });
    }

    try {
      const result = await taskPackEditor.applyFlowPatch(packId, patch);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Start session
  app.post('/api/teach/browser/start', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { headful } = req.body;

    try {
      const sessionId = await startBrowserSession(headful !== false);
      res.json({ sessionId });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Goto URL
  app.post('/api/teach/browser/goto', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId, url } = req.body;

    if (!sessionId || !url) {
      return res.status(400).json({ error: 'sessionId and url are required' });
    }

    try {
      const currentUrl = await gotoUrl(sessionId, url);
      res.json({ url: currentUrl });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Go back
  app.post('/api/teach/browser/go-back', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await goBack(sessionId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Type in element
  app.post('/api/teach/browser/type', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId, text, label, selector, clear } = req.body;

    if (!sessionId || text === undefined) {
      return res.status(400).json({ error: 'sessionId and text are required' });
    }
    if (!label && !selector) {
      return res.status(400).json({ error: 'label or selector is required' });
    }

    try {
      const result = await typeInElement(sessionId, {
        text,
        label: label ?? undefined,
        selector: selector ?? undefined,
        clear: clear !== false,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Screenshot
  app.post('/api/teach/browser/screenshot', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await takeScreenshot(sessionId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Get links
  app.post('/api/teach/browser/get-links', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await getLinks(sessionId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Get DOM snapshot
  app.post('/api/teach/browser/dom-snapshot', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId, format, maxDepth } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await getDomSnapshot(sessionId, { format, maxDepth });
      // For YAML format, wrap the snapshot string in an object for consistency
      if (format === 'yaml' || (!format && 'snapshot' in result)) {
        res.json(result);
      } else {
        res.json(result);
      }
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network list
  app.post('/api/teach/browser/network-list', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, limit, filter, compact } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    try {
      // UI endpoint: default to 'all' filter and non-compact (full headers) for debugging
      const list = networkList(sessionId, {
        limit: limit ?? 50,
        filter: filter ?? 'all',
        compact: compact ?? false,
      });
      res.json(list);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network search
  app.post('/api/teach/browser/network-search', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, query, limit } = req.body;
    if (!sessionId || query == null) {
      return res.status(400).json({ error: 'sessionId and query are required' });
    }
    try {
      const list = networkSearch(sessionId, String(query).trim(), limit ?? 20);
      res.json(list);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network get
  app.post('/api/teach/browser/network-get', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, requestId } = req.body;
    if (!sessionId || !requestId) {
      return res.status(400).json({ error: 'sessionId and requestId are required' });
    }
    try {
      const result = networkGet(sessionId, requestId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network get response body
  app.post('/api/teach/browser/network-get-response', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, requestId, full } = req.body;
    if (!sessionId || !requestId) {
      return res.status(400).json({ error: 'sessionId and requestId are required' });
    }
    try {
      const result = networkGetResponse(sessionId, requestId, full === true);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network replay
  app.post('/api/teach/browser/network-replay', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, requestId, overrides } = req.body;
    if (!sessionId || !requestId) {
      return res.status(400).json({ error: 'sessionId and requestId are required' });
    }
    try {
      const result = await networkReplay(sessionId, requestId, overrides);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network clear
  app.post('/api/teach/browser/network-clear', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    try {
      networkClear(sessionId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Last actions
  app.get('/api/teach/browser/:sessionId/actions', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit as string) || 10;

    try {
      const actions = getLastActions(sessionId, limit);
      res.json(actions);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Close session
  app.delete('/api/teach/browser/:sessionId', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.params;

    try {
      await closeSession(sessionId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Validate pack without saving
  app.post('/api/packs/:packId/validate', (req: Request, res: Response) => {
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

  // Socket.IO: Handle connections
  io.on('connection', (socket) => {
    console.log(`[Dashboard] Client connected: ${socket.id}`);

    // Send initial runs list
    socket.emit('runs:list', runManager.getAllRuns());

    socket.on('disconnect', () => {
      console.log(`[Dashboard] Client disconnected: ${socket.id}`);
    });
  });

  // Fallback to index.html for SPA routing (must be after all API routes)
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(resolve(uiPath, 'index.html'));
  });

  // Start server
  httpServer.listen(port, host, () => {
    console.log(`[Dashboard] Server running at http://${host}:${port}`);
    console.log(`[Dashboard] Session token: ${sessionToken.substring(0, 8)}...`);
    console.log(`[Dashboard] Open http://${host}:${port} in your browser`);
  });
}
