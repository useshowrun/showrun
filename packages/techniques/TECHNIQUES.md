# Techniques DB — Implementation Reference

This document covers the architecture, design decisions, configuration, and usage of the Techniques DB feature. Use it as a reference when extending, debugging, or onboarding.

---

## Overview

The Techniques DB is a vector-indexed knowledge store that lets the ShowRun agent **reuse prior learnings** across browser automation sessions. Instead of re-discovering API endpoints, pagination patterns, auth flows, and site-specific quirks each time, the agent loads known techniques first, forms a hypothesis, and only explores when needed.

### Core Concepts

- **Technique**: The minimal unit of reusable knowledge — a title + content pair stored with metadata
- **Two orthogonal dimensions**:
  - `type` = scope/shareability (`generic` = shared master prompt for ALL sessions; `specific` = domain-scoped, exportable bundle)
  - `priority` = loading order within either type (1=critical ... 5=edge-case)
- **Hypothesis-first workflow**: Load known techniques -> form hypothesis -> build flow -> test -> only explore if hypothesis fails
- **Pluggable VectorStore interface**: Weaviate is the default, but any vector DB can implement the interface

---

## Architecture

```
packages/techniques/
├── package.json
├── tsconfig.json          # extends root, excludes __tests__
├── TECHNIQUES.md          # this file
└── src/
    ├── index.ts           # barrel export
    ├── types.ts           # Technique, VectorStoreConfig, filter types
    ├── vectorStore.ts     # VectorStore interface (pluggable)
    ├── embeddings.ts      # EmbeddingProvider (OpenAI-compatible, BYO vectors mode only)
    ├── techniqueManager.ts # High-level API: load, search, propose, annotate
    ├── seeds.ts           # Built-in P1-P2 techniques shipped with ShowRun
    ├── weaviate/
    │   ├── index.ts       # WeaviateVectorStore implementation
    │   ├── schema.ts      # Collection schema builder
    │   └── setup.ts       # CLI setup helper
    └── __tests__/
        └── techniqueManager.test.ts  # 22 unit tests with mock VectorStore
```

### Integration Points

| Package | What it does |
|---|---|
| `packages/core/config.ts` | `ShowRunConfig.techniques` section + env var mappings |
| `packages/dashboard/agentTools.ts` | 3 agent tools: `techniques_load`, `techniques_search`, `techniques_propose` |
| `packages/dashboard/server.ts` | TechniqueManager initialization (graceful degradation) |
| `packages/dashboard/routes/techniques.ts` | REST API for CRUD + health |
| `packages/dashboard/routes/teach.ts` | Assembles system prompt from DB techniques at request time |
| `packages/dashboard/promptAssembler.ts` | Builds system prompt from `system_prompt` category techniques |
| `packages/dashboard/fallbackPrompt.ts` | Condensed fallback prompt (used when DB is unavailable) |
| `packages/showrun/commands/techniques.ts` | CLI: `showrun techniques setup/list/import/export` |

---

## Type x Priority Matrix

### Generic techniques (shared master prompt, all sessions)

| P | Example Title | Category |
|---|---|---|
| 1 | API-First Data Extraction | `api_extraction` |
| 1 | Never Hardcode Credentials | `auth` |
| 1 | Anti-Bot Detection Awareness | `anti_detection` |
| 2 | Pagination Detection Pattern | `pagination` |
| 2 | Prefer Role-Based Element Targets | `dom_extraction` |
| 2 | Network Replay Override Patterns | `network_patterns` |
| 3-5 | (domain-agnostic tactical details) | varies |

### Specific techniques (domain-scoped, exportable)

| P | Domain | Example Title |
|---|---|---|
| 1 | linkedin.com | Auth Headers Required |
| 2 | linkedin.com | Keyword Search API Format |
| 3 | linkedin.com | Pagination Increment (25) |
| 1 | amazon.com | Search Endpoint (/s/query) |
| 2 | amazon.com | Dispatch Array Format |

