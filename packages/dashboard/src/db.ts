/**
 * SQLite database layer for dashboard persistence
 * Stores conversations, messages, and run history
 */
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { v4 as uuidv4 } from 'uuid';

// Types
export interface Conversation {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'ready' | 'needs_input' | 'error';
  packId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls: string | null; // JSON array
  thinkingContent: string | null;
  createdAt: number;
}

export interface DbRunInfo {
  id: string;
  packId: string;
  packName: string;
  conversationId: string | null;
  source: 'dashboard' | 'mcp' | 'cli' | 'agent';
  status: 'queued' | 'running' | 'success' | 'failed';
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  runDir: string | null;
  collectiblesJson: string | null;
  metaJson: string | null;
  errorMessage: string | null;
}

// Database instance
let db: Database.Database | null = null;

/**
 * Initialize the database, creating tables if they don't exist
 */
export function initDatabase(dataDir: string = './data'): Database.Database {
  if (db) return db;

  // Ensure data directory exists
  const resolvedDataDir = resolve(dataDir);
  if (!existsSync(resolvedDataDir)) {
    mkdirSync(resolvedDataDir, { recursive: true });
  }

  const dbPath = resolve(resolvedDataDir, 'showrun.db');
  console.log(`[Database] Initializing SQLite database at ${dbPath}`);

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Run migrations
  runMigrations(db);

  return db;
}

/**
 * Get the database instance
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Run database migrations
 */
