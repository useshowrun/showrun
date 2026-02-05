/**
 * showrun serve - Start MCP server for AI agents
 */

import { resolve } from 'path';
import { discoverPacks, createMCPServer, createMCPServerOverHTTP } from '@showrun/mcp-server';

export interface ServeCommandOptions {
  packs: string[];
  headful: boolean;
  concurrency: number;
  baseRunDir: string;
  http: boolean;
  port: number;
  host: string;
}

export function parseServeArgs(args: string[]): ServeCommandOptions {
  let packsStr: string | null = null;
  // Default to headful if DISPLAY is available, otherwise headless
  let headful = !!process.env.DISPLAY;
  let concurrency = 1;
  let baseRunDir = './runs';
  let http = false;
  let port = 3000;
  let host = '127.0.0.1';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--packs' && next) {
      packsStr = next;
      i++;
    } else if (arg === '--headful') {
      headful = true;
    } else if (arg === '--headless') {
      headful = false;
    } else if (arg === '--concurrency' && next) {
      concurrency = parseInt(next, 10);
      if (isNaN(concurrency) || concurrency < 1) {
        console.error('Error: --concurrency must be a positive integer');
        process.exit(1);
      }
      i++;
    } else if (arg === '--baseRunDir' && next) {
      baseRunDir = next;
      i++;
    } else if (arg === '--http') {
      http = true;
    } else if (arg === '--port' && next) {
      port = parseInt(next, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('Error: --port must be a valid port number (1-65535)');
        process.exit(1);
      }
      i++;
    } else if (arg === '--host' && next) {
      host = next;
      i++;
    }
  }

  if (!packsStr) {
    console.error('Error: --packs <dir1,dir2,...> is required');
    console.error('Example: showrun serve --packs ./taskpacks');
    process.exit(1);
  }

  const packs = packsStr.split(',').map((dir) => dir.trim()).filter(Boolean);

  if (packs.length === 0) {
    console.error('Error: At least one pack directory is required');
    process.exit(1);
  }

  return {
    packs: packs.map((dir) => resolve(dir)),
    headful,
    concurrency,
    baseRunDir: resolve(baseRunDir),
    http,
    port,
    host,
  };
}

export async function cmdServe(args: string[]): Promise<void> {
  try {
    const options = parseServeArgs(args);

    console.error(`[MCP Server] Discovering task packs from: ${options.packs.join(', ')}`);

    // Discover packs
    const discoveredPacks = await discoverPacks({
      directories: options.packs,
      nested: true,
    });

    if (discoveredPacks.length === 0) {
      console.error('Error: No valid task packs found in the specified directories');
      process.exit(1);
    }

    console.error(`[MCP Server] Discovered ${discoveredPacks.length} task pack(s):`);
    for (const { pack, toolName } of discoveredPacks) {
      console.error(`[MCP Server]   - ${toolName} (${pack.metadata.id} v${pack.metadata.version})`);
    }

    // Warn if headful requested but no DISPLAY
    if (options.headful && !process.env.DISPLAY) {
      console.error(
        '[MCP Server] Warning: Headful mode requested but DISPLAY not set. ' +
        'Will fall back to headless. Set DISPLAY or use xvfb-run to enable headful mode.'
      );
    }

    if (options.http) {
      // Create and start HTTP MCP server
      const handle = await createMCPServerOverHTTP({
        packs: discoveredPacks,
        baseRunDir: options.baseRunDir,
        concurrency: options.concurrency,
        headful: options.headful,
        port: options.port,
        host: options.host,
      });

      console.error(`[MCP Server] HTTP server listening at ${handle.url}`);

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        console.error('[MCP Server] Shutting down...');
        await handle.close();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        console.error('[MCP Server] Shutting down...');
        await handle.close();
        process.exit(0);
      });
    } else {
      // Create and start stdio MCP server
      await createMCPServer({
        packs: discoveredPacks,
        baseRunDir: options.baseRunDir,
        concurrency: options.concurrency,
        headful: options.headful,
      });
    }

    // Server runs indefinitely
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[MCP Server] Fatal error: ${errorMessage}`);
    process.exit(1);
  }
}

export function printServeHelp(): void {
  console.log(`
Usage: showrun serve [options]

Start MCP server for AI agents

Options:
  --packs <dirs>         Comma-separated list of pack directories (required)
  --headful              Run browser in headful mode
  --headless             Run browser in headless mode
  --concurrency <n>      Max concurrent executions (default: 1)
  --baseRunDir <dir>     Directory for run outputs (default: ./runs)
  --http                 Use HTTP transport instead of stdio
  --port <port>          HTTP server port (default: 3000, requires --http)
  --host <host>          HTTP server host (default: 127.0.0.1, requires --http)

Examples:
  showrun serve --packs ./taskpacks
  showrun serve --packs ./taskpacks --http --port 3001
  showrun serve --packs ./taskpacks,./other-packs --concurrency 2
`);
}
