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
import { ensureDir } from '@showrun/core';
import type { ResultStoreProvider } from '@showrun/core';
import { SQLiteResultStore } from '@showrun/harness';
import { RunManager } from './runManager.js';
import { FALLBACK_SYSTEM_PROMPT } from './fallbackPrompt.js';
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
  createTechniquesRouter,
  createRegistryRouter,
} from './routes/index.js';
import { TechniqueManager, WeaviateVectorStore } from '@showrun/techniques';
import type { VectorStoreConfig } from '@showrun/techniques';

export interface DashboardOptions {
  packs: string[];
  port: number;
  host?: string;
  headful: boolean;
  baseRunDir: string;
  workspaceDir?: string; // Writable directory for JSON pack creation/editing
  dataDir?: string; // Database directory (default: ./data)
  debug?: boolean; // Enable debug logging (failed tool calls, etc.)
  transcriptLogging?: boolean; // Enable full conversation transcript logging
}

/**
 * Load the fallback system prompt.
 *
 * When the Techniques DB is available, the prompt is assembled dynamically
 * from DB techniques by promptAssembler.ts (at request time in teach.ts).
 * This fallback is used when the DB is unavailable.
 *
 * Priority:
 *   1. TEACH_CHAT_SYSTEM_PROMPT env var (inline text override)
 *   2. EXPLORATION_AGENT_PROMPT_PATH env var (file path override)
 *   3. Built-in FALLBACK_SYSTEM_PROMPT constant
 */
function loadSystemPrompt(): string {
  // Env var override: inline text
  const envPrompt = process.env.TEACH_CHAT_SYSTEM_PROMPT;
  if (envPrompt) return envPrompt;

  // Env var override: file path
  const envPath = process.env.EXPLORATION_AGENT_PROMPT_PATH;
  if (envPath && existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf-8').trim();
      console.log(`[Dashboard] System prompt loaded from ${envPath}`);
      return content;
    } catch (e) {
      console.warn('[Dashboard] Failed to load system prompt from EXPLORATION_AGENT_PROMPT_PATH:', e);
    }
  }

  console.log('[Dashboard] Using built-in fallback system prompt');
  return FALLBACK_SYSTEM_PROMPT;
}

/**
 * Starts the dashboard server
 */
export async function startDashboard(options: DashboardOptions): Promise<void> {
  const { packs: packDirs, port, host = '127.0.0.1', headful, baseRunDir, workspaceDir, dataDir = './data' } = options;
  // --debug flag takes priority, then SHOWRUN_DEBUG env/config
  const debug = options.debug || process.env.SHOWRUN_DEBUG === 'true';
  // --transcript-logging flag takes priority, then SHOWRUN_TRANSCRIPT_LOGGING env/config
  const transcriptLogging = options.transcriptLogging || process.env.SHOWRUN_TRANSCRIPT_LOGGING === 'true';

  if (debug) {
    console.log('[Dashboard] Debug mode enabled — failed tool calls will be logged to data/failed-tool-calls.jsonl');
  }
  if (transcriptLogging) {
    console.log('[Dashboard] Transcript logging enabled — full agent conversations will be saved to the database');
  }

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

  // Create per-pack result stores (keyed by packId)
  const resultStores = new Map<string, ResultStoreProvider>();
  for (const { pack, path: packDir } of discoveredPacks) {
    try {
      const store = new SQLiteResultStore(resolve(packDir, 'results.db'));
      resultStores.set(pack.metadata.id, store);
    } catch (err) {
      console.warn(`[Dashboard] Failed to init result store for ${pack.metadata.id}: ${err}`);
    }
  }
  if (resultStores.size > 0) {
    console.log(`[Dashboard] Result stores initialized for ${resultStores.size} pack(s)`);
  }

  // Create TaskPack Editor wrapper
  const taskPackEditor = new TaskPackEditorWrapper(
    packDirs,
    resolvedWorkspaceDir || packDirs[0],
    resolvedBaseRunDir,
    headful,
    resultStores,
  );

  // Initialize LLM provider for Teach Mode (lazy, only if OPENAI_API_KEY is set)
  let llmProvider: ReturnType<typeof createLlmProvider> | null = null;
  try {
    llmProvider = createLlmProvider();
    console.log('[Dashboard] LLM provider initialized for Teach Mode');
  } catch {
    console.warn('[Dashboard] LLM provider not available (OPENAI_API_KEY not set)');
  }

  // Initialize Techniques DB (optional — gracefully degrade if not configured)
  let techniqueManager: TechniqueManager | null = null;
  const weaviateUrl = process.env.WEAVIATE_URL;

  if (weaviateUrl) {
    try {
      const vectorStoreConfig: VectorStoreConfig = {
        url: weaviateUrl,
        apiKey: process.env.WEAVIATE_API_KEY,
        collectionName: process.env.TECHNIQUES_COLLECTION || undefined,
      };

      // If EMBEDDING_API_KEY is set, use bring-your-own-vectors mode
      const embeddingApiKey = process.env.EMBEDDING_API_KEY;
      if (embeddingApiKey) {
        vectorStoreConfig.embeddingConfig = {
          apiKey: embeddingApiKey,
          model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
          baseUrl: process.env.EMBEDDING_BASE_URL,
        };
      } else {
        // Use Weaviate's built-in vectorizer
        vectorStoreConfig.vectorizer = process.env.WEAVIATE_VECTORIZER || undefined;
      }

      const vectorStore = new WeaviateVectorStore(vectorStoreConfig);
      await vectorStore.initialize();
      techniqueManager = new TechniqueManager(vectorStore);

      // Seed built-in techniques
      const seeded = await techniqueManager.seedIfEmpty();
      if (seeded > 0) {
        console.log(`[Dashboard] Seeded ${seeded} built-in techniques`);
      }
      console.log('[Dashboard] Techniques DB initialized');
    } catch (err) {
      console.warn(`[Dashboard] Techniques DB not available: ${err instanceof Error ? err.message : String(err)}`);
      techniqueManager = null;
    }
  } else {
    console.log('[Dashboard] Techniques DB not configured (set WEAVIATE_URL to enable)');
  }

  // Load fallback system prompt (used when Techniques DB is unavailable).
  // When the DB IS available, promptAssembler.ts builds the prompt dynamically
  // from system-prompt seed techniques at request time (in teach.ts).
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
    debug,
    transcriptLogging,
    packMap,
    runManager,
    concurrencyLimiter,
    mcpServer: {
      handle: null,
      packIds: [],
      runIdMap: new Map(),
    },
    io,
    resultStores,
    taskPackEditor,
    llmProvider,
    systemPrompt,
    pendingSecretsRequests,
    techniqueManager,
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
  app.use(createTechniquesRouter(ctx));
  app.use(createRegistryRouter(ctx));

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
