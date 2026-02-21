/**
 * First-run setup wizard for ShowRun.
 * Interactively prompts for required and optional configuration values
 * when ANTHROPIC_API_KEY is not set anywhere in the config chain.
 */

import { createInterface } from 'readline';
import { join, dirname, resolve } from 'path';
import { existsSync, cpSync } from 'fs';
import { fileURLToPath } from 'url';
import { updateGlobalConfig, getGlobalConfigDir, getGlobalDataDir, ensureDir } from '@showrun/core';

interface SetupField {
  envVar: string;
  label: string;
  required: boolean;
  defaultValue: string | (() => string);
}

/** Compute the default taskpacks directory (cross-platform). */
function getDefaultTaskpacksDir(): string {
  return join(getGlobalDataDir(), 'taskpacks');
}

const SETUP_FIELDS: SetupField[] = [
  {
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API Key',
    required: true,
    defaultValue: '',
  },
  {
    envVar: 'ANTHROPIC_MODEL',
    label: 'Anthropic Model',
    required: true,
    defaultValue: 'claude-opus-4-5-20251101',
  },
  {
    envVar: 'ANTHROPIC_BASE_URL',
    label: 'Anthropic Base URL',
    required: true,
    defaultValue: 'https://api.anthropic.com',
  },
  {
    envVar: 'SHOWRUN_TASKPACKS_DIR',
    label: 'Taskpacks Directory',
    required: false,
    defaultValue: getDefaultTaskpacksDir,
  },
  {
    envVar: 'WEAVIATE_URL',
    label: 'Weaviate URL (for Techniques DB)',
    required: false,
    defaultValue: '',
  },
  {
    envVar: 'WEAVIATE_API_KEY',
    label: 'Weaviate API Key',
    required: false,
    defaultValue: '',
  },
  {
    envVar: 'EMBEDDING_MODEL',
    label: 'Embedding Model',
    required: false,
    defaultValue: 'text-embedding-3-small',
  },
];

function promptLine(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Check whether the setup wizard should run.
 * Returns true if ANTHROPIC_API_KEY is not set in env, .env, or config.json.
 * Call AFTER initConfig() and .env loading.
 */
export function needsSetup(): boolean {
  return !process.env.ANTHROPIC_API_KEY;
}

/**
 * Get the directory where bundled templates live (dist/templates/).
 * Works for both direct node execution and npm-installed binaries.
 */
function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // In built output: dist/cli.js → dist/templates/
  // In dev: src/setupWizard.ts → ../../dist/templates/ (after build)
  const distDir = dirname(thisFile);
  return join(distDir, 'templates');
}

/**
 * Copy the bundled example-json taskpack into the target taskpacks directory.
 * Skips if the example pack already exists there.
 */
function seedExamplePack(taskpacksDir: string): void {
  const templatesDir = getTemplatesDir();
  const exampleSrc = join(templatesDir, 'example-json');
  const exampleDest = join(taskpacksDir, 'example-json');

  if (existsSync(exampleDest)) {
    return; // Already seeded
  }

  if (!existsSync(exampleSrc)) {
    // Template not bundled (e.g. running from source without build)
    return;
  }

  ensureDir(taskpacksDir);
  cpSync(exampleSrc, exampleDest, { recursive: true });
  console.log(`  Copied example taskpack to ${exampleDest}`);
}

/**
 * Run the interactive first-run setup wizard.
 * Prompts for configuration values and saves them to the global config.json.
 * Also sets the values in process.env for the current session.
 *
 * Returns true if setup completed successfully, false if user cancelled.
 */
export async function runSetupWizard(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Handle Ctrl+C gracefully
  let cancelled = false;
  rl.on('close', () => {
    cancelled = true;
  });

  try {
    console.log('');
    console.log('=== ShowRun First-Run Setup ===');
    console.log('');
    console.log('No Anthropic API key found. Let\'s set up your configuration.');
    console.log(`Settings will be saved to: ${getGlobalConfigDir()}/config.json`);
    console.log(`Data will be stored in:    ${getGlobalDataDir()}/`);
    console.log('');
    console.log('Press Ctrl+C to cancel at any time.');
    console.log('');

    const values: Record<string, string> = {};

    for (const field of SETUP_FIELDS) {
      if (cancelled) return false;

      const resolvedDefault = typeof field.defaultValue === 'function'
        ? field.defaultValue()
        : field.defaultValue;

      let hint: string;
      if (field.required && resolvedDefault) {
        hint = ` (default: ${resolvedDefault})`;
      } else if (field.required) {
        hint = ' [required]';
      } else if (resolvedDefault) {
        hint = ` (optional, default: ${resolvedDefault})`;
      } else {
        hint = ' (optional, press Enter to skip)';
      }

      const promptText = `  ${field.label}${hint}: `;

      let value = '';
      while (true) {
        if (cancelled) return false;
        value = await promptLine(rl, promptText);

        if (!value && resolvedDefault) {
          value = resolvedDefault;
          console.log(`    -> ${value}`);
        }

        // Resolve relative paths to absolute for directory fields
        if (value && field.envVar === 'SHOWRUN_TASKPACKS_DIR') {
          value = resolve(value);
        }

        if (field.required && !value) {
          console.log('    This field is required. Please enter a value.');
          continue;
        }

        break;
      }

      if (value) {
        values[field.envVar] = value;
        process.env[field.envVar] = value;
      }
    }

    if (cancelled) return false;

    console.log('');
    console.log('Saving configuration...');
    updateGlobalConfig(values);
    console.log(`Configuration saved to ${getGlobalConfigDir()}/config.json`);

    // Seed example taskpack into the configured directory
    const taskpacksDir = values['SHOWRUN_TASKPACKS_DIR'];
    if (taskpacksDir) {
      ensureDir(taskpacksDir);
      seedExamplePack(taskpacksDir);
    }

    console.log('');
    console.log('You can update these settings later by editing the config file directly,');
    console.log('or by running: showrun config init --global');
    console.log('');

    return true;
  } finally {
    rl.close();
  }
}
