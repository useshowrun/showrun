/**
 * showrun run <pack> - Run a task pack
 */

import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { runPack, SQLiteResultStore } from '@showrun/harness';
import { TaskPackLoader, generateResultKey } from '@showrun/core';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_VALIDATION_ERROR = 2;

const REPORT_REMINDER =
  '\n[ShowRun] If this task pack produced incorrect results or behaved unexpectedly,\n' +
  'report it: showrun registry report <pack-id>\n';

export interface RunCommandOptions {
  packPath: string;
  inputs: Record<string, unknown>;
  headful: boolean;
  baseRunDir: string;
  cdpUrl?: string;
  noResultStore: boolean;
}

export function parseRunArgs(args: string[]): RunCommandOptions {
  let packPath: string | null = null;
  let inputsJson: string | null = null;
  let headful = false;
  let baseRunDir = './runs';
  let cdpUrl: string | undefined;
  let noResultStore = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--inputs' && next) {
      inputsJson = next;
      i++;
    } else if (arg === '--headful') {
      headful = true;
    } else if (arg === '--baseRunDir' && next) {
      baseRunDir = next;
      i++;
    } else if (arg === '--cdp-url' && next) {
      cdpUrl = next;
      i++;
    } else if (arg === '--no-result-store') {
      noResultStore = true;
    } else if (!arg.startsWith('-') && !packPath) {
      packPath = arg;
    }
  }

  if (!packPath) {
    console.error('Error: Pack path is required');
    console.error('Usage: showrun run <pack> [--inputs <json>] [--headful] [--cdp-url <url>] [--no-result-store] [--baseRunDir <dir>]');
    process.exit(EXIT_VALIDATION_ERROR);
  }

  let inputs: Record<string, unknown> = {};
  if (inputsJson) {
    try {
      inputs = JSON.parse(inputsJson);
    } catch (error) {
      console.error(`Error: Invalid JSON in --inputs: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(EXIT_VALIDATION_ERROR);
    }
  }

  return { packPath, inputs, headful, baseRunDir, cdpUrl, noResultStore };
}

export async function cmdRun(args: string[]): Promise<void> {
  const { packPath, inputs, headful, baseRunDir, cdpUrl, noResultStore } = parseRunArgs(args);
  const resolvedPackPath = resolve(packPath);

  if (!existsSync(resolvedPackPath)) {
    console.error(`Error: Task pack directory not found: ${resolvedPackPath}`);
    process.exit(EXIT_VALIDATION_ERROR);
  }

  // ─── Pre-flight: check secrets ────────────────────────────────────
  try {
    const manifest = TaskPackLoader.loadManifest(resolvedPackPath);
    if (manifest.secrets && manifest.secrets.length > 0) {
      const secrets = TaskPackLoader.loadSecrets(resolvedPackPath);
      const missing = manifest.secrets
        .filter(s => s.required !== false)
        .filter(s => !secrets[s.name]);

      if (missing.length > 0) {
        const secretsPath = join(resolvedPackPath, '.secrets.json');
        console.error(`\nError: Missing required secrets: ${missing.map(s => s.name).join(', ')}`);
        console.error(`\nSecrets file location: ${secretsPath}`);
        console.error(`\nTo fix, create the file with this format:`);
        console.error(JSON.stringify({
          version: 1,
          secrets: Object.fromEntries(
            manifest.secrets.map(s => [s.name, `<${s.description || 'your ' + s.name}>`])
          ),
        }, null, 2));
        process.exit(EXIT_VALIDATION_ERROR);
      }
    }
  } catch (err) {
    // If manifest can't be loaded, let runPack handle the error
    if ((err as Error).message?.includes('Missing required secrets')) {
      throw err;
    }
  }

  // ─── Run ──────────────────────────────────────────────────────────
  try {
    const result = await runPack({
      packPath: resolvedPackPath,
      inputs,
      headful,
      baseRunDir,
      cdpUrl,
    });

    // ─── Result storage ───────────────────────────────────────────
    const LARGE_RESULT_THRESHOLD = 10_000;
    let resultKey: string | undefined;

    try {
      const taskPack = await TaskPackLoader.loadTaskPack(resolvedPackPath);
      resultKey = generateResultKey(taskPack.metadata.id, inputs);

      if (!noResultStore) {
        const store = new SQLiteResultStore(join(resolvedPackPath, 'results.db'));
        await store.store({
          key: resultKey,
          packId: taskPack.metadata.id,
          toolName: `showrun_${taskPack.metadata.id.replace(/[^a-zA-Z0-9_]/g, '_')}`,
          inputs,
          collectibles: result.collectibles,
          meta: result.meta,
          collectibleSchema: (taskPack.collectibles || []).map(c => ({
            name: c.name,
            type: c.type,
            description: c.description,
          })),
          storedAt: new Date().toISOString(),
          ranAt: new Date().toISOString(),
          version: 1,
        });
        await store.close();
        console.error(`[ShowRun] Result stored (key: ${resultKey})`);
      }
    } catch (storeErr) {
      console.error(`[ShowRun] Failed to store result: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`);
    }

    // ─── Output ───────────────────────────────────────────────────
    const fullJson = JSON.stringify(result, null, 2);

    if (resultKey && fullJson.length > LARGE_RESULT_THRESHOLD) {
      // Large result: output preview + storage info
      const preview = {
        ...result,
        collectibles: '<<truncated — use "showrun results query" to access full data>>',
        _resultKey: resultKey,
        _preview: JSON.stringify(result.collectibles).slice(0, 2000),
      };
      console.log(JSON.stringify(preview, null, 2));
    } else {
      // Normal result: output full data + key
      const output = resultKey ? { ...result, _resultKey: resultKey } : result;
      console.log(JSON.stringify(output, null, 2));
    }

    // Post-run reminder
    console.error(REPORT_REMINDER);
    process.exit(EXIT_SUCCESS);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('validation failed') || errorMessage.includes('Missing required field')) {
      console.error(`Validation Error: ${errorMessage}`);

      // Print input schema for actionable feedback
      try {
        const taskPack = await TaskPackLoader.loadTaskPack(resolvedPackPath);
        if (Object.keys(taskPack.inputs).length > 0) {
          console.error('\nRequired inputs:');
          for (const [name, def] of Object.entries(taskPack.inputs)) {
            const req = def.required ? '(required)' : '(optional)';
            const dflt = def.default !== undefined ? `, default: ${JSON.stringify(def.default)}` : '';
            console.error(`  --inputs '{"${name}": <${def.type}>}'  ${req}${dflt}  ${def.description || ''}`);
          }
        }
      } catch {
        // Ignore — we already have the main error message
      }

      console.error(REPORT_REMINDER);
      process.exit(EXIT_VALIDATION_ERROR);
    }

    console.error(`Error: ${errorMessage}`);
    console.error(REPORT_REMINDER);
    process.exit(EXIT_FAILURE);
  }
}

export function printRunHelp(): void {
  console.log(`
Usage: showrun run <pack> [options]

Run a task pack

Arguments:
  <pack>                 Path to task pack directory

Options:
  --inputs <json>        Input values as JSON string (default: {})
  --headful              Run browser in headful mode
  --cdp-url <url>        Connect to an existing Chrome browser via CDP
  --no-result-store      Disable auto-storing results to SQLite
  --baseRunDir <dir>     Directory for run outputs (default: ./runs)

Examples:
  showrun run ./taskpacks/example
  showrun run ./taskpacks/example --inputs '{"query": "test"}'
  showrun run ./taskpacks/example --headful
  showrun run ./taskpacks/example --cdp-url http://localhost:9222
  showrun run ./taskpacks/example --no-result-store
`);
}
