/**
 * @showrun/techniques — Vector-indexed technique knowledge store.
 *
 * Provides a pluggable VectorStore interface, Weaviate implementation,
 * embedding generation, and a high-level TechniqueManager API.
 */

// Core types
export type {
  Technique,
  TechniqueType,
  TechniqueStatus,
  TechniqueSource,
  TechniqueCategory,
  TechniqueSearchFilters,
  TechniqueSearchResult,
  ProposedTechnique,
  EmbeddingConfig,
  VectorStoreConfig,
} from './types.js';

export { PRIORITY_MIN, PRIORITY_MAX } from './types.js';

// VectorStore interface
export type { VectorStore, MetadataUpdate } from './vectorStore.js';

// Implementations
export { EmbeddingProvider } from './embeddings.js';
export { WeaviateVectorStore } from './weaviate/index.js';
export { buildCollectionSchema, DEFAULT_COLLECTION_NAME, DEFAULT_VECTORIZER } from './weaviate/schema.js';
export { setupWeaviate } from './weaviate/setup.js';
export type { SetupResult } from './weaviate/setup.js';

// High-level API
export { TechniqueManager } from './techniqueManager.js';

// Seeds
export { SEED_TECHNIQUES } from './seeds.js';