function runMigrations(database: Database.Database): void {
  // Create migrations table if not exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      appliedAt INTEGER NOT NULL
    )
  `);

  const migrations: Array<{ name: string; sql: string }> = [
    {
      name: '001_create_conversations',
      sql: `
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          packId TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
        CREATE INDEX IF NOT EXISTS idx_conversations_updatedAt ON conversations(updatedAt);
      `,
    },
    {
      name: '002_create_messages',
      sql: `
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          toolCalls TEXT,
          thinkingContent TEXT,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversationId ON messages(conversationId);
        CREATE INDEX IF NOT EXISTS idx_messages_createdAt ON messages(createdAt);
      `,
    },
    {
      name: '003_create_runs',
      sql: `
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          packId TEXT NOT NULL,
          packName TEXT NOT NULL,
          conversationId TEXT,
          source TEXT NOT NULL DEFAULT 'dashboard',
          status TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          startedAt INTEGER,
          finishedAt INTEGER,
          durationMs INTEGER,
          runDir TEXT,
          collectiblesJson TEXT,
          metaJson TEXT,
          errorMessage TEXT,
          FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_conversationId ON runs(conversationId);
        CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
        CREATE INDEX IF NOT EXISTS idx_runs_createdAt ON runs(createdAt);
      `,
    },
    {
      name: '004_add_plan_to_conversations',
      sql: `
        ALTER TABLE conversations ADD COLUMN plan TEXT;
      `,
    },
    {
      name: '005_create_conversation_transcripts',
      sql: `
        CREATE TABLE IF NOT EXISTS conversation_transcripts (
          id TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL,
          packId TEXT,
          conversationStatus TEXT,
          transcript TEXT NOT NULL,
          toolTrace TEXT,
          flowJson TEXT,
          validation TEXT,
          agentIterations INTEGER,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_transcripts_conversationId ON conversation_transcripts(conversationId);
        CREATE INDEX IF NOT EXISTS idx_transcripts_packId ON conversation_transcripts(packId);
        CREATE INDEX IF NOT EXISTS idx_transcripts_createdAt ON conversation_transcripts(createdAt);
      `,
    },
  ];

  const appliedMigrations = new Set(
    database
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((row: any) => row.name)
  );

  for (const migration of migrations) {
    if (!appliedMigrations.has(migration.name)) {
      console.log(`[Database] Running migration: ${migration.name}`);
      database.exec(migration.sql);
      database.prepare('INSERT INTO _migrations (name, appliedAt) VALUES (?, ?)').run(
        migration.name,
        Date.now()
      );
    }
  }
}

// ============================================================================
// Conversation CRUD operations
// ============================================================================

export function createConversation(title: string, description?: string | null): Conversation {
  const database = getDatabase();
  const id = uuidv4();
  const now = Date.now();

  database
    .prepare(
      `INSERT INTO conversations (id, title, description, status, packId, createdAt, updatedAt)
       VALUES (?, ?, ?, 'active', NULL, ?, ?)`
    )
    .run(id, title, description ?? null, now, now);

  return {
    id,
    title,
    description: description ?? null,
    status: 'active',
    packId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function getConversation(id: string): Conversation | null {
  const database = getDatabase();
  const row = database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
  return row ? mapRowToConversation(row) : null;
}

export function getAllConversations(): Conversation[] {
  const database = getDatabase();
  const rows = database
    .prepare('SELECT * FROM conversations ORDER BY updatedAt DESC')
    .all() as any[];
  return rows.map(mapRowToConversation);
}

export function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'title' | 'description' | 'status' | 'packId'>>
): Conversation | null {
  const database = getDatabase();
  const existing = getConversation(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.packId !== undefined) {
    fields.push('packId = ?');
    values.push(updates.packId);
  }

  if (fields.length === 0) return existing;

  fields.push('updatedAt = ?');
  values.push(Date.now());
  values.push(id);

  database.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  return getConversation(id);
}

export function deleteConversation(id: string): boolean {
  const database = getDatabase();
  const result = database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return result.changes > 0;
}

function mapRowToConversation(row: any): Conversation {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    packId: row.packId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ============================================================================
// Plan persistence for conversations
// ============================================================================

/**
 * Get the saved plan for a conversation
 */
export function getConversationPlan(conversationId: string): string | null {
  const database = getDatabase();
  const row = database.prepare('SELECT plan FROM conversations WHERE id = ?').get(conversationId) as any;
  return row?.plan || null;
}

/**
 * Set the plan for a conversation
 */
export function setConversationPlan(conversationId: string, plan: string): void {
  const database = getDatabase();
  database.prepare('UPDATE conversations SET plan = ?, updatedAt = ? WHERE id = ?').run(plan, Date.now(), conversationId);
}

// ============================================================================
// Message CRUD operations
// ============================================================================

export function addMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  toolCalls?: any[] | null,
  thinkingContent?: string | null
): Message {
  const database = getDatabase();
  const id = uuidv4();
  const now = Date.now();

  database
    .prepare(
      `INSERT INTO messages (id, conversationId, role, content, toolCalls, thinkingContent, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      conversationId,
      role,
      content,
      toolCalls ? JSON.stringify(toolCalls) : null,
      thinkingContent ?? null,
      now
    );

  // Update conversation updatedAt
  database
    .prepare('UPDATE conversations SET updatedAt = ? WHERE id = ?')
    .run(now, conversationId);

  return {
    id,
    conversationId,
    role,
    content,
    toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
    thinkingContent: thinkingContent ?? null,
    createdAt: now,
  };
}

export function getMessagesForConversation(conversationId: string): Message[] {
  const database = getDatabase();
  const rows = database
    .prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt ASC')
    .all(conversationId) as any[];
  return rows.map(mapRowToMessage);
}

export function deleteMessagesForConversation(conversationId: string): number {
  const database = getDatabase();
  const result = database
    .prepare('DELETE FROM messages WHERE conversationId = ?')
    .run(conversationId);
  return result.changes;
}

function mapRowToMessage(row: any): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    toolCalls: row.toolCalls,
    thinkingContent: row.thinkingContent,
    createdAt: row.createdAt,
  };
}

// ============================================================================
// Run CRUD operations
// ============================================================================

