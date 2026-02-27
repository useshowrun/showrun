/**
 * showrun results <subcommand> - Query stored run results
 */

import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { SQLiteResultStore } from '@showrun/harness';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_VALIDATION_ERROR = 2;

export async function cmdResults(args: string[]): Promise<void> {
  if (args.length === 0) {
    printResultsHelp();
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      await cmdResultsList(subArgs);
      break;
    case 'query':
      await cmdResultsQuery(subArgs);
      break;
    default:
      console.error(`Unknown results subcommand: ${subcommand}`);
      printResultsHelp();
      process.exit(EXIT_VALIDATION_ERROR);
  }
}

// ─── list ───────────────────────────────────────────────────────────

interface ListArgs {
  packPath: string;
  limit: number;
  offset: number;
  sortBy: 'storedAt' | 'ranAt';
  sortDir: 'asc' | 'desc';
}

function parseListArgs(args: string[]): ListArgs {
  let packPath: string | null = null;
  let limit = 20;
  let offset = 0;
  let sortBy: 'storedAt' | 'ranAt' = 'storedAt';
  let sortDir: 'asc' | 'desc' = 'desc';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--pack' && next) {
      packPath = next;
      i++;
    } else if (arg === '--limit' && next) {
      limit = parseInt(next, 10);
      i++;
    } else if (arg === '--offset' && next) {
      offset = parseInt(next, 10);
      i++;
    } else if (arg === '--sort-by' && next) {
      if (next === 'storedAt' || next === 'ranAt') {
        sortBy = next;
      } else {
        console.error(`Error: --sort-by must be "storedAt" or "ranAt"`);
        process.exit(EXIT_VALIDATION_ERROR);
      }
      i++;
    } else if (arg === '--sort-dir' && next) {
      if (next === 'asc' || next === 'desc') {
        sortDir = next;
      } else {
        console.error(`Error: --sort-dir must be "asc" or "desc"`);
        process.exit(EXIT_VALIDATION_ERROR);
      }
      i++;
    }
  }

  if (!packPath) {
    console.error('Error: --pack <path> is required');
    console.error('Usage: showrun results list --pack <path> [--limit N] [--offset N] [--sort-by storedAt|ranAt] [--sort-dir asc|desc]');
    process.exit(EXIT_VALIDATION_ERROR);
  }

  return { packPath, limit, offset, sortBy, sortDir };
}