---

## Two Vectorization Modes

The implementation supports two modes, determined by presence of `EMBEDDING_API_KEY`:

### Mode 1: Weaviate-Managed (default, no API key needed)

Weaviate's built-in vectorizer module handles embedding generation.

```
.env:
WEAVIATE_URL=http://localhost:8080
# WEAVIATE_VECTORIZER=text2vec-transformers   # optional, this is the default
```

**Requires**: Weaviate Docker with `text2vec-transformers` module enabled (see docker-compose.yml).

- Schema uses `vectorizer: 'text2vec-transformers'`
- `upsert()`: sends properties only, Weaviate generates vectors
- `search()`: hybrid search without explicit query vector

### Mode 2: Bring-Your-Own-Vectors (external embedding API)

When `EMBEDDING_API_KEY` is set, the code generates embeddings externally and passes them to Weaviate.

```
.env:
WEAVIATE_URL=http://localhost:8080
EMBEDDING_API_KEY=sk-your-key-here
EMBEDDING_MODEL=text-embedding-3-small
# EMBEDDING_BASE_URL=https://api.openai.com/v1   # optional, this is the default
```

- Schema uses `vectorizer: 'none'`
- `EmbeddingProvider` calls OpenAI-compatible `/v1/embeddings` endpoint
- `upsert()`: generates vectors via `embedBatch()`, passes them with properties
- `search()`: generates query vector via `embed()`, passes to hybrid search

### Mode Selection Logic

```typescript
// In WeaviateVectorStore constructor:
if (config.embeddingConfig) {
  this.embeddings = new EmbeddingProvider(config.embeddingConfig);
  this.vectorizer = 'none';          // BYO vectors
} else {
  this.embeddings = null;
  this.vectorizer = config.vectorizer ?? 'text2vec-transformers';  // Weaviate-managed
}
```

---

## Configuration

### Environment Variables

| Var | Required | Default | Description |
|---|---|---|---|
| `WEAVIATE_URL` | Yes | — | Weaviate server URL (e.g. `http://localhost:8080`) |
| `WEAVIATE_API_KEY` | No | — | Weaviate auth key (empty for local Docker) |
| `WEAVIATE_VECTORIZER` | No | `text2vec-transformers` | Vectorizer module name |
| `TECHNIQUES_COLLECTION` | No | `ShowrunTechniques` | Weaviate collection name |
| `EMBEDDING_API_KEY` | No | — | Enables BYO vectors mode when set |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | Embedding model name |
| `EMBEDDING_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-compatible base URL |

### config.json equivalent

```json
{
  "techniques": {
    "vectorStore": {
      "provider": "weaviate",
      "url": "http://localhost:8080",
      "apiKey": "",
      "vectorizer": "text2vec-transformers"
    },
    "embedding": {
      "apiKey": "",
      "model": "text-embedding-3-small",
      "baseUrl": ""
    },
    "collectionName": "ShowrunTechniques"
  }
}
```

---

## Docker Setup (Weaviate)

The `text2vec-transformers` mode requires a transformer model sidecar container:

```yaml
# /path/to/weaviate/docker-compose.yml
services:
  weaviate:
    image: cr.weaviate.io/semitechnologies/weaviate:1.35.7
    ports:
      - 8080:8080
      - 50051:50051
    environment:
      ENABLE_MODULES: 'text2vec-transformers'
      TRANSFORMERS_INFERENCE_API: 'http://t2v-transformers:8080'

  t2v-transformers:
    image: cr.weaviate.io/semitechnologies/transformers-inference:sentence-transformers-all-MiniLM-L6-v2
    environment:
      ENABLE_CUDA: '0'   # set to '1' if you have a GPU
