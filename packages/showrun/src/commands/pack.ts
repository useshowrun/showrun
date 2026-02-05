/**
 * showrun pack <subcommand> - Pack management commands
 */

import { resolve } from 'path';
import { existsSync } from 'fs';
import { cwd } from 'process';
import {
  TaskPackLoader,
  validateJsonTaskPack,
  sanitizePackId,
  ensureDir,
  writeTaskPackManifest,
  writeFlowJson,
  readJsonFile,
} from '@showrun/core';
import type { TaskPackManifest, InputSchema, CollectibleDefinition, DslStep } from '@showrun/core';

/**
 * Parse JSON from string or file path
 */
function parseJsonInput(input: string): unknown {
  // Try as file path first
  if (existsSync(input)) {
    try {
      return readJsonFile(input);
    } catch {
      // Fall through to try as JSON string
    }
  }

  // Try as JSON string
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Create a new JSON Task Pack
 */
export async function cmdPackCreate(args: string[]): Promise<void> {
  let packsDir: string | undefined;
  let packId: string | undefined;
  let packName: string | undefined;
  let template: string = 'basic';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--dir':
        if (!next || next.startsWith('--')) {
          throw new Error('--dir requires a directory path');
        }
        packsDir = resolve(cwd(), next);
        i++;
        break;
      case '--id':
        if (!next || next.startsWith('--')) {
          throw new Error('--id requires a pack ID');
        }
        packId = next;
        i++;
        break;
      case '--name':
        if (!next || next.startsWith('--')) {
          throw new Error('--name requires a pack name');
        }
        packName = next;
        i++;
        break;
      case '--template':
        if (!next || next.startsWith('--')) {
          throw new Error('--template requires a template name');
        }
        template = next;
        i++;
        break;
    }
  }

  if (!packsDir) {
    throw new Error('--dir is required');
  }
  if (!packId) {
    throw new Error('--id is required');
  }
  if (!packName) {
    throw new Error('--name is required');
  }

  // Validate pack ID format
  if (!/^[a-zA-Z0-9._-]+$/.test(packId)) {
    throw new Error('Pack ID must contain only alphanumeric characters, dots, underscores, and hyphens');
  }

  // Sanitize and create directory
  const sanitizedId = sanitizePackId(packId);
  const packDir = resolve(packsDir, sanitizedId);

  if (existsSync(packDir)) {
    throw new Error(`Pack directory already exists: ${packDir}`);
  }

  ensureDir(packDir);

  // Create taskpack.json
  const manifest: TaskPackManifest = {
    id: packId,
    name: packName,
    version: '0.1.0',
    description: '',
    kind: 'json-dsl',
  };

  writeTaskPackManifest(packDir, manifest);

  // Create flow.json with template
  const flowData: {
    inputs: InputSchema;
    collectibles: CollectibleDefinition[];
    flow: DslStep[];
  } = {
    inputs: {},
    collectibles: [],
    flow: template === 'basic' ? [
      {
        id: 'navigate',
        type: 'navigate',
        label: 'Navigate to page',
        params: {
          url: 'https://example.com',
          waitUntil: 'networkidle',
        },
      },
    ] : [],
  };

  writeFlowJson(packDir, flowData);

  console.log(`Created JSON Task Pack: ${packDir}`);
  console.log(`  ID: ${packId}`);
  console.log(`  Name: ${packName}`);
  console.log(`  Files: taskpack.json, flow.json`);
}

/**
 * Validate a Task Pack
 */
