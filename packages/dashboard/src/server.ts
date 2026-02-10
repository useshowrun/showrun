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
  // 1. Env var takes top priority (inline text)
  const envPrompt = process.env.TEACH_CHAT_SYSTEM_PROMPT;
  if (envPrompt) return envPrompt;

  // 2. Search for system prompt via config system
  // Priority: EXPLORATION_AGENT_SYSTEM_PROMPT.md (two-agent architecture)
  //         → AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md (legacy single-agent)
  //         → TEACH_MODE_SYSTEM_PROMPT.md (fallback)
  const explorationAgentFilename = 'EXPLORATION_AGENT_SYSTEM_PROMPT.md';
  const legacyExplorationFilename = 'AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md';
  const teachFilename = 'TEACH_MODE_SYSTEM_PROMPT.md';

  // Check env var path overrides first (set via .env, config.json, or real env)
  const explorationEnvPath = process.env.AUTONOMOUS_EXPLORATION_PROMPT_PATH;
  const teachEnvPath = process.env.TEACH_MODE_SYSTEM_PROMPT_PATH;

  let pathToLoad: string | null = null;
  if (explorationEnvPath && existsSync(explorationEnvPath)) {
    pathToLoad = explorationEnvPath;
  } else if (teachEnvPath && existsSync(teachEnvPath)) {
    pathToLoad = teachEnvPath;
  }

  // Fall back to config directory / cwd / ancestor discovery
  if (!pathToLoad) {
    pathToLoad = resolveFilePath(explorationAgentFilename)
      ?? resolveFilePath(legacyExplorationFilename)
      ?? resolveFilePath(teachFilename);
  }

  if (pathToLoad) {
    try {
      const content = readFileSync(pathToLoad, 'utf-8').trim();
      console.log(`[Dashboard] System prompt loaded from ${pathToLoad}`);

      // Auto-copy to config dir for future use from other directories
      const loadedFilename = pathToLoad.endsWith(explorationAgentFilename)
        ? explorationAgentFilename
        : pathToLoad.endsWith(legacyExplorationFilename)
        ? legacyExplorationFilename
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
  console.error('[Dashboard] Run `showrun config init` to set up configuration, or create EXPLORATION_AGENT_SYSTEM_PROMPT.md in the project root.');
  return 'System prompt not configured. Run `showrun config init` or create EXPLORATION_AGENT_SYSTEM_PROMPT.md in the project root.';
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

  // Load system prompt + action-first addon
  const basePrompt = loadSystemPrompt();

  // Action-first addon: agent MUST use tools, enforces two-agent architecture rules
  const EXPLORATION_AGENT_ACTION_RULES =
    `\n\nEXPLORATION AGENT RULES (MANDATORY):
- You MUST use tools. Browser and Network tools are ALWAYS available. Tool calls are expected, not optional.
- If packId is provided: FIRST call editor_read_pack to see the current flow state before doing anything else.
- You are the EXPLORATION AGENT. You CANNOT build flows directly. You explore websites and delegate flow building to the Editor Agent via agent_build_flow.
- You do NOT have access to editor_apply_flow_patch or editor_run_pack. Do not attempt to call them. Use agent_build_flow to delegate all flow building to the Editor Agent.
- When the user asks to create a flow, add steps, or extract data: explore the site first, create a roadmap, get approval, then call agent_build_flow with comprehensive exploration context.
- When the user asks to execute/run steps in the open browser: use browser_* tools (browser_goto, browser_click, browser_type, etc.) to perform the actions. These are for exploration, not for building flows.
- When the user asks you to CLICK a link or button (e.g. "click the Sign in link"): use browser_click with linkText and role "link" or "button". For batch names, filter options, tabs, or list items (e.g. "Winter 2026", "Spring 2026") that are not <a> or <button>, use browser_click with linkText and role "text".
- To understand page structure: use browser_get_dom_snapshot (returns interactive elements, forms, headings, navigation with target hints). Prefer it for exploration—it's text-based, cheap, and provides element targets.
- To find which links are on the page: use browser_get_links (returns href and visible text for each link). Prefer it over screenshot when you need to choose or click a link.
- For visual layout context (images, complex UI): use browser_screenshot. Use sparingly—only when visual layout matters.
- You HAVE network inspection tools: browser_network_list, browser_network_search, browser_network_get, browser_network_get_response, browser_network_replay. Use them when the user wants to inspect a request or when you need to discover API endpoints. ALWAYS call browser_network_list(filter: "api") after every navigation.
- When the user provides a request ID (e.g. "use request req-123"): call browser_network_get(requestId) for metadata. Use browser_network_get_response(requestId, full?) for the response body.
- When the user asks for a request by description: use browser_network_search with a query substring to find matching entries.
- When you need page context (e.g. "what page am I on?"): prefer browser_get_dom_snapshot for structure; use browser_screenshot only when visual layout is needed.
- Prefer action over explanation. Explanations are optional; tool usage is mandatory when relevant.
- Never reply with generic "here is what you can do" without calling tools. Always use browser tools, network tools, or agent_build_flow as needed.
- Never refuse to use network tools or suggest manual extraction instead.
- When calling agent_build_flow: include ALL discovered API endpoints (URL, method, response structure), DOM structure notes, auth info, pagination details. The Editor Agent has NO browser access—it can only build from what you provide.
- Templating in DSL steps uses Nunjucks: {{inputs.x}}, {{vars.x}}, {{secret.NAME}}. For URL values use {{ inputs.x | urlencode }}.
- If a tool call returns an error: do NOT retry the same call with identical arguments. Reply to the user with the error and suggest a different approach. One retry at most; then stop and respond.`;

  const systemPrompt = basePrompt + EXPLORATION_AGENT_ACTION_RULES;

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
