#!/usr/bin/env node

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { cwd } from 'process';

// Load .env from cwd or nearest ancestor
(function loadEnv() {
  let dir = resolve(cwd());
  const root = resolve('/');
  while (dir !== root) {
    const envPath = resolve(dir, '.env');
    if (existsSync(envPath)) {
      config({ path: envPath });
      break;
    }
    dir = resolve(dir, '..');
  }
})();

import { initConfig } from '@showrun/core';

// Apply config.json values to process.env (only sets vars not already present)
initConfig();

import {
  cmdRun,
  printRunHelp,
  cmdServe,
  printServeHelp,
  cmdDashboard,
  printDashboardHelp,
  cmdPack,
  printPackHelp,
  cmdMcp,
  printMcpHelp,
  cmdConfig,
  printConfigHelp,
} from './commands/index.js';

function printHelp(): void {
  console.log(`
Usage: showrun <command> [subcommand] [options]

ShowRun - Unified CLI for Task Pack framework

Commands:
  run <pack>              Run a task pack
  serve                   Start MCP server for AI agents
  dashboard               Start web dashboard with Teach Mode
  pack <subcommand>       Pack management
    create                Create new pack
    validate              Validate pack
    set-flow              Update flow.json
    set-meta              Update taskpack.json
  config <subcommand>     Configuration management
    init                  Create config directory and default config.json
    show                  Show fully resolved configuration
    path                  List config directories searched
  mcp <subcommand>        MCP server utilities
    browser-inspector     Browser inspection MCP server
    taskpack-editor       Pack editor MCP server

Options:
  --help, -h              Show help for a command

Examples:
  showrun run ./taskpacks/example --inputs '{}'
  showrun serve --packs ./taskpacks --http --port 3001
  showrun dashboard --packs ./taskpacks --port 3333
  showrun pack create --dir ./taskpacks --id my.pack --name "My Pack"
  showrun pack validate --path ./taskpacks/my_pack
  showrun mcp browser-inspector
  showrun mcp taskpack-editor --packs ./taskpacks

Run 'showrun <command> --help' for more information on a command.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  // Check for help flag on specific command
  if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
    switch (command) {
      case 'run':
        printRunHelp();
        break;
      case 'serve':
        printServeHelp();
        break;
      case 'dashboard':
        printDashboardHelp();
        break;
      case 'pack':
        printPackHelp();
        break;
      case 'config':
        printConfigHelp();
        break;
      case 'mcp':
        printMcpHelp();
        break;
      default:
        printHelp();
    }
    process.exit(0);
  }

  try {
    switch (command) {
      case 'run':
        await cmdRun(commandArgs);
        break;
      case 'serve':
        await cmdServe(commandArgs);
        break;
      case 'dashboard':
        await cmdDashboard(commandArgs);
        break;
      case 'pack':
        await cmdPack(commandArgs);
        break;
      case 'config':
        await cmdConfig(commandArgs);
        break;
      case 'mcp':
        await cmdMcp(commandArgs);
        break;
      default:
        console.error(`Unknown command: ${command}. Use --help for usage.`);
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