```

Initial pull is ~400MB. Model loads in ~30s after container start.

---

## VectorStore Interface

Any vector DB implementation must satisfy this interface:

```typescript
interface VectorStore {
  initialize(): Promise<void>;
  upsert(techniques: Technique[]): Promise<void>;
  search(query: string, filters?: TechniqueSearchFilters, limit?: number): Promise<TechniqueSearchResult[]>;
  get(id: string): Promise<Technique | null>;
  delete(id: string): Promise<boolean>;
  updateMetadata(id: string, updates: MetadataUpdate): Promise<void>;  // no re-vectorization
  list(filters?: TechniqueSearchFilters): Promise<Technique[]>;
  isHealthy(): Promise<boolean>;
}
```

**Why this interface works for other vector DBs**: The methods map cleanly to Pinecone (`upsert`, `query`), Qdrant (`upsert`, `search`), ChromaDB (`add`, `query`). Metadata filtering is universal across vector DBs.

---

## Weaviate Schema

Collection: `ShowrunTechniques`

**Vectorized properties** (included in BM25 keyword search):
- `title` (text, searchable + filterable)
- `content` (text, searchable only)

**Filterable-only metadata** (NOT vectorized):
- `techniqueType` (text) — maps to `Technique.type` ('type' is reserved in some contexts)
- `priority` (int, range-filterable)
- `domain` (text, filterable + searchable)
- `tags` (text[], filterable + searchable)
- `category`, `status`, `confidence`, `source` (filterable)
- `sourceConversationId`, `sourcePackId`, `usageCount`, `lastUsedAt`, `createdAt`, `updatedAt`

**Hybrid search**: `alpha: 0.5` balances vector similarity + BM25 keyword search. Status always defaults to `'active'` — `not_working` and `deprecated` are filtered out unless explicitly requested.

**Nullable fields**: Weaviate doesn't store `null` well. We convert `null` to `''` on write, and `''` back to `null` on read for `domain`, `sourceConversationId`, `sourcePackId`, `lastUsedAt`.

---

## Annotation System

The `status` field is the non-vector-indexed annotation:

| Status | Meaning | Visible to agent? |
|---|---|---|
| `active` | Working, use it | Yes (default filter) |
| `not_working` | Was working, now broken | No |
| `deprecated` | Superseded by better technique | No |

Changing status via `updateMetadata()` does NOT trigger re-vectorization — it's a pure metadata update. REST API: `PATCH /api/techniques/:id` with `{ status: 'not_working' }`.

---

## Agent Workflow

### Phase 0: LOAD KNOWLEDGE (before anything else)

```
1. techniques_load(maxPriority: 2)                    <- generic P1-P2
2. Extract domain from user message
3. techniques_load(maxPriority: 2, domain: "...")      <- + specific P1-P2

Specific patterns found?  --> YES --> HYPOTHESIS ROADMAP (skip exploration)
                          --> PARTIAL --> GUIDED exploration (load P3+)
                          --> NO --> Full exploration
```

### Phase 6b: CAPTURE LEARNINGS (after successful flow)

```
1. Review what patterns worked
2. Identify reusable knowledge
3. techniques_propose([
     { type: 'specific', domain: 'example.com', priority: 2, ... },
     { type: 'generic', priority: 3, ... }
   ])
