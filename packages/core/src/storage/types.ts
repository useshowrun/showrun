/**
 * Pluggable Result Store — Pure interfaces (no external deps)
 *
 * Providers declare their capabilities so consumers (MCP tools)
 * know which operations are available.
 */

export type StorageCapability =
  | 'get'
  | 'store'
  | 'list'
  | 'delete'
  | 'filter'
  | 'search'
  | 'aggregate';

/**
 * Schema field describing a collectible column (for AI-friendly descriptions).
 */
export interface CollectibleSchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
}

/**
 * A single stored run result.
 */
export interface StoredResult {
  /** Deterministic hash of packId + inputs */
  key: string;
  packId: string;
  toolName: string;
  inputs: Record<string, unknown>;
  collectibles: Record<string, unknown>;
  meta: { url?: string; durationMs: number; notes?: string };
  collectibleSchema: CollectibleSchemaField[];
  /** ISO 8601 — when the result was (last) stored */
  storedAt: string;
  /** ISO 8601 — when the run actually executed */
  ranAt: string;
  /** Incremented on overwrite (same key) */
  version: number;
}

/**
 * Options for listing stored results.
 */
export interface ListOptions {
  limit?: number;
  offset?: number;
  sortBy?: 'storedAt' | 'ranAt';
  sortDir?: 'asc' | 'desc';
}

/**
 * Lightweight summary returned by list().
 */
export interface ResultSummary {
  key: string;
  packId: string;
  toolName: string;
  storedAt: string;
  version: number;
  fieldCount: number;
}

/**
 * Filter/paginate within a single stored result's collectibles.
 */
export interface FilterOptions {
  /** Which stored result to filter within */
  key: string;
  /** JMESPath expression for extraction/transform */
  jmesPath?: string;
  /** Limit items (for array results) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Field to sort by within collectibles */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

/**
 * Full-text search options (for future vector/FTS providers).
 */
export interface SearchOptions {
  query: string;
  limit?: number;
}

export interface SearchHit {
  key: string;
  packId: string;
  toolName: string;
  score: number;
  snippet?: string;
}

/**
 * The pluggable store interface.
 * Only `capabilities()`, `store()`, and `get()` are required.
 * Optional methods should only be called if the corresponding capability is declared.
 */
export interface ResultStoreProvider {
  capabilities(): StorageCapability[];
  store(result: StoredResult): Promise<void>;
  get(key: string): Promise<StoredResult | null>;
  list?(options?: ListOptions): Promise<{ results: ResultSummary[]; total: number }>;
  delete?(key: string): Promise<boolean>;
  filter?(options: FilterOptions): Promise<{ data: unknown; total?: number }>;
  search?(options: SearchOptions): Promise<{ results: SearchHit[] }>;
  close?(): Promise<void>;
}