export function createRun(
  packId: string,
  packName: string,
  source: DbRunInfo['source'] = 'dashboard',
  conversationId?: string | null
): DbRunInfo {
  const database = getDatabase();
  const id = uuidv4();
  const now = Date.now();

  database
    .prepare(
      `INSERT INTO runs (id, packId, packName, conversationId, source, status, createdAt)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`
    )
    .run(id, packId, packName, conversationId ?? null, source, now);

  return {
    id,
    packId,
    packName,
    conversationId: conversationId ?? null,
    source,
    status: 'queued',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    runDir: null,
    collectiblesJson: null,
    metaJson: null,
    errorMessage: null,
  };
}

export function getRun(id: string): DbRunInfo | null {
  const database = getDatabase();
  const row = database.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any;
  return row ? mapRowToRun(row) : null;
}

export function getAllRuns(options?: {
  source?: DbRunInfo['source'];
  conversationId?: string;
  limit?: number;
}): DbRunInfo[] {
  const database = getDatabase();
  let sql = 'SELECT * FROM runs';
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.source) {
    conditions.push('source = ?');
    params.push(options.source);
  }
  if (options?.conversationId) {
    conditions.push('conversationId = ?');
    params.push(options.conversationId);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY createdAt DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = database.prepare(sql).all(...params) as any[];
  return rows.map(mapRowToRun);
}

export function updateRun(
  id: string,
  updates: Partial<
    Pick<
      DbRunInfo,
      'status' | 'startedAt' | 'finishedAt' | 'durationMs' | 'runDir' | 'collectiblesJson' | 'metaJson' | 'errorMessage'
    >
  >
): DbRunInfo | null {
  const database = getDatabase();

  const fields: string[] = [];
  const values: any[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.startedAt !== undefined) {
    fields.push('startedAt = ?');
    values.push(updates.startedAt);
  }
  if (updates.finishedAt !== undefined) {
    fields.push('finishedAt = ?');
    values.push(updates.finishedAt);
  }
  if (updates.durationMs !== undefined) {
    fields.push('durationMs = ?');
    values.push(updates.durationMs);
  }
  if (updates.runDir !== undefined) {
    fields.push('runDir = ?');
    values.push(updates.runDir);
  }
  if (updates.collectiblesJson !== undefined) {
    fields.push('collectiblesJson = ?');
    values.push(updates.collectiblesJson);
  }
  if (updates.metaJson !== undefined) {
    fields.push('metaJson = ?');
    values.push(updates.metaJson);
  }
  if (updates.errorMessage !== undefined) {
    fields.push('errorMessage = ?');
    values.push(updates.errorMessage);
  }

  if (fields.length === 0) return getRun(id);

  values.push(id);
  database.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  return getRun(id);
}

export function deleteRun(id: string): boolean {
  const database = getDatabase();
  const result = database.prepare('DELETE FROM runs WHERE id = ?').run(id);
  return result.changes > 0;
}

export function pruneOldRuns(keepCount: number = 1000): number {
  const database = getDatabase();
  // Get the createdAt of the keepCount-th most recent run
  const cutoffRow = database
    .prepare('SELECT createdAt FROM runs ORDER BY createdAt DESC LIMIT 1 OFFSET ?')
    .get(keepCount - 1) as any;

  if (!cutoffRow) return 0;

  const result = database
    .prepare('DELETE FROM runs WHERE createdAt < ?')
    .run(cutoffRow.createdAt);
  return result.changes;
}

function mapRowToRun(row: any): DbRunInfo {
  return {
    id: row.id,
    packId: row.packId,
    packName: row.packName,
    conversationId: row.conversationId,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    runDir: row.runDir,
    collectiblesJson: row.collectiblesJson,
    metaJson: row.metaJson,
    errorMessage: row.errorMessage,
  };
}

// ============================================================================
// Conversation Transcript CRUD operations
// ============================================================================

export interface ConversationTranscript {
  id: string;
  conversationId: string;
  packId: string | null;
  conversationStatus: string | null;
  transcript: string;    // JSON string
  toolTrace: string | null;     // JSON string
  flowJson: string | null;      // JSON string
  validation: string | null;    // JSON string
  agentIterations: number | null;
  createdAt: number;
}