export async function cmdPackValidate(args: string[]): Promise<void> {
  let packPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--path') {
      if (!next || next.startsWith('--')) {
        throw new Error('--path requires a pack directory path');
      }
      packPath = resolve(cwd(), next);
      i++;
    }
  }

  if (!packPath) {
    throw new Error('--path is required');
  }

  if (!existsSync(packPath)) {
    throw new Error(`Pack directory not found: ${packPath}`);
  }

  try {
    const pack = await TaskPackLoader.loadTaskPack(packPath);
    validateJsonTaskPack(pack);
    console.log(`✓ Task pack is valid: ${pack.metadata.id} v${pack.metadata.version}`);
  } catch (error) {
    console.error(`✗ Validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Set flow.json for a pack
 */
export async function cmdPackSetFlow(args: string[]): Promise<void> {
  let packPath: string | undefined;
  let flowInput: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--path') {
      if (!next || next.startsWith('--')) {
        throw new Error('--path requires a pack directory path');
      }
      packPath = resolve(cwd(), next);
      i++;
    } else if (arg === '--flow') {
      if (!next || next.startsWith('--')) {
        throw new Error('--flow requires JSON string or file path');
      }
      flowInput = next;
      i++;
    }
  }

  if (!packPath) {
    throw new Error('--path is required');
  }
  if (!flowInput) {
    throw new Error('--flow is required');
  }

  if (!existsSync(packPath)) {
    throw new Error(`Pack directory not found: ${packPath}`);
  }

  // Load manifest to verify it's a json-dsl pack
  const manifest = TaskPackLoader.loadManifest(packPath);
  if (manifest.kind !== 'json-dsl') {
    throw new Error('Pack is not a json-dsl pack. Use --kind json-dsl when creating.');
  }

  // Parse flow input
  const flowData = parseJsonInput(flowInput) as {
    inputs?: InputSchema;
    collectibles?: CollectibleDefinition[];
    flow: DslStep[];
  };

  if (!flowData.flow || !Array.isArray(flowData.flow)) {
    throw new Error('Flow data must have a "flow" array');
  }

  // Write flow.json (validates before writing)
  writeFlowJson(packPath, flowData);
  console.log(`✓ Updated flow.json for pack: ${manifest.id}`);
}

/**
 * Set taskpack.json metadata for a pack
 */
export async function cmdPackSetMeta(args: string[]): Promise<void> {
  let packPath: string | undefined;
  let metaInput: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--path') {
      if (!next || next.startsWith('--')) {
        throw new Error('--path requires a pack directory path');
      }
      packPath = resolve(cwd(), next);
      i++;
    } else if (arg === '--meta') {
      if (!next || next.startsWith('--')) {
        throw new Error('--meta requires JSON string or file path');
      }
      metaInput = next;
      i++;
    }
  }

  if (!packPath) {
    throw new Error('--path is required');
  }
  if (!metaInput) {
    throw new Error('--meta is required');
  }

  if (!existsSync(packPath)) {
    throw new Error(`Pack directory not found: ${packPath}`);
  }

  // Parse meta input
  const meta = parseJsonInput(metaInput) as Partial<TaskPackManifest>;

  // Load existing manifest and merge
  const existing = TaskPackLoader.loadManifest(packPath);
  const updated: TaskPackManifest = {
    ...existing,
    ...meta,
    // Ensure kind is preserved for json-dsl packs
    kind: existing.kind === 'json-dsl' ? 'json-dsl' : meta.kind,
  };

  // Validate required fields
  if (!updated.id || !updated.name || !updated.version) {
    throw new Error('Metadata must include id, name, and version');
  }

  // Write taskpack.json
  writeTaskPackManifest(packPath, updated);
  console.log(`✓ Updated taskpack.json for pack: ${updated.id}`);
}

/**
 * Handle pack subcommand
 */
export async function cmdPack(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subcommandArgs = args.slice(1);

  try {
    switch (subcommand) {
      case 'create':
        await cmdPackCreate(subcommandArgs);
        break;
      case 'validate':
        await cmdPackValidate(subcommandArgs);
        break;
      case 'set-flow':
        await cmdPackSetFlow(subcommandArgs);
        break;
      case 'set-meta':
        await cmdPackSetMeta(subcommandArgs);
        break;
      case undefined:
      case '--help':
      case '-h':
        printPackHelp();
        break;
      default:
        throw new Error(`Unknown pack command: ${subcommand}. Use --help for usage.`);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export function printPackHelp(): void {
  console.log(`
Usage: showrun pack <command> [options]

Pack management commands

Commands:
  create        Create a new JSON Task Pack
    --dir <path>       Packs directory (required)
    --id <id>          Pack ID (required)
    --name <name>      Pack name (required)
    --template <name>  Template: basic (default)

  validate      Validate a Task Pack
    --path <path>      Pack directory (required)

  set-flow      Update flow.json for a JSON pack
    --path <path>      Pack directory (required)
    --flow <json|file> Flow JSON string or file path (required)

  set-meta      Update taskpack.json metadata
    --path <path>      Pack directory (required)
    --meta <json|file> Metadata JSON string or file path (required)

Examples:
  showrun pack create --dir ./taskpacks --id my.pack --name "My Pack"
  showrun pack validate --path ./taskpacks/my_pack
  showrun pack set-flow --path ./taskpacks/my_pack --flow '{"flow":[...]}'
  showrun pack set-meta --path ./taskpacks/my_pack --meta '{"description":"..."}'
`);
}
