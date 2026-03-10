/**
 * @showrun/harness - Public API
 */

import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { TaskPackLoader } from '@showrun/core';
import type { RunResult } from '@showrun/core';
import { TaskPackRunner } from './runner.js';

export { JSONLLogger } from './logger.js';
export { TaskPackRunner } from './runner.js';
export { SQLiteResultStore } from './storage/sqliteStore.js';
export { InMemoryResultStore } from './storage/inMemoryStore.js';

export interface RunPackOptions {
  /** Path to the task pack directory */
  packPath: string;
  /** Input values for the task pack */
  inputs?: Record<string, unknown>;
  /** Run browser in headful mode */
  headful?: boolean;
  /** Base directory for run outputs (default: ./runs) */
  baseRunDir?: string;
  /** Chrome DevTools Protocol URL to connect to an existing browser */
  cdpUrl?: string;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
}

export interface RunPackResult extends RunResult {
  /** Directory where run artifacts are stored */
  runDir: string;
}

/**
 * Run a task pack programmatically
 */
export async function runPack(options: RunPackOptions): Promise<RunPackResult> {
  const { packPath, inputs = {}, headful = false, baseRunDir = './runs', cdpUrl, timeoutMs } = options;

  const resolvedPackPath = resolve(packPath);
  if (!existsSync(resolvedPackPath)) {
    throw new Error(`Task pack directory not found: ${resolvedPackPath}`);
  }

  // Load task pack
  const taskPack = await TaskPackLoader.loadTaskPack(resolvedPackPath);

  // Create runs directory with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runsDir = join(resolve(baseRunDir), timestamp);
  mkdirSync(runsDir, { recursive: true });

  // Run task pack
  // CLI timeout overrides flow timeout, which overrides default (5 min)
  const effectiveTimeout = timeoutMs ?? taskPack.metadata.timeoutMs;
  const runner = new TaskPackRunner(runsDir);
  const result = await runner.run(taskPack, inputs, { headful, cdpUrl, timeoutMs: effectiveTimeout });

  return {
    ...result,
    runDir: runsDir,
  };
}