export function createConversationTranscript(data: {
  conversationId: string;
  packId?: string | null;
  conversationStatus?: string | null;
  transcript: unknown;
  toolTrace?: unknown;
  flowJson?: unknown;
  validation?: unknown;
  agentIterations?: number;
}): ConversationTranscript {
  const database = getDatabase();
  const id = uuidv4();
  const now = Date.now();

  const transcriptStr = typeof data.transcript === 'string' ? data.transcript : JSON.stringify(data.transcript);
  const toolTraceStr = data.toolTrace ? (typeof data.toolTrace === 'string' ? data.toolTrace : JSON.stringify(data.toolTrace)) : null;
  const flowJsonStr = data.flowJson ? (typeof data.flowJson === 'string' ? data.flowJson : JSON.stringify(data.flowJson)) : null;
  const validationStr = data.validation ? (typeof data.validation === 'string' ? data.validation : JSON.stringify(data.validation)) : null;

  database
    .prepare(
      `INSERT INTO conversation_transcripts (id, conversationId, packId, conversationStatus, transcript, toolTrace, flowJson, validation, agentIterations, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      data.conversationId,
      data.packId ?? null,
      data.conversationStatus ?? null,
      transcriptStr,
      toolTraceStr,
      flowJsonStr,
      validationStr,
      data.agentIterations ?? null,
      now
    );

  return {
    id,
    conversationId: data.conversationId,
    packId: data.packId ?? null,
    conversationStatus: data.conversationStatus ?? null,
    transcript: transcriptStr,
    toolTrace: toolTraceStr,
    flowJson: flowJsonStr,
    validation: validationStr,
    agentIterations: data.agentIterations ?? null,
    createdAt: now,
  };
}

export function getConversationTranscript(id: string): ConversationTranscript | null {
  const database = getDatabase();
  const row = database.prepare('SELECT * FROM conversation_transcripts WHERE id = ?').get(id) as any;
  return row ? mapRowToTranscript(row) : null;
}

export function getTranscriptByConversationId(conversationId: string): ConversationTranscript | null {
  const database = getDatabase();
  const row = database
    .prepare('SELECT * FROM conversation_transcripts WHERE conversationId = ? ORDER BY createdAt DESC LIMIT 1')
    .get(conversationId) as any;
  return row ? mapRowToTranscript(row) : null;
}

export function getAllTranscripts(options?: {
  packId?: string;
  limit?: number;
  offset?: number;
}): ConversationTranscript[] {
  const database = getDatabase();
  let sql = 'SELECT * FROM conversation_transcripts';
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.packId) {
    conditions.push('packId = ?');
    params.push(options.packId);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY createdAt DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = database.prepare(sql).all(...params) as any[];
  return rows.map(mapRowToTranscript);
}

export function deleteTranscript(id: string): boolean {
  const database = getDatabase();
  const result = database.prepare('DELETE FROM conversation_transcripts WHERE id = ?').run(id);
  return result.changes > 0;
}

function mapRowToTranscript(row: any): ConversationTranscript {
  return {
    id: row.id,
    conversationId: row.conversationId,
    packId: row.packId,
    conversationStatus: row.conversationStatus,
    transcript: row.transcript,
    toolTrace: row.toolTrace,
    flowJson: row.flowJson,
    validation: row.validation,
    agentIterations: row.agentIterations,
    createdAt: row.createdAt,
  };
}

// ============================================================================
// Conversation Debug Export
// ============================================================================

/**
 * Full conversation export for debugging - includes all messages and related runs
 */
export interface ConversationDebugExport {
  exportedAt: string;
  exportVersion: string;
  conversation: Conversation & { plan?: string | null };
  messages: Array<Message & { toolCallsParsed?: unknown[] }>;
  runs: DbRunInfo[];
  stats: {
    messageCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    toolCallCount: number;
    runCount: number;
    successfulRuns: number;
    failedRuns: number;
    totalDurationMs: number;
  };
}

/**
 * Export a conversation with all related data for debugging
 */
export function exportConversationForDebug(conversationId: string): ConversationDebugExport | null {
  const database = getDatabase();

  // Get conversation with plan
  const convRow = database
    .prepare('SELECT *, plan FROM conversations WHERE id = ?')
    .get(conversationId) as any;
  if (!convRow) return null;

  const conversation = {
    ...mapRowToConversation(convRow),
    plan: convRow.plan || null,
  };

  // Get all messages with parsed tool calls
  const messageRows = database
    .prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt ASC')
    .all(conversationId) as any[];

  const messages = messageRows.map((row) => {
    const msg = mapRowToMessage(row);
    let toolCallsParsed: unknown[] | undefined;
    if (msg.toolCalls) {
      try {
        toolCallsParsed = JSON.parse(msg.toolCalls);
      } catch {
        // ignore parse errors
      }
    }
    return { ...msg, toolCallsParsed };
  });

  // Get related runs
  const runRows = database
    .prepare('SELECT * FROM runs WHERE conversationId = ? ORDER BY createdAt ASC')
    .all(conversationId) as any[];
  const runs = runRows.map(mapRowToRun);

  // Calculate stats
  let toolCallCount = 0;
  let userMessageCount = 0;
  let assistantMessageCount = 0;

  for (const msg of messages) {
    if (msg.role === 'user') userMessageCount++;
    if (msg.role === 'assistant') assistantMessageCount++;
    if (msg.toolCallsParsed && Array.isArray(msg.toolCallsParsed)) {
      toolCallCount += msg.toolCallsParsed.length;
    }
  }

  const successfulRuns = runs.filter((r) => r.status === 'success').length;
  const failedRuns = runs.filter((r) => r.status === 'failed').length;
  const totalDurationMs = runs.reduce((sum, r) => sum + (r.durationMs || 0), 0);

  return {
    exportedAt: new Date().toISOString(),
    exportVersion: '1.0.0',
    conversation,
    messages,
    runs,
    stats: {
      messageCount: messages.length,
      userMessageCount,
      assistantMessageCount,
      toolCallCount,
      runCount: runs.length,
      successfulRuns,
      failedRuns,
      totalDurationMs,
    },
  };
}

// ============================================================================
// Utility: Convert DbRunInfo to legacy RunInfo format for backward compatibility
// ============================================================================

export interface LegacyRunInfo {
  runId: string;
  packId: string;
  packName: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  runDir?: string;
  eventsPath?: string;
  artifactsDir?: string;
  collectibles?: Record<string, unknown>;
  meta?: {
    url?: string;
    durationMs: number;
    notes?: string;
  };
  error?: string;
  // New fields
  conversationId?: string;
  source?: DbRunInfo['source'];
}

export function dbRunToLegacy(run: DbRunInfo): LegacyRunInfo {
  const result: LegacyRunInfo = {
    runId: run.id,
    packId: run.packId,
    packName: run.packName,
    status: run.status,
    createdAt: run.createdAt,
    source: run.source,
  };

  if (run.conversationId) result.conversationId = run.conversationId;
  if (run.startedAt) result.startedAt = run.startedAt;
  if (run.finishedAt) result.finishedAt = run.finishedAt;
  if (run.durationMs) result.durationMs = run.durationMs;
  if (run.runDir) {
    result.runDir = run.runDir;
    result.eventsPath = `${run.runDir}/events.jsonl`;
    result.artifactsDir = `${run.runDir}/artifacts`;
  }
  if (run.collectiblesJson) {
    try {
      result.collectibles = JSON.parse(run.collectiblesJson);
    } catch {
      // ignore
    }
  }
  if (run.metaJson) {
    try {
      result.meta = JSON.parse(run.metaJson);
    } catch {
      // ignore
    }
  }
  if (run.errorMessage) result.error = run.errorMessage;

  return result;
}