```

### Pre-Session Injection (teach.ts)

P1 techniques are automatically loaded into the system prompt before the agent loop starts. This saves 1-2 tool calls. The agent uses `techniques_load` for P2+ during Phase 0.

---

## Agent Tools

| Tool | Purpose | Parameters |
|---|---|---|
| `techniques_load` | Load techniques by priority layer | `maxPriority: 1-5`, `domain?: string` |
| `techniques_search` | Hybrid search | `query: string`, `type?`, `domain?`, `category?`, `maxPriority?` |
| `techniques_propose` | Save new learnings | `techniques: ProposedTechnique[]` |

All three are exploration-only tools (not available to the editor agent).

---

## REST API

| Method | Path | Description |
|---|---|---|
| GET | `/api/techniques` | List all (with query filters) |
| GET | `/api/techniques/health` | Vector store health check |
| GET | `/api/techniques/:id` | Get single technique |
| POST | `/api/techniques` | Create user-defined technique |
| PATCH | `/api/techniques/:id` | Update metadata (status, confidence) |
| DELETE | `/api/techniques/:id` | Delete technique |
| POST | `/api/techniques/review` | Batch approve/reject proposals |

All routes return 503 if TechniqueManager is not configured.

---

## CLI Commands

```bash
showrun techniques setup                    # Verify connection, create collection, seed
showrun techniques list                     # List all techniques
showrun techniques list --type generic      # Filter by type
showrun techniques list --max-priority 2    # Filter by priority
showrun techniques list --domain example.com
showrun techniques import <file.json>       # Import technique bundle
showrun techniques export                   # Export all to stdout
showrun techniques export --domain x.com    # Export domain-specific
showrun techniques export --out bundle.json # Write to file
```

---

## Graceful Degradation

If `WEAVIATE_URL` is not set or Weaviate is unreachable:

- `techniqueManager` is `null` in DashboardContext
- Agent tools return helpful error messages ("Techniques DB not configured")
- REST API returns 503 Service Unavailable
- Pre-session injection is skipped
- Everything else works normally

---

## Key Implementation Details

### tsup Bundling

`@showrun/techniques` is **external** in the showrun CLI's tsup config (not bundled). The CLI uses dynamic import (`await import('@showrun/techniques')`) so weaviate-client is only loaded when the `techniques` subcommand is used. This keeps the CLI bundle small (~712KB).

### Weaviate Client v3 SDK

Key methods used:
- `weaviate.connectToLocal({ host, port, grpcPort: 50051 })`
- `client.collections.exists(name)` / `client.collections.createFromSchema(schema)`
- `collection.query.hybrid(query, { alpha, limit, filters, returnProperties })`
- `collection.query.fetchObjectById(id)` / `collection.query.fetchObjects({ filters })`
- `collection.data.insert({ id, properties, vectors? })` / `collection.data.update(...)`
- `collection.filter.byProperty(name).equal(val)` / `.lessOrEqual()` / `.greaterOrEqual()`
- `Filters.and(...)` for combining multiple conditions

### Gotchas

- Weaviate property name `techniqueType` (not `type`) because `type` can be reserved
- `lessOrEqual` / `greaterOrEqual` (not `lessThanEqual` / `greaterThanEqual`)
- `WeaviateField` type must be used for property records: `Record<string, WeaviateField>`
- `createFromSchema()` exists in weaviate-client v3.11.0 despite some docs suggesting otherwise
- Null values must be converted to empty strings for Weaviate storage, converted back on read
- Test files must be excluded from tsconfig.json build (`"exclude": ["src/__tests__/**"]`)

---

## Testing

22 unit tests in `packages/techniques/src/__tests__/techniqueManager.test.ts`:

- **seedIfEmpty**: seeds when empty, skips when seeds exist, correct metadata
- **loadUpTo**: priority filtering, generic+specific loading, domain filtering, usage tracking
- **search**: active-only default, scoring, usage recording
- **propose**: source tagging, priority clamping (1-5), confidence clamping (0-1), context attachment
- **markNotWorking/deprecate**: status changes, search invisibility
- **exportBundle/importBundle**: domain filtering, duplicate skipping, source override
- **isAvailable**: health check delegation

Tests use a mock VectorStore (in-memory Map) — no Weaviate needed.

Run: `cd packages/techniques && pnpm test`

---

## Future Work

- Dashboard UI for reviewing proposed techniques (approve/reject modal)
- `techniques_proposed` streaming event after session completion
- Technique sharing marketplace (export bundles alongside taskpacks)
- Confidence decay: auto-reduce confidence of unused techniques over time
- Technique versioning / conflict resolution for imports
- Alternative VectorStore implementations (Pinecone, Qdrant, ChromaDB)
