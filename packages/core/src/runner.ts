import { type Browser, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { TaskPack, RunResult, RunContext } from './types.js';
import { InputValidator, RunContextFactory, runFlow, attachNetworkCapture, TaskPackLoader } from './index.js';
import type { Logger } from './types.js';
import { launchBrowser, type BrowserSession } from './browserLauncher.js';
import { isFlowHttpCompatible } from './httpReplay.js';
import type { SnapshotFile, RequestSnapshot } from './requestSnapshot.js';
import {
  writeSnapshots,
  extractTopLevelKeys,
  detectSensitiveHeaders,
} from './requestSnapshot.js';
import type { NetworkCaptureApi } from './networkCapture.js';

/**
 * Options for running a task pack
 */
export interface RunTaskPackOptions {
  /**
   * Directory to store run artifacts and logs
   */
  runDir: string;
  /**
   * Logger instance for structured logging
   */
  logger: Logger;
  /**
   * Whether to run browser in headless mode (default: true)
   */
  headless?: boolean;
  /**
   * Session ID for "once" step caching (session scope)
   */
  sessionId?: string;
  /**
   * Profile ID for "once" step caching (profile scope)
   */
  profileId?: string;
  /**
   * Directory for profile cache storage (typically the pack directory)
   */
  cacheDir?: string;
  /**
   * Pack directory path (used for loading secrets)
   */
  packPath?: string;
  /**
   * Pre-loaded secrets (if not provided, will be loaded from packPath)
   */
  secrets?: Record<string, string>;
  /**
   * Skip HTTP-only replay mode and always use browser execution
   */
  skipHttpReplay?: boolean;
}

/**
 * Result of running a task pack with paths
 */
export interface RunTaskPackResult extends RunResult {
  /**
   * Path to the run directory
   */
  runDir: string;
  /**
   * Path to the events JSONL file
   */
  eventsPath: string;
  /**
   * Path to the artifacts directory
   */
  artifactsDir: string;
}

/**
 * Runs a task pack with Playwright
 * This is a reusable function that can be used by both CLI and MCP server
 */
export async function runTaskPack(
  taskPack: TaskPack,
  inputs: Record<string, unknown>,
  options: RunTaskPackOptions
): Promise<RunTaskPackResult> {
  const { runDir, logger, headless: requestedHeadless = true, packPath, secrets: providedSecrets } = options;
  const artifactsDir = join(runDir, 'artifacts');
  const eventsPath = join(runDir, 'events.jsonl');

  // Ensure directories exist
  mkdirSync(runDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  // Auto-detect if we can run headful
  // On Linux, a DISPLAY (X11) or WAYLAND_DISPLAY is required for headful mode.
  // On macOS/Windows, native window management handles it — no env var needed.
  const isLinux = process.platform === 'linux';
  const hasDisplay = !isLinux || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  const headless = requestedHeadless || !hasDisplay;

  if (!requestedHeadless && !hasDisplay) {
    console.error(
      '[Warning] Headful mode requested but no DISPLAY/WAYLAND_DISPLAY environment variable found. ' +
      'Falling back to headless mode. Set DISPLAY or use xvfb-run to enable headful mode.'
    );
  }

  const startTime = Date.now();

  // Apply defaults and validate inputs early (needed for both HTTP and browser modes)
  const inputsWithDefaults = InputValidator.applyDefaults(inputs, taskPack.inputs);
  InputValidator.validate(inputsWithDefaults, taskPack.inputs);

  // Load secrets early (needed for both modes)
  const secrets = providedSecrets ?? (packPath ? TaskPackLoader.loadSecrets(packPath) : {});

  // ─── HTTP-first execution ───────────────────────────────────────────
  const snapshots = taskPack.snapshots ?? null;
  if (!options.skipHttpReplay && isFlowHttpCompatible(taskPack.flow, snapshots)) {
    logger.log({
      type: 'run_started',
      data: {
        packId: taskPack.metadata.id,
        packVersion: taskPack.metadata.version,
        inputs: inputsWithDefaults,
      },
    });

    try {
      const httpResult = await runHttpOnly(
        taskPack,
        inputsWithDefaults,
        snapshots!,
        secrets,
        logger,
        options,
      );

      const durationMs = Date.now() - startTime;
      logger.log({ type: 'run_finished', data: { success: true, durationMs } });
      return { ...httpResult, runDir, eventsPath, artifactsDir };
    } catch (httpError) {
      // HTTP-only execution failed — fall through to browser mode
      const reason = httpError instanceof Error ? httpError.message : String(httpError);
      console.log(`[runner] HTTP-only mode failed (${reason}), falling back to browser mode`);
    }
  }

  // ─── Browser execution (fallback or primary) ───────────────────────
  let browserSession: BrowserSession | null = null;
  let page: Page | null = null;
  let runContext: RunContext | null = null;

  try {
    // Log run start (only if not already logged above)
    if (options.skipHttpReplay || !isFlowHttpCompatible(taskPack.flow, snapshots)) {
      logger.log({
        type: 'run_started',
        data: {
          packId: taskPack.metadata.id,
          packVersion: taskPack.metadata.version,
          inputs: inputsWithDefaults,
        },
      });
    }

    // Launch browser with unified launcher
    browserSession = await launchBrowser({
      browserSettings: taskPack.browser,
      headless,
      sessionId: options.sessionId,
      packPath: options.packPath ?? options.cacheDir,
    });
    page = browserSession.page;

    // Attach network capture (rolling buffer, redacted for logs; full headers in-memory for replay only)
    const networkCapture = attachNetworkCapture(page);

    // Create run context
    // Note: browserSession.browser may be null for persistent contexts or Camoufox
    // We pass a proxy that satisfies the Browser type for the RunContext
    const browserProxy = browserSession.browser ?? {
      close: async () => browserSession?.close(),
      contexts: () => [browserSession?.context],
      isConnected: () => true,
      newContext: async () => browserSession?.context,
      newPage: async () => browserSession?.page,
      version: () => 'unknown',
    } as unknown as Browser;

    runContext = RunContextFactory.create(
      page,
      browserProxy,
      logger,
      artifactsDir,
      networkCapture
    );

    // Execute declarative DSL flow
    const flowResult = await runFlow(runContext, taskPack.flow, {
      inputs: inputsWithDefaults,
      auth: taskPack.auth,
      sessionId: options.sessionId,
      profileId: options.profileId,
      cacheDir: options.cacheDir,
      secrets,
    });

    // Filter collectibles to only include those defined in the pack
    // This prevents intermediate variables from polluting the output
    const definedCollectibleNames = new Set(
      (taskPack.collectibles || []).map(c => c.name)
    );
    const filteredCollectibles: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flowResult.collectibles)) {
      if (definedCollectibleNames.has(key)) {
        filteredCollectibles[key] = value;
      }
    }

    // Convert RunFlowResult to RunResult format
    const result: RunResult = {
      collectibles: filteredCollectibles,
      meta: {
        url: flowResult.meta.url,
        durationMs: flowResult.meta.durationMs,
        notes: `Executed ${flowResult.meta.stepsExecuted}/${flowResult.meta.stepsTotal} steps`,
      },
    };

    // Propagate diagnostic hints if present
    if (flowResult._hints && flowResult._hints.length > 0) {
      result._hints = flowResult._hints;
    }

    // Capture snapshots for network_replay steps after successful browser run
    if (packPath && networkCapture) {
      try {
        captureSnapshots(taskPack, flowResult, networkCapture, packPath);
      } catch (snapErr) {
        console.warn(`[runner] Failed to capture snapshots: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
      }
    }

    const durationMs = Date.now() - startTime;

    // Log run finish
    logger.log({
      type: 'run_finished',
      data: {
        success: true,
        durationMs,
      },
    });

    return {
      ...result,
      runDir,
      eventsPath,
      artifactsDir,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log error
    logger.log({
      type: 'error',
      data: {
        error: errorMessage,
      },
    });

    // Save artifacts on error
    if (page) {
      try {
        if (runContext) {
          await runContext.artifacts.saveScreenshot('error');
          const html = await page.content();
          await runContext.artifacts.saveHTML('error', html);
        } else {
          // Fallback: save artifacts directly if runContext wasn't created
          const screenshotPath = join(artifactsDir, 'error.png');
          await page.screenshot({ path: screenshotPath, fullPage: true });
          const html = await page.content();
          const htmlPath = join(artifactsDir, 'error.html');
          writeFileSync(htmlPath, html, 'utf-8');
        }
      } catch (artifactError) {
        // Ignore artifact save errors
        console.error('Failed to save artifacts:', artifactError);
      }
    }

    // Extract partial results from enriched error (set by interpreter)
    const partialResult = (error as any)?.partialResult as
      | { collectibles: Record<string, unknown>; stepsExecuted: number; failedStepId: string }
      | undefined;

    // Filter partial collectibles to only include declared ones
    let partialCollectibles: Record<string, unknown> = {};
    if (partialResult?.collectibles) {
      const definedCollectibleNames = new Set(
        (taskPack.collectibles || []).map(c => c.name)
      );
      for (const [key, value] of Object.entries(partialResult.collectibles)) {
        if (definedCollectibleNames.has(key)) {
          partialCollectibles[key] = value;
        }
      }
    }

    // Log run finish with failure
    logger.log({
      type: 'run_finished',
      data: {
        success: false,
        durationMs,
      },
    });

    // Return partial result with paths even on error
    const failResult: RunTaskPackResult = {
      collectibles: partialCollectibles,
      meta: {
        durationMs,
        notes: `Error at step "${partialResult?.failedStepId ?? 'unknown'}": ${errorMessage}`,
      },
      runDir,
      eventsPath,
      artifactsDir,
    };

    // Include failedStepId for AI agents
    if (partialResult?.failedStepId) {
      (failResult as any).failedStepId = partialResult.failedStepId;
    }

    return failResult;
  } finally {
    // Cleanup using unified browser session close
    if (browserSession) {
      await browserSession.close();
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP-only execution helper
// ---------------------------------------------------------------------------

/**
 * Run a flow in HTTP-only mode using request snapshots.
 * No browser is launched; network_replay steps use Node fetch().
 * Throws if any snapshot response fails validation (caller should fall back to browser mode).
 */
async function runHttpOnly(
  taskPack: TaskPack,
  inputs: Record<string, unknown>,
  snapshots: SnapshotFile,
  secrets: Record<string, string>,
  logger: Logger,
  options: RunTaskPackOptions,
): Promise<RunResult> {
  console.log(`[runner] Running in HTTP-only mode (${Object.keys(snapshots.snapshots).length} snapshots)`);

  // Build a minimal RunContext that doesn't require a browser.
  // In HTTP mode the interpreter skips all DOM steps, so page/browser are never accessed.
  const noopPage = null as unknown as Page;
  const noopBrowser = null as unknown as import('playwright').Browser;
  const noopArtifacts = {
    saveScreenshot: async () => '',
    saveHTML: async () => '',
  };
  const runContext: RunContext = {
    page: noopPage,
    browser: noopBrowser,
    logger,
    artifacts: noopArtifacts,
  };

  const flowResult = await runFlow(runContext, taskPack.flow, {
    inputs,
    auth: taskPack.auth,
    sessionId: options.sessionId,
    profileId: options.profileId,
    cacheDir: options.cacheDir,
    secrets,
    httpMode: true,
    snapshots,
  });

  // Validate responses: re-check each network_replay step's snapshot validation.
  // The actual validation happens inside the step handler via replayFromSnapshot +
  // validateResponse. If validation fails, the step throws and runFlow propagates
  // the error, which the caller catches and falls back to browser mode.

  // Filter collectibles to only include those defined in the pack
  const definedCollectibleNames = new Set(
    (taskPack.collectibles || []).map((c) => c.name),
  );
  const filteredCollectibles: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flowResult.collectibles)) {
    if (definedCollectibleNames.has(key)) {
      filteredCollectibles[key] = value;
    }
  }

  const result: RunResult = {
    collectibles: filteredCollectibles,
    meta: {
      durationMs: flowResult.meta.durationMs,
      notes: `HTTP-only: ${flowResult.meta.stepsExecuted}/${flowResult.meta.stepsTotal} steps`,
    },
  };

  if (flowResult._hints && flowResult._hints.length > 0) {
    result._hints = flowResult._hints;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Snapshot capture helper
// ---------------------------------------------------------------------------

/**
 * After a successful browser run, capture snapshots for all network_replay steps.
 * Uses the resolved vars from the flow result to look up request IDs,
 * then exports full entry data from the network capture buffer.
 * Writes snapshots.json to the pack directory.
 */
function captureSnapshots(
  taskPack: TaskPack,
  flowResult: import('./dsl/types.js').RunFlowResult,
  networkCapture: NetworkCaptureApi,
  packPath: string,
): void {
  const replaySteps = taskPack.flow.filter((s) => s.type === 'network_replay');
  if (replaySteps.length === 0) return;

  const vars = flowResult._vars ?? {};
  const newSnapshots: Record<string, RequestSnapshot> = {};

  for (const step of replaySteps) {
    if (step.type !== 'network_replay') continue;

    // Resolve the requestId template (e.g. "{{vars.reqId}}" → actual ID)
    const rawRequestId = step.params.requestId;
    let requestId: string | undefined;

    // Check if it's a template reference
    const varMatch = rawRequestId.match(/\{\{vars\.([^}]+)\}\}/);
    if (varMatch) {
      const varName = varMatch[1];
      requestId = typeof vars[varName] === 'string' ? (vars[varName] as string) : undefined;
    } else {
      // Literal request ID
      requestId = rawRequestId;
    }

    if (!requestId) continue;

    // Export the full entry from the network capture buffer
    const fullEntry = networkCapture.exportEntry(requestId);
    if (!fullEntry || fullEntry.status === undefined) continue;

    // Build the snapshot
    const snapshot: RequestSnapshot = {
      stepId: step.id,
      capturedAt: Date.now(),
      ttl: null, // indefinite by default
      request: {
        method: fullEntry.method,
        url: fullEntry.url,
        headers: fullEntry.requestHeadersFull,
        body: fullEntry.postData ?? null,
      },
      overrides: step.params.overrides
        ? {
            url: step.params.overrides.url,
            body: step.params.overrides.body,
            setQuery: step.params.overrides.setQuery
              ? Object.fromEntries(
                  Object.entries(step.params.overrides.setQuery).map(([k, v]) => [k, String(v)]),
                )
              : undefined,
            setHeaders: step.params.overrides.setHeaders,
            urlReplace: step.params.overrides.urlReplace
              ? (Array.isArray(step.params.overrides.urlReplace) ? step.params.overrides.urlReplace : [step.params.overrides.urlReplace])
              : undefined,
            bodyReplace: step.params.overrides.bodyReplace
              ? (Array.isArray(step.params.overrides.bodyReplace) ? step.params.overrides.bodyReplace : [step.params.overrides.bodyReplace])
              : undefined,
          }
        : undefined,
      responseValidation: {
        expectedStatus: fullEntry.status ?? 200,
        expectedContentType: fullEntry.contentType ?? 'application/json',
        expectedKeys: extractTopLevelKeys(fullEntry.responseBodyText),
      },
      sensitiveHeaders: detectSensitiveHeaders(fullEntry.requestHeadersFull),
    };

    newSnapshots[step.id] = snapshot;
  }

  if (Object.keys(newSnapshots).length > 0) {
    // Merge with existing snapshots (update existing, add new)
    const existing = taskPack.snapshots ?? { version: 1, snapshots: {} };
    const merged: SnapshotFile = {
      version: 1,
      snapshots: { ...existing.snapshots, ...newSnapshots },
    };
    writeSnapshots(packPath, merged);
    console.log(
      `[runner] Captured ${Object.keys(newSnapshots).length} snapshot(s) → snapshots.json`,
    );
  }
}