async function cmdResultsList(args: string[]): Promise<void> {
  const { packPath, limit, offset, sortBy, sortDir } = parseListArgs(args);
  const resolvedPackPath = resolve(packPath);
  const dbPath = join(resolvedPackPath, 'results.db');

  if (!existsSync(dbPath)) {
    console.error(`No results found. Database does not exist: ${dbPath}`);
    process.exit(EXIT_FAILURE);
  }

  const store = new SQLiteResultStore(dbPath);
  try {
    const { results, total } = await store.list({ limit, offset, sortBy, sortDir });
    console.log(JSON.stringify({ results, total, limit, offset }, null, 2));
    process.exit(EXIT_SUCCESS);
  } catch (err) {
    console.error(`Error listing results: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_FAILURE);
  } finally {
    await store.close();
  }
}

// ─── query ──────────────────────────────────────────────────────────

interface QueryArgs {
  packPath: string;
  key?: string;
  jmesPath?: string;
  limit: number;
  offset: number;
  sortBy?: string;
  sortDir: 'asc' | 'desc';
}

function parseQueryArgs(args: string[]): QueryArgs {
  let packPath: string | null = null;
  let key: string | undefined;
  let jmesPath: string | undefined;
  let limit = 50;
  let offset = 0;
  let sortBy: string | undefined;
  let sortDir: 'asc' | 'desc' = 'desc';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--pack' && next) {
      packPath = next;
      i++;
    } else if (arg === '--key' && next) {
      key = next;
      i++;
    } else if (arg === '--jmes-path' && next) {
      jmesPath = next;
      i++;
    } else if (arg === '--limit' && next) {
      limit = parseInt(next, 10);
      i++;
    } else if (arg === '--offset' && next) {
      offset = parseInt(next, 10);
      i++;
    } else if (arg === '--sort-by' && next) {
      sortBy = next;
      i++;
    } else if (arg === '--sort-dir' && next) {
      if (next === 'asc' || next === 'desc') {
        sortDir = next;
      } else {
        console.error(`Error: --sort-dir must be "asc" or "desc"`);
        process.exit(EXIT_VALIDATION_ERROR);
      }
      i++;
    }
  }

  if (!packPath) {
    console.error('Error: --pack <path> is required');
    console.error('Usage: showrun results query --pack <path> [--key <key>] [--jmes-path <expr>] [--limit N] [--offset N]');
    process.exit(EXIT_VALIDATION_ERROR);
  }

  return { packPath, key, jmesPath, limit, offset, sortBy, sortDir };
}

async function cmdResultsQuery(args: string[]): Promise<void> {
  const { packPath, key, jmesPath, limit, offset, sortBy, sortDir } = parseQueryArgs(args);
  const resolvedPackPath = resolve(packPath);
  const dbPath = join(resolvedPackPath, 'results.db');

  if (!existsSync(dbPath)) {
    console.error(`No results found. Database does not exist: ${dbPath}`);
    process.exit(EXIT_FAILURE);
  }

  const store = new SQLiteResultStore(dbPath);
  try {
    // Resolve key: if not provided, fetch the latest result
    let resolvedKey = key;
    if (!resolvedKey) {
      const { results } = await store.list({ limit: 1, sortBy: 'storedAt', sortDir: 'desc' });
      if (results.length === 0) {
        console.error('No results stored for this pack.');
        process.exit(EXIT_FAILURE);
      }
      resolvedKey = results[0].key;
    }

    if (jmesPath) {
      // Filter with JMESPath
      const { data, total } = await store.filter({
        key: resolvedKey,
        jmesPath,
        limit,
        offset,
        sortBy,
        sortDir,
      });
      console.log(JSON.stringify({ key: resolvedKey, data, total, limit, offset }, null, 2));
    } else {
      // Full result
      const result = await store.get(resolvedKey);
      if (!result) {
        console.error(`Result not found for key: ${resolvedKey}`);
        process.exit(EXIT_FAILURE);
      }
      console.log(JSON.stringify(result, null, 2));
    }

    process.exit(EXIT_SUCCESS);
  } catch (err) {
    console.error(`Error querying results: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_FAILURE);
  } finally {
    await store.close();
  }
}

// ─── help ───────────────────────────────────────────────────────────

export function printResultsHelp(): void {
  console.log(`
Usage: showrun results <subcommand> [options]

Query stored run results

Subcommands:
  list                  List stored results for a pack
  query                 Query/filter a specific result

List options:
  --pack <path>         Path to task pack directory (required)
  --limit <n>           Max results to return (default: 20)
  --offset <n>          Skip first N results (default: 0)
  --sort-by <field>     Sort by "storedAt" or "ranAt" (default: storedAt)
  --sort-dir <dir>      Sort direction "asc" or "desc" (default: desc)

Query options:
  --pack <path>         Path to task pack directory (required)
  --key <key>           Result key to query (default: latest result)
  --jmes-path <expr>    JMESPath expression to filter collectibles
  --limit <n>           Limit array results (default: 50)
  --offset <n>          Pagination offset (default: 0)
  --sort-by <field>     Field to sort by within collectibles
  --sort-dir <dir>      Sort direction "asc" or "desc" (default: desc)

Examples:
  showrun results list --pack ./taskpacks/example
  showrun results query --pack ./taskpacks/example
  showrun results query --pack ./taskpacks/example --key abc123
  showrun results query --pack ./taskpacks/example --jmes-path "items[].name"
  showrun results query --pack ./taskpacks/example --jmes-path "items[?age > \`30\`]" --limit 10
`);
}
