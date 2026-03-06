import { join } from 'path';
import type { TaskPack, RunResult, ShowScriptExecutor } from '@showrun/core';
import { runTaskPack } from '@showrun/core';
import { JSONLLogger } from './logger.js';
import { runShowScript } from './showscript-runner.js';

/**
 * ShowScript executor that bridges core → harness.
 * Passed as a callback to core's runTaskPack to avoid circular deps.
 * Exported for use by dashboard and other consumers.
 */
export const showscriptExecutor: ShowScriptExecutor = async (opts) => {
  return runShowScript({
    scriptPath: 'flow.showscript',
    source: opts.source,
    page: opts.page,
    browser: opts.browser,
    inputs: opts.inputs,
    secrets: opts.secrets,
    logger: opts.logger,
    networkCapture: opts.networkCapture,
    packDir: opts.packDir,
  });
};

/**
 * Runs a task pack with Playwright
 * Wrapper around the shared runTaskPack function
 */
export class TaskPackRunner {
  private logger: JSONLLogger;
  private runsDir: string;

  constructor(runsDir: string) {
    this.runsDir = runsDir;
    this.logger = new JSONLLogger(runsDir);
  }

  async run(
    taskPack: TaskPack,
    inputs: Record<string, unknown>,
    options?: { headful?: boolean; cdpUrl?: string }
  ): Promise<RunResult> {
    const result = await runTaskPack(taskPack, inputs, {
      runDir: this.runsDir,
      logger: this.logger,
      headless: options?.headful !== true,
      cdpUrl: options?.cdpUrl,
      showscriptExecutor,
    });

    // Return just the RunResult part (without paths)
    const runResult: RunResult = {
      collectibles: result.collectibles,
      meta: result.meta,
    };

    // Include hints if present
    if (result._hints && result._hints.length > 0) {
      runResult._hints = result._hints;
    }

    return runResult;
  }
}
