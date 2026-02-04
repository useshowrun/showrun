/**
 * Manages run state and history
 * Now backed by SQLite for persistence
 */
import {
  createRun,
  getRun as dbGetRun,
  getAllRuns as dbGetAllRuns,
  updateRun as dbUpdateRun,
  pruneOldRuns,
  dbRunToLegacy,
  type DbRunInfo,
  type LegacyRunInfo,
} from './db.js';

// Keep the legacy RunInfo interface for backward compatibility
export interface RunInfo {
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
  // New fields from database
  conversationId?: string;
  source?: DbRunInfo['source'];
}

export class RunManager {
  private maxRuns = 1000; // Keep last 1000 runs

  /**
   * Add a new run
   */
  addRun(run: RunInfo): void {
    // Create in database
    createRun(
      run.packId,
      run.packName,
      run.source || 'dashboard',
      run.conversationId || undefined
    );

    // If the run already has an ID different from what DB would generate,
    // we need to update it. For now, we'll accept that the runId might change.
    // In practice, callers should use the returned run from addRunAndGet instead.
  }

  /**
   * Add a new run and return the created run info with the database ID
   */
  addRunAndGet(
    packId: string,
    packName: string,
    source: DbRunInfo['source'] = 'dashboard',
    conversationId?: string
  ): RunInfo {
    const dbRun = createRun(packId, packName, source, conversationId);
    const legacy = dbRunToLegacy(dbRun);

    // Prune old runs if needed
    if (this.maxRuns > 0) {
      pruneOldRuns(this.maxRuns);
    }

    return legacy;
  }

  /**
   * Get a run by ID
   */
  getRun(runId: string): RunInfo | undefined {
    const dbRun = dbGetRun(runId);
    if (!dbRun) return undefined;
    return dbRunToLegacy(dbRun);
  }

  /**
   * Update a run
   */
  updateRun(runId: string, updates: Partial<RunInfo>): void {
    const dbUpdates: Parameters<typeof dbUpdateRun>[1] = {};

    if (updates.status !== undefined) {
      dbUpdates.status = updates.status;
    }
    if (updates.startedAt !== undefined) {
      dbUpdates.startedAt = updates.startedAt;
    }
    if (updates.finishedAt !== undefined) {
      dbUpdates.finishedAt = updates.finishedAt;
    }
    if (updates.durationMs !== undefined) {
      dbUpdates.durationMs = updates.durationMs;
    }
    if (updates.runDir !== undefined) {
      dbUpdates.runDir = updates.runDir;
    }
    if (updates.collectibles !== undefined) {
      dbUpdates.collectiblesJson = JSON.stringify(updates.collectibles);
    }
    if (updates.meta !== undefined) {
      dbUpdates.metaJson = JSON.stringify(updates.meta);
    }
    if (updates.error !== undefined) {
      dbUpdates.errorMessage = updates.error;
    }

    dbUpdateRun(runId, dbUpdates);
  }

  /**
   * Get all runs, sorted by creation time (newest first)
   */
  getAllRuns(options?: {
    source?: DbRunInfo['source'];
    conversationId?: string;
    limit?: number;
  }): RunInfo[] {
    const dbRuns = dbGetAllRuns({
      source: options?.source,
      conversationId: options?.conversationId,
      limit: options?.limit,
    });
    return dbRuns.map(dbRunToLegacy);
  }
}
