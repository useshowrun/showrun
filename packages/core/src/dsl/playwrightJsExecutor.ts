/**
 * Sandboxed executor for playwright-js task packs.
 *
 * Runs user-provided Playwright JavaScript in a best-effort sandbox:
 * - Dangerous Node.js globals are shadowed via AsyncFunction parameters
 * - inputs and secrets are passed as frozen copies (read-only)
 * - page, context, frame have full Playwright access
 *
 * NOTE: This is NOT a hard security boundary. A determined attacker could
 * escape via prototype chain tricks. Trust is managed at the registry level.
 */

import type { Page, BrowserContext, Frame } from 'playwright';
import type { NetworkCaptureApi } from '../networkCapture.js';

/**
 * Globals shadowed inside user code (passed as undefined).
 */
const BLOCKED_GLOBALS = [
  'process', 'require', 'module', 'exports',
  '__dirname', '__filename', 'global', 'globalThis',
  'Buffer', 'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'fetch', 'XMLHttpRequest', 'eval', 'Function', 'Deno', 'Bun',
];

/**
 * Scope provided to user code.
 */
export interface PlaywrightJsScope {
  page: Page;
  context: BrowserContext;
  frame: Frame;
  inputs: Record<string, unknown>;
  secrets: Record<string, string>;
  showrun: {
    network: {
      list: NetworkCaptureApi['list'];
      find: NetworkCaptureApi['find'];
      get: NetworkCaptureApi['get'];
      replay: NetworkCaptureApi['replay'];
    };
  };
}

/**
 * Result from executing a playwright-js flow.
 */
export interface PlaywrightJsResult {
  collectibles: Record<string, unknown>;
  logs: string[];
  error?: string;
}

/**
 * Extract the function body from a `module.exports = async function(...) { BODY }` pattern.
 * Also supports `module.exports = async (...) => { BODY }` arrow functions.
 */
export function extractFunctionBody(code: string): string {
  // Match module.exports = async function(...) { BODY }
  // or module.exports = async (...) => { BODY }
  const patterns = [
    // async function with destructuring or params
    /module\.exports\s*=\s*async\s+function\s*\([^)]*\)\s*\{/,
    // async arrow with destructuring or params
    /module\.exports\s*=\s*async\s*\([^)]*\)\s*=>\s*\{/,
  ];

  for (const pattern of patterns) {
    const match = code.match(pattern);
    if (match) {
      const startIdx = match.index! + match[0].length;
      // Find matching closing brace
      let depth = 1;
      let i = startIdx;
      while (i < code.length && depth > 0) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') depth--;
        i++;
      }
      if (depth === 0) {
        return code.slice(startIdx, i - 1).trim();
      }
    }
  }

  throw new Error(
    'Could not parse flow.playwright.js: expected `module.exports = async function({ page, context, frame, inputs, secrets }) { ... }` pattern.'
  );
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const AsyncFunction: new (...args: string[]) => (...args: unknown[]) => Promise<unknown> =
  Object.getPrototypeOf(async function () {}).constructor;

/**
 * Execute a playwright-js flow in a sandboxed context.
 *
 * @param code       Raw source of flow.playwright.js
 * @param scope      Playwright objects + inputs/secrets
 * @param timeoutMs  Maximum execution time (default 5 minutes)
 * @returns          The return value from the user function (collectibles object)
 */
export async function executePlaywrightJs(
  code: string,
  scope: PlaywrightJsScope,
  timeoutMs = 5 * 60 * 1000,
): Promise<PlaywrightJsResult> {
  const functionBody = extractFunctionBody(code);

  // Capture console.log output from user code
  const logs: string[] = [];
  const customConsole = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => logs.push(`[error] ${args.map(String).join(' ')}`),
    info: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
  };

  // Build the sandboxed function:
  // Blocked globals are function parameters, passed as undefined to shadow them.
  // Scope variables (page, context, etc.) are also parameters.
  const fn = new AsyncFunction(
    ...BLOCKED_GLOBALS,
    'page', 'context', 'frame', 'inputs', 'secrets', 'showrun', 'console',
    functionBody,
  );

  // Freeze inputs and secrets so user code cannot mutate them
  const frozenInputs = Object.freeze({ ...scope.inputs });
  const frozenSecrets = Object.freeze({ ...scope.secrets });

  // Build args: undefined for each blocked global, then scope values
  const blockedArgs = BLOCKED_GLOBALS.map(() => undefined);
  const args = [
    ...blockedArgs,
    scope.page,
    scope.context,
    scope.frame,
    frozenInputs,
    frozenSecrets,
    scope.showrun,
    customConsole,
  ];

  // Execute with timeout, wrapped in try-catch to handle browser/page closure errors
  let result: unknown;
  try {
    result = await Promise.race([
      fn(...args),
      new Promise<never>((_, reject) => {
        const timer = globalThis.setTimeout(() => {
          reject(new Error(`playwright-js execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // Allow Node.js to exit even if timer is pending
        if (typeof timer === 'object' && 'unref' in timer) {
          timer.unref();
        }
      }),
    ]);
  } catch (error) {
    // Handle flow execution errors gracefully instead of crashing
    const errorMessage = error instanceof Error ? error.message : String(error);
    logs.push(`[error] Flow execution failed: ${errorMessage}`);
    return {
      collectibles: {},
      logs,
      error: errorMessage,
    } as PlaywrightJsResult;
  }

  // Normalize result: if null/undefined, return empty object
  let collectibles: Record<string, unknown>;
  if (result == null) {
    collectibles = {};
  } else if (typeof result !== 'object' || Array.isArray(result)) {
    collectibles = { _result: result };
  } else {
    collectibles = result as Record<string, unknown>;
  }

  return { collectibles, logs };
}
