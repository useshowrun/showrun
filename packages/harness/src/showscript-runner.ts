/**
 * ShowScript Runner
 *
 * High-level runner for .showscript files. Parses the source,
 * processes inputs/outputs blocks, and executes the flow via the interpreter.
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { Page, Browser, BrowserContext } from 'playwright';
import { parse } from '@showrun/showscript';
import type { Program, InputsBlock, OutputsBlock, InputDeclaration } from '@showrun/showscript';
import type { Logger, RunResult } from '@showrun/core';
import {
  executeShowScript,
  type ShowScriptContext,
  type ShowScriptOptions,
} from './showscript-interpreter.js';
import type { NetworkCaptureApi } from '@showrun/core';

// ─── Types ──────────────────────────────────────────────────

export interface ShowScriptRunOptions {
  /** Path to the .showscript file */
  scriptPath: string;
  /** OR: provide source string directly */
  source?: string;
  /** Input values */
  inputs?: Record<string, unknown>;
  /** Secret values */
  secrets?: Record<string, string>;
  /** Playwright page to use */
  page: Page;
  /** Browser instance */
  browser: Browser;
  /** Browser context for multi-tab support */
  browserContext?: BrowserContext;
  /** Network capture API */
  networkCapture?: NetworkCaptureApi;
  /** Logger for events */
  logger?: Logger;
  /** Pack directory for resolving relative paths */
  packDir?: string;
  /** Default timeout for steps */
  timeoutMs?: number;
}

export interface ShowScriptRunResult extends RunResult {
  /** Parsed AST (useful for inspection) */
  ast: Program;
}

// ─── Input Validation ───────────────────────────────────────

function validateInputs(
  ast: Program,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const validated = { ...inputs };
  const inputBlock = ast.blocks.find((b): b is InputsBlock => b.type === 'InputsBlock');

  if (!inputBlock) return validated;

  for (const decl of inputBlock.declarations) {
    if (!(decl.name in validated)) {
      if (decl.defaultValue) {
        // Default will be applied by the interpreter
        continue;
      }
      // Check if it's required (no default value)
      throw new Error(
        `Missing required input: "${decl.name}" (type: ${decl.typeSpec})`,
      );
    }

    // Basic type coercion
    validated[decl.name] = coerceInput(decl, validated[decl.name]);
  }

  return validated;
}

function coerceInput(decl: InputDeclaration, value: unknown): unknown {
  switch (decl.typeSpec) {
    case 'string':
    case 'secret':
      return value == null ? '' : String(value);
    case 'number':
      return Number(value);
    case 'bool':
      if (typeof value === 'string') {
        return value === 'true' || value === '1';
      }
      return Boolean(value);
    case 'array':
    case 'object':
      return value;
    default:
      return value;
  }
}

// ─── Runner ─────────────────────────────────────────────────

export async function runShowScript(
  options: ShowScriptRunOptions,
): Promise<ShowScriptRunResult> {
  const startTime = Date.now();

  // Parse source
  let source: string;
  if (options.source) {
    source = options.source;
  } else {
    const resolvedPath = resolve(options.scriptPath);
    source = await readFile(resolvedPath, 'utf-8');
  }

  const ast = parse(source, {
    filename: options.scriptPath,
  });

  // Extract metadata
  const metaBlock = ast.blocks.find((b) => b.type === 'MetaBlock');
  let packId = 'showscript';
  let packVersion = '0.0.0';
  if (metaBlock?.type === 'MetaBlock') {
    const idField = metaBlock.fields.find((f) => f.name === 'id');
    if (idField && 'value' in idField.value) {
      packId = String(idField.value.value);
    }
    const versionField = metaBlock.fields.find((f) => f.name === 'version');
    if (versionField && 'value' in versionField.value) {
      packVersion = String(versionField.value.value);
    }
  }

  // Validate inputs
  const validatedInputs = validateInputs(ast, options.inputs ?? {});

  // Log run start
  options.logger?.log({
    type: 'run_started',
    data: { packId, packVersion, inputs: validatedInputs },
  });

  // Build context
  const ctx: ShowScriptContext = {
    page: options.page,
    browserContext: options.browserContext,
    vars: {},
    inputs: validatedInputs,
    secrets: options.secrets,
    collectibles: {},
    networkCapture: options.networkCapture,
    packDir: options.packDir,
  };

  const interpreterOptions: ShowScriptOptions = {
    timeoutMs: options.timeoutMs,
    onStepStart: (name, _args) => {
      options.logger?.log({
        type: 'step_started',
        data: { stepId: name, type: name },
      });
    },
    onStepFinish: (name, durationMs) => {
      options.logger?.log({
        type: 'step_finished',
        data: { stepId: name, type: name, durationMs },
      });
    },
  };

  let success = false;
  try {
    const outputs = await executeShowScript(ast, ctx, interpreterOptions);

    // Merge outputs into collectibles
    for (const [key, value] of Object.entries(outputs)) {
      ctx.collectibles[key] = value;
    }

    success = true;

    const durationMs = Date.now() - startTime;
    options.logger?.log({
      type: 'run_finished',
      data: { success: true, durationMs },
    });

    return {
      ast,
      collectibles: ctx.collectibles,
      meta: {
        url: options.page.url(),
        durationMs,
      },
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    options.logger?.log({
      type: 'error',
      data: { error: message },
    });
    options.logger?.log({
      type: 'run_finished',
      data: { success: false, durationMs },
    });

    throw err;
  }
}
