/**
 * `showrun techniques` command — manage the Techniques DB.
 *
 * Subcommands:
 *   setup                     — Verify connection, create collection, seed techniques
 *   list                      — List all techniques (with filters)
 *   import <file.json>        — Import a technique bundle
 *   export --domain <domain>  — Export specific techniques for a domain
 *   export --type generic     — Export all generic techniques
 */

import { readFileSync, writeFileSync } from 'fs';
import type { VectorStoreConfig, Technique } from '@showrun/techniques';

function getVectorStoreConfig(): VectorStoreConfig {
  const url = process.env.WEAVIATE_URL;
  if (!url) {
    throw new Error('WEAVIATE_URL environment variable is required. Set it in .env or .showrun/config.json.');
  }

  const config: VectorStoreConfig = {
    url,
    apiKey: process.env.WEAVIATE_API_KEY,
    collectionName: process.env.TECHNIQUES_COLLECTION || undefined,
  };

  // If EMBEDDING_API_KEY is set, use bring-your-own-vectors mode
  const embeddingApiKey = process.env.EMBEDDING_API_KEY;
  if (embeddingApiKey) {
    config.embeddingConfig = {
      apiKey: embeddingApiKey,
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      baseUrl: process.env.EMBEDDING_BASE_URL,
    };
  } else {
    // Use Weaviate's built-in vectorizer
    config.vectorizer = process.env.WEAVIATE_VECTORIZER || undefined;
  }

  return config;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export function printTechniquesHelp(): void {
  console.log(`
Usage: showrun techniques <subcommand> [options]

Manage the Techniques DB (vector-indexed knowledge store).

Subcommands:
  setup                        Verify Weaviate connection, create collection, seed techniques
  list                         List all techniques
    --type <generic|specific>  Filter by type
    --status <active|deprecated|not_working>  Filter by status
    --domain <domain>          Filter by domain
    --priority <1-5>           Filter by max priority
  import <file.json>           Import a technique bundle from JSON file
  export                       Export techniques as JSON
    --domain <domain>          Export specific techniques for a domain
    --type <generic|specific>  Export by type
    --out <file.json>          Output file (default: stdout)

Environment variables:
  WEAVIATE_URL                 Weaviate server URL (required)
  WEAVIATE_API_KEY             Weaviate API key (optional)
  WEAVIATE_VECTORIZER          Weaviate vectorizer module (default: text2vec-transformers)
  TECHNIQUES_COLLECTION        Collection name (default: ShowrunTechniques)

  Bring-your-own-vectors mode (optional — overrides Weaviate vectorizer):
  EMBEDDING_API_KEY            OpenAI-compatible embedding API key
  EMBEDDING_MODEL              Embedding model (default: text-embedding-3-small)
  EMBEDDING_BASE_URL           Custom embedding API base URL
`);
}

export async function cmdTechniques(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    printTechniquesHelp();
    return;
  }

  // Dynamic import to avoid loading weaviate-client when not needed
  const { setupWeaviate, WeaviateVectorStore, TechniqueManager } = await import('@showrun/techniques');

  switch (subcommand) {
    case 'setup': {
      const config = getVectorStoreConfig();
      console.log(`Connecting to Weaviate at ${config.url}...`);
      const result = await setupWeaviate(config);

      if (result.errors.length > 0) {
        console.error('Setup completed with errors:');
        for (const err of result.errors) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }

      console.log('Setup complete!');
      console.log(`  Connected: ${result.connected}`);
      console.log(`  Collection ready: ${result.collectionCreated}`);
      console.log(`  Techniques seeded: ${result.seeded}`);
      break;
    }

    case 'list': {
      const config = getVectorStoreConfig();
      const store = new WeaviateVectorStore(config);
      await store.initialize();
      const manager = new TechniqueManager(store);

      const filters: Record<string, unknown> = {};
      const type = parseFlag(args, '--type');
      const status = parseFlag(args, '--status');
      const domain = parseFlag(args, '--domain');
      const priority = parseFlag(args, '--priority');

      if (type) filters.type = type;
      if (status) filters.status = status;
      if (domain) filters.domain = domain;
      if (priority) filters.maxPriority = Number(priority);

      const techniques = await manager.search('', filters as any, 200);

      if (techniques.length === 0) {
        console.log('No techniques found matching the filters.');
        return;
      }

      console.log(`Found ${techniques.length} technique(s):\n`);
      for (const { technique: t } of techniques) {
        console.log(`  [${t.type}] P${t.priority} ${t.title}`);
        console.log(`    Status: ${t.status} | Source: ${t.source} | Confidence: ${t.confidence}`);
        console.log(`    Domain: ${t.domain || '(generic)'} | Category: ${t.category}`);
        console.log(`    ID: ${t.id}`);
        console.log();
      }
      break;
    }

    case 'import': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Usage: showrun techniques import <file.json>');
        process.exit(1);
      }

      const config = getVectorStoreConfig();
      const store = new WeaviateVectorStore(config);
      await store.initialize();
      const manager = new TechniqueManager(store);

      const raw = readFileSync(filePath, 'utf-8');
      const techniques: Technique[] = JSON.parse(raw);
      if (!Array.isArray(techniques)) {
        console.error('File must contain a JSON array of techniques.');
        process.exit(1);
      }

      const result = await manager.importBundle(techniques);
      console.log(`Import complete: ${result.imported} imported, ${result.skipped} skipped (already exist).`);
      break;
    }

    case 'export': {
      const config = getVectorStoreConfig();
      const store = new WeaviateVectorStore(config);
      await store.initialize();
      const manager = new TechniqueManager(store);

      const domain = parseFlag(args, '--domain');
      const type = parseFlag(args, '--type');
      const outFile = parseFlag(args, '--out');

      const filters: Record<string, unknown> = {};
      if (type) filters.type = type;
      if (domain) filters.domain = domain;
      const techniques = await manager.exportBundle(filters as any);

      const json = JSON.stringify(techniques, null, 2);
      if (outFile) {
        writeFileSync(outFile, json, 'utf-8');
        console.log(`Exported ${techniques.length} technique(s) to ${outFile}`);
      } else {
        console.log(json);
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}. Use --help for usage.`);
      process.exit(1);
  }
}
