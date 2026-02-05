/**
 * showrun mcp <subcommand> - MCP server utilities
 */

import { resolve } from 'path';
import { createBrowserInspectorServer } from '@showrun/browser-inspector-mcp';
import { createTaskPackEditorServer } from '@showrun/taskpack-editor-mcp';

export interface McpBrowserInspectorOptions {
  headful: boolean;
}

export interface McpTaskpackEditorOptions {
  packs: string[];
  workspaceDir: string;
  baseRunDir: string;
}

export function parseBrowserInspectorArgs(args: string[]): McpBrowserInspectorOptions {
  let headful = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--headful') {
      headful = true;
    } else if (arg === '--headless') {
      headful = false;
    }
  }

  return { headful };
}

export function parseTaskpackEditorArgs(args: string[]): McpTaskpackEditorOptions {
  let packsStr: string | null = null;
  let workspaceDir: string | null = null;
  let baseRunDir = './runs';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--packs' && next) {
      packsStr = next;
      i++;
    } else if (arg === '--workspace' && next) {
      workspaceDir = next;
      i++;
    } else if (arg === '--baseRunDir' && next) {
      baseRunDir = next;
      i++;
    }
  }

  // Default to ./taskpacks if not provided
  const packs = packsStr
    ? packsStr.split(',').map((d) => resolve(d.trim())).filter(Boolean)
    : [resolve('./taskpacks')];

  // Default workspace to first packs directory
  const resolvedWorkspaceDir = workspaceDir ? resolve(workspaceDir) : packs[0];

  return {
    packs,
    workspaceDir: resolvedWorkspaceDir,
    baseRunDir: resolve(baseRunDir),
  };
}

export async function cmdMcpBrowserInspector(args: string[]): Promise<void> {
  try {
    const _options = parseBrowserInspectorArgs(args);
    await createBrowserInspectorServer({});
  } catch (error) {
    console.error(`[Browser Inspector MCP] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export async function cmdMcpTaskpackEditor(args: string[]): Promise<void> {
  try {
    const options = parseTaskpackEditorArgs(args);
    await createTaskPackEditorServer({
      packDirs: options.packs,
      workspaceDir: options.workspaceDir,
      baseRunDir: options.baseRunDir,
    });
  } catch (error) {
    console.error(`[TaskPack Editor MCP] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Handle mcp subcommand
 */
export async function cmdMcp(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subcommandArgs = args.slice(1);

  switch (subcommand) {
    case 'browser-inspector':
      await cmdMcpBrowserInspector(subcommandArgs);
      break;
    case 'taskpack-editor':
      await cmdMcpTaskpackEditor(subcommandArgs);
      break;
    case undefined:
    case '--help':
    case '-h':
      printMcpHelp();
      break;
    default:
      console.error(`Unknown mcp command: ${subcommand}. Use --help for usage.`);
      process.exit(1);
  }
}

export function printMcpHelp(): void {
  console.log(`
Usage: showrun mcp <command> [options]

MCP server utilities

Commands:
  browser-inspector     Start browser inspection MCP server
    --headful             Run browser in headful mode (default)
    --headless            Run browser in headless mode

  taskpack-editor       Start pack editor MCP server
    --packs <dirs>        Comma-separated list of pack directories (default: ./taskpacks)
    --workspace <path>    Writable directory for editing (default: first --packs dir)
    --baseRunDir <dir>    Directory for run outputs (default: ./runs)

Examples:
  showrun mcp browser-inspector
  showrun mcp browser-inspector --headless
  showrun mcp taskpack-editor --packs ./taskpacks
  showrun mcp taskpack-editor --packs ./taskpacks --workspace ./my-workspace
`);
}
