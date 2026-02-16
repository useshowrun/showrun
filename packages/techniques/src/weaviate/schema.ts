/**
 * Weaviate collection schema for ShowrunTechniques.
 *
 * Vectorized properties: title, content (used for semantic search)
 * Filterable-only properties: everything else (metadata filters, NOT vectorized)
 *
 * Supports two modes:
 *   - Weaviate-managed vectorization: uses a built-in module (e.g. text2vec-transformers)
 *   - Bring-your-own-vectors: vectorizer='none', embeddings supplied via EmbeddingProvider
 */

export const DEFAULT_COLLECTION_NAME = 'ShowrunTechniques';
export const DEFAULT_VECTORIZER = 'text2vec-transformers';

/**
 * Build the collection schema config for createFromSchema().
 * Compatible with weaviate-client v3.
 *
 * @param collectionName  Weaviate collection name
 * @param vectorizer      Module name, or 'none' for bring-your-own-vectors
 */
export function buildCollectionSchema(
  collectionName: string = DEFAULT_COLLECTION_NAME,
  vectorizer: string = DEFAULT_VECTORIZER,
) {
  return {
    class: collectionName,
    description: 'ShowRun technique knowledge store — reusable browser automation patterns',
    vectorizer,

    // BM25 config for hybrid keyword search
    invertedIndexConfig: {
      bm25: { b: 0.75, k1: 1.2 },
      indexNullState: true,
    },

    properties: [
      // ── Vectorized properties (included in BM25 keyword search) ──
      {
        name: 'title',
        dataType: ['text'],
        description: 'Short technique title',
        indexSearchable: true,
        indexFilterable: true,
      },
      {
        name: 'content',
        dataType: ['text'],
        description: 'Full technique description (embedded for vector search)',
        indexSearchable: true,
        indexFilterable: false,
      },

      // ── Filterable-only metadata ──
      {
        name: 'techniqueType',  // 'type' is reserved in some contexts
        dataType: ['text'],
        description: "'generic' | 'specific'",
        indexFilterable: true,
        indexSearchable: false,
      },
      {
        name: 'priority',
        dataType: ['int'],
        description: 'Loading order 1-5 (1=critical, 5=edge-case)',
        indexFilterable: true,
        indexRangeFilters: true,
        indexSearchable: false,
      },
      {
        name: 'domain',
        dataType: ['text'],
        description: "Domain this applies to (e.g. 'amazon.com'), null for generic",
        indexFilterable: true,
        indexSearchable: true,
      },
      {
        name: 'tags',
        dataType: ['text[]'],
        description: 'Searchable tags',
        indexFilterable: true,
        indexSearchable: true,
      },
      {
        name: 'category',
        dataType: ['text'],
        description: 'Technique category',
        indexFilterable: true,
        indexSearchable: false,
      },
      {
        name: 'status',
        dataType: ['text'],
        description: "'active' | 'deprecated' | 'not_working'",
        indexFilterable: true,
        indexSearchable: false,
      },
      {
        name: 'confidence',
        dataType: ['number'],
        description: 'Reliability score 0.0-1.0',
        indexFilterable: true,
        indexRangeFilters: true,
        indexSearchable: false,
      },
      {
        name: 'source',
        dataType: ['text'],
        description: "'agent-learned' | 'user-defined' | 'imported' | 'seed'",
        indexFilterable: true,
        indexSearchable: false,
      },
      {
        name: 'sourceConversationId',
        dataType: ['text'],
        description: 'Conversation that generated this technique',
        indexFilterable: true,
        indexSearchable: false,
      },
      {
        name: 'sourcePackId',
        dataType: ['text'],
        description: 'Pack being built when this was learned',
        indexFilterable: true,
        indexSearchable: false,
      },
      {
        name: 'usageCount',
        dataType: ['int'],
        description: 'Number of times this technique was served',
        indexFilterable: true,
        indexSearchable: false,
      },
      {
        name: 'lastUsedAt',
        dataType: ['text'],
        description: 'ISO 8601 timestamp of last usage',
        indexFilterable: false,
        indexSearchable: false,
      },
      {
        name: 'createdAt',
        dataType: ['text'],
        description: 'ISO 8601 creation timestamp',
        indexFilterable: true,
        indexSearchable: false,
      },
      {
        name: 'updatedAt',
        dataType: ['text'],
        description: 'ISO 8601 last update timestamp',
        indexFilterable: true,
        indexSearchable: false,
      },
    ],
  };
}
