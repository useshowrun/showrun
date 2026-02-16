/**
 * VectorStore — Pluggable abstraction for vector database backends.
 *
 * Weaviate ships as the default implementation. Users can implement this
 * interface for Pinecone, Qdrant, ChromaDB, or any other vector DB.
 */

import type {
  Technique,
  TechniqueSearchFilters,
  TechniqueSearchResult,
  TechniqueStatus,
} from './types.js';

/** Fields that can be updated without re-vectorization. */
export type MetadataUpdate = Partial<
  Pick<Technique, 'status' | 'confidence' | 'usageCount' | 'lastUsedAt' | 'updatedAt'>
>;

export interface VectorStore {
  /** Initialize connection and ensure collection / schema exists. */
  initialize(): Promise<void>;

  /** Add or update techniques (upsert by id). */
  upsert(techniques: Technique[]): Promise<void>;

  /**
   * Hybrid search: vector similarity + metadata filters.
   * Must default `status` filter to 'active' when not explicitly provided.
   */
  search(
    query: string,
    filters?: TechniqueSearchFilters,
    limit?: number,
  ): Promise<TechniqueSearchResult[]>;

  /** Get a single technique by ID. */
  get(id: string): Promise<Technique | null>;

  /** Delete a technique by ID. Returns true if deleted. */
  delete(id: string): Promise<boolean>;

  /**
   * Update non-vector metadata (status, confidence, usageCount, etc.).
   * Must NOT trigger re-vectorization.
   */
  updateMetadata(id: string, updates: MetadataUpdate): Promise<void>;

  /**
   * List techniques matching filters (pure metadata filter, no vector search).
   * Must default `status` filter to 'active' when not explicitly provided.
   */
  list(filters?: TechniqueSearchFilters): Promise<Technique[]>;

  /** Health check — returns true if the store is reachable and ready. */
  isHealthy(): Promise<boolean>;
}
