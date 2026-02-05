/**
 * showrun run <pack> - Run a task pack
 */

import { resolve } from 'path';
import { existsSync } from 'fs';
import { runPack } from '@showrun/harness';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_VALIDATION_ERROR = 2;

export interface RunCommandOptions {
  packPath: string;
  inputs: Record<string, unknown>;
  headful: boolean;
  baseRunDir: string;
}

export function parseRunArgs(args: string[]): RunCommandOptions {
  let packPath: string | null = null;
  let inputsJson: string | null = null;
  let headful = false;
  let baseRunDir = './runs';

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
    } else if (!arg.startsWith('-') && !packPath) {
      packPath = arg;
    }
  }

  if (!packPath) {
    console.error('Error: Pack path is required');
    console.error('Usage: showrun run <pack> [--inputs <json>] [--headful] [--baseRunDir <dir>]');
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

  return { packPath, inputs, headful, baseRunDir };
}

export async function cmdRun(args: string[]): Promise<void> {
  try {
    const { packPath, inputs, headful, baseRunDir } = parseRunArgs(args);
    const resolvedPackPath = resolve(packPath);

    if (!existsSync(resolvedPackPath)) {
      console.error(`Error: Task pack directory not found: ${resolvedPackPath}`);
      process.exit(EXIT_VALIDATION_ERROR);
    }

    const result = await runPack({
      packPath: resolvedPackPath,
      inputs,
      headful,
      baseRunDir,
    });

    // Output result
    console.log(JSON.stringify(result, null, 2));
    process.exit(EXIT_SUCCESS);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('validation failed') || errorMessage.includes('Missing required field')) {
      console.error(`Validation Error: ${errorMessage}`);
      process.exit(EXIT_VALIDATION_ERROR);
    }

    console.error(`Error: ${errorMessage}`);
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
  --baseRunDir <dir>     Directory for run outputs (default: ./runs)

Examples:
  showrun run ./taskpacks/example
  showrun run ./taskpacks/example --inputs '{"query": "test"}'
  showrun run ./taskpacks/example --headful
`);
}
