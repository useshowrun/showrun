/**
 * showrun config <subcommand> - Configuration management
 */

import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { cwd } from 'process';
import {
  discoverConfigDirs,
  loadConfig,
  getGlobalConfigDir,
  ensureDir,
  atomicWrite,
  DEFAULT_CONFIG_TEMPLATE,
} from '@showrun/core';
import type { ShowRunConfig } from '@showrun/core';

export function printConfigHelp(): void {
  console.log(`
Usage: showrun config <subcommand> [options]

Configuration management

Subcommands:
  init [--global]         Create config directory with default config.json
  show                    Show fully resolved configuration
  path                    List all config directories searched

Options:
  --global                (init) Create in global config directory instead of cwd

Examples:
  showrun config init                  # Create .showrun/ in current directory
  showrun config init --global         # Create in ~/.config/showrun/ (Linux/macOS) or %APPDATA%\\showrun (Windows)
  showrun config show                  # Print merged configuration
  showrun config path                  # List search directories
`);
}

/**
 * Create config directory and default config.json
 */
async function cmdConfigInit(args: string[]): Promise<void> {
  const isGlobal = args.includes('--global');

  let configDir: string;
  if (isGlobal) {
    configDir = getGlobalConfigDir();
  } else {
    configDir = join(resolve(cwd()), '.showrun');
  }

  const configPath = join(configDir, 'config.json');

  ensureDir(configDir);

  if (existsSync(configPath)) {
    console.log(`[Config] config.json already exists at ${configPath}`);
  } else {
    const content = JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2) + '\n';
    atomicWrite(configPath, content);
    console.log(`[Config] Created ${configPath}`);
  }

  console.log(`[Config] Config directory ready: ${configDir}`);
}

/**
 * Show fully resolved configuration
 */
async function cmdConfigShow(): Promise<void> {
  const { config, loadedFiles, searchedDirs } = loadConfig();

  if (loadedFiles.length === 0) {
    console.log('No config files found. Run `showrun config init` to create one.');
    console.log('');
    console.log('Searched directories:');
    for (const dir of searchedDirs) {
      const exists = existsSync(dir);
      console.log(`  ${exists ? '+' : '-'} ${dir}`);
    }
    return;
  }

  console.log('Loaded config files (lowest → highest priority):');
  for (const file of loadedFiles) {
    console.log(`  ${file}`);
  }
  console.log('');
  console.log('Resolved configuration:');
  console.log(JSON.stringify(config, null, 2));
}

/**
 * List all config directories searched
 */
async function cmdConfigPath(): Promise<void> {
  const dirs = discoverConfigDirs();
  console.log('Config directory search order (lowest → highest priority):');
  console.log('');
  for (const dir of dirs) {
    const exists = existsSync(dir);
    const hasConfig = existsSync(join(dir, 'config.json'));
    let status = '-';
    if (hasConfig) status = '*';
    else if (exists) status = '+';
    console.log(`  ${status} ${dir}`);
  }
  console.log('');
  console.log('Legend: * = has config.json, + = directory exists, - = not found');
}

/**
 * Main config command dispatcher
 */
export async function cmdConfig(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'init':
      await cmdConfigInit(subArgs);
      break;
    case 'show':
      await cmdConfigShow();
      break;
    case 'path':
      await cmdConfigPath();
      break;
    default:
      if (subcommand) {
        console.error(`Unknown config subcommand: ${subcommand}`);
      }
      printConfigHelp();
      process.exit(subcommand ? 1 : 0);
  }
}
