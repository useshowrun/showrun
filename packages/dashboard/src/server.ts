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

/**
 * Find UI assets directory, checking multiple locations for bundled/dev setups
 */
function findUiPath(): string {
  const candidates = [
    resolve(__dirname, 'ui'),           // Same directory (bundled or dev)
    resolve(__dirname, '../dist/ui'),   // Parent dist (when running from src)
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'index.html'))) {
      return candidate;
    }
  }
  // Fallback to first candidate
  return candidates[0];
}

import { discoverPacks, ConcurrencyLimiter } from '@showrun/mcp-server';
import { ensureDir, resolveFilePath, ensureSystemPromptInConfigDir } from '@showrun/core';
import { RunManager } from './runManager.js';
import { initDatabase } from './db.js';
import { createLlmProvider } from './llm/index.js';
import { TaskPackEditorWrapper } from './mcpWrappers.js';
import type { DashboardContext, PendingSecretsRequest } from './types/context.js';
import {
  createConfigRouter,
  createRunsRouter,
  createConversationsRouter,
  createPacksRouter,
  createSecretsRouter,
  createMcpRouter,
  createBrowserRouter,
  createTeachRouter,
} from './routes/index.js';

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
 * Load system prompt from file or environment.
 *
 * Priority:
 *   1. TEACH_CHAT_SYSTEM_PROMPT env var (inline text)
 *   2. resolveFilePath('AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md') — config dirs, cwd, ancestors
 *   3. resolveFilePath('TEACH_MODE_SYSTEM_PROMPT.md') — fallback prompt
 *   4. Error message suggesting `showrun config init`
 */
function loadSystemPrompt(): string {
  // 1. Env var takes top priority
  const envPrompt = process.env.TEACH_CHAT_SYSTEM_PROMPT;
  if (envPrompt) return envPrompt;

  // 2. Search for autonomous exploration prompt via config system
  const explorationFilename = 'AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md';
  const teachFilename = 'TEACH_MODE_SYSTEM_PROMPT.md';

  const pathToLoad = resolveFilePath(explorationFilename) ?? resolveFilePath(teachFilename);

  if (pathToLoad) {
    try {
      const content = readFileSync(pathToLoad, 'utf-8').trim();
      console.log(`[Dashboard] System prompt loaded from ${pathToLoad}`);

      // Auto-copy to config dir for future use from other directories
      const loadedFilename = pathToLoad.endsWith(explorationFilename)
        ? explorationFilename
        : teachFilename;
      try {
        ensureSystemPromptInConfigDir(loadedFilename, pathToLoad);
      } catch {
        // Non-fatal — prompt is already loaded, copy is just a convenience
      }

      return content;
    } catch (e) {
      console.warn('[Dashboard] Failed to load system prompt:', e);
    }
  }

  // 4. Nothing found
  console.error('[Dashboard] ERROR: No system prompt found.');
  console.error('[Dashboard] Run `showrun config init` to set up configuration, or create AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md in the project root.');
  return 'System prompt not configured. Run `showrun config init` or create AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md in the project root.';
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
    console.warn('[Dashboard] No task packs found.');
  }

  // Create pack map for quick lookup
  const packMap = new Map<string, { pack: import('@showrun/core').TaskPack; path: string }>();
  for (const { pack, path } of discoveredPacks) {
    packMap.set(pack.metadata.id, { pack, path });
  }

  // Create run manager
  const runManager = new RunManager();
  const concurrencyLimiter = new ConcurrencyLimiter(1);

  // Create TaskPack Editor wrapper
  const taskPackEditor = new TaskPackEditorWrapper(
    packDirs,
    resolvedWorkspaceDir || packDirs[0],
    resolvedBaseRunDir,
    headful
  );

  // Initialize LLM provider for Teach Mode (lazy, only if OPENAI_API_KEY is set)
  let llmProvider: ReturnType<typeof createLlmProvider> | null = null;
  try {
    llmProvider = createLlmProvider();
    console.log('[Dashboard] LLM provider initialized for Teach Mode');
  } catch {
    console.warn('[Dashboard] LLM provider not available (OPENAI_API_KEY not set)');
  }

  // Load system prompt
  const systemPrompt = loadSystemPrompt();

  // Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static UI files (built by Vite)
  const uiPath = findUiPath();
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

  // Pending secrets requests - maps conversationId to resolve function
  const pendingSecretsRequests = new Map<string, PendingSecretsRequest>();

  // Create shared dashboard context
  const ctx: DashboardContext = {
    sessionToken,
    packDirs,
    workspaceDir: resolvedWorkspaceDir,
    baseRunDir: resolvedBaseRunDir,
    headful,
    packMap,
    runManager,
    concurrencyLimiter,
    mcpServer: {
      handle: null,
      packIds: [],
      runIdMap: new Map(),
    },
    io,
    taskPackEditor,
    llmProvider,
    systemPrompt,
    pendingSecretsRequests,
  };

  // Mount route modules
  app.use(createConfigRouter(ctx));
  app.use(createRunsRouter(ctx));
  app.use(createConversationsRouter(ctx));
  app.use(createPacksRouter(ctx));
  app.use(createSecretsRouter(ctx));
  app.use(createMcpRouter(ctx));
  app.use(createBrowserRouter(ctx));
  app.use(createTeachRouter(ctx));

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
