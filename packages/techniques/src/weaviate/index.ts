/**
 * WeaviateVectorStore — Weaviate implementation of the VectorStore interface.
 *
 * Supports two vectorization modes:
 *   1. Weaviate-managed: uses a built-in vectorizer module (e.g. text2vec-transformers).
 *      No external API key needed — just set WEAVIATE_URL.
 *   2. Bring-your-own-vectors: vectorizer='none', embeddings generated via EmbeddingProvider.
 *      Requires EMBEDDING_API_KEY + EMBEDDING_MODEL.
 *
 * Mode is determined by the presence of `embeddingConfig` in VectorStoreConfig.
 */

import weaviate, { type WeaviateClient, type WeaviateField, Filters } from 'weaviate-client';
import type { VectorStore, MetadataUpdate } from '../vectorStore.js';
import type {
  Technique,
  TechniqueSearchFilters,
  TechniqueSearchResult,
  VectorStoreConfig,
} from '../types.js';
import { EmbeddingProvider } from '../embeddings.js';
import { buildCollectionSchema, DEFAULT_COLLECTION_NAME, DEFAULT_VECTORIZER } from './schema.js';

/** Default hybrid search alpha (0.5 = balanced vector + keyword). */
const DEFAULT_ALPHA = 0.5;
/** Default search limit. */
const DEFAULT_LIMIT = 10;

/** All properties to return from Weaviate queries. */
const ALL_RETURN_PROPERTIES = [
  'title', 'content', 'techniqueType', 'priority', 'domain', 'tags',
  'category', 'status', 'confidence', 'source', 'sourceConversationId',
  'sourcePackId', 'usageCount', 'lastUsedAt', 'createdAt', 'updatedAt',
] as const;

export class WeaviateVectorStore implements VectorStore {
  private client: WeaviateClient | null = null;
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly collectionName: string;
  private readonly embeddings: EmbeddingProvider | null;
  private readonly vectorizer: string;

  constructor(config: VectorStoreConfig) {
    this.url = config.url;
    this.apiKey = config.apiKey;
    this.collectionName = config.collectionName ?? DEFAULT_COLLECTION_NAME;

    // Determine mode: external embeddings vs Weaviate-managed vectorization
    if (config.embeddingConfig) {
      this.embeddings = new EmbeddingProvider(config.embeddingConfig);
      this.vectorizer = 'none';
    } else {
      this.embeddings = null;
      this.vectorizer = config.vectorizer ?? DEFAULT_VECTORIZER;
    }
  }

  async initialize(): Promise<void> {
    // Parse URL into host and scheme
    const parsed = new URL(this.url);
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 8080);

    this.client = await weaviate.connectToLocal({
      host: parsed.hostname,
      port,
      grpcPort: 50051,
    });

    // Check if collection exists, create if not
    const exists = await this.client.collections.exists(this.collectionName);
    if (!exists) {
      const schema = buildCollectionSchema(this.collectionName, this.vectorizer);
      await this.client.collections.createFromSchema(schema);
      console.log(`[Techniques] Created Weaviate collection: ${this.collectionName} (vectorizer: ${this.vectorizer})`);
    } else {
      console.log(`[Techniques] Weaviate collection exists: ${this.collectionName}`);
    }
  }

  async upsert(techniques: Technique[]): Promise<void> {
    if (techniques.length === 0) return;
    const collection = this.getCollection();

    // Generate embeddings only in bring-your-own-vectors mode
    let vectors: number[][] | null = null;
    if (this.embeddings) {
      const textsToEmbed = techniques.map(t => `${t.title}\n\n${t.content}`);
      vectors = await this.embeddings.embedBatch(textsToEmbed);
    }

    for (let i = 0; i < techniques.length; i++) {
      const t = techniques[i];
      const properties = this.techniqueToProperties(t);

      const dataPayload: { id: string; properties: Record<string, WeaviateField>; vectors?: number[] } = {
        id: t.id,
        properties: properties as Record<string, WeaviateField>,
      };
      if (vectors) {
        dataPayload.vectors = vectors[i];
      }

      // Check if object exists by ID
      try {
        const existing = await collection.query.fetchObjectById(t.id);
        if (existing) {
          await collection.data.update(dataPayload);
          continue;
        }
      } catch {
        // Object doesn't exist, will insert below
      }

      await collection.data.insert(dataPayload);
    }
  }

  async search(
    query: string,
    filters?: TechniqueSearchFilters,
    limit: number = DEFAULT_LIMIT,
  ): Promise<TechniqueSearchResult[]> {
    const collection = this.getCollection();
    const weaviateFilter = this.buildFilter(filters);

    // Build hybrid search options
    const hybridOpts: Record<string, unknown> = {
      alpha: DEFAULT_ALPHA,
      limit,
      filters: weaviateFilter ?? undefined,
      returnProperties: ALL_RETURN_PROPERTIES as unknown as string[],
      returnMetadata: ['score'],
    };

    // In bring-your-own-vectors mode, supply the query vector
    if (this.embeddings) {
      hybridOpts.vector = await this.embeddings.embed(query);
    }

    const result = await collection.query.hybrid(query, hybridOpts);

    return result.objects.map(obj => ({
      technique: this.objectToTechnique(obj.uuid, obj.properties as Record<string, WeaviateField>),
      score: obj.metadata?.score ?? 0,
    }));
  }

  async get(id: string): Promise<Technique | null> {
    const collection = this.getCollection();
    try {
      const obj = await collection.query.fetchObjectById(id, {
        returnProperties: ALL_RETURN_PROPERTIES as unknown as string[],
      });
      if (!obj) return null;
      return this.objectToTechnique(obj.uuid, obj.properties as Record<string, WeaviateField>);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const collection = this.getCollection();
    try {
      await collection.data.deleteById(id);
      return true;
    } catch {
      return false;
    }
  }

  async updateMetadata(id: string, updates: MetadataUpdate): Promise<void> {
    const collection = this.getCollection();
    const properties: Record<string, WeaviateField> = {};

    if (updates.status !== undefined) properties.status = updates.status;
    if (updates.confidence !== undefined) properties.confidence = updates.confidence;
    if (updates.usageCount !== undefined) properties.usageCount = updates.usageCount;
    if (updates.lastUsedAt !== undefined) properties.lastUsedAt = updates.lastUsedAt ?? '';
    if (updates.updatedAt !== undefined) properties.updatedAt = updates.updatedAt;

    if (Object.keys(properties).length > 0) {
      properties.updatedAt = properties.updatedAt ?? new Date().toISOString();
      await collection.data.update({
        id,
        properties: properties as Partial<Record<string, WeaviateField>>,
      });
    }
  }

  async list(filters?: TechniqueSearchFilters): Promise<Technique[]> {
    const collection = this.getCollection();
    const weaviateFilter = this.buildFilter(filters);

    const result = await collection.query.fetchObjects({
      filters: weaviateFilter ?? undefined,
      limit: 200, // Reasonable upper bound for listing
      returnProperties: ALL_RETURN_PROPERTIES as unknown as string[],
    });

    return result.objects.map(obj =>
      this.objectToTechnique(obj.uuid, obj.properties as Record<string, WeaviateField>)
    );
  }

  async isHealthy(): Promise<boolean> {
    try {
      if (!this.client) return false;
      const ready = await this.client.isReady();
      return ready;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getCollection() {
    if (!this.client) {
      throw new Error('WeaviateVectorStore not initialized. Call initialize() first.');
    }
    return this.client.collections.use(this.collectionName);
  }

  /** Convert Technique to Weaviate properties object. */
  private techniqueToProperties(t: Technique): Record<string, WeaviateField> {
    return {
      title: t.title,
      content: t.content,
      techniqueType: t.type,
      priority: t.priority,
      domain: t.domain ?? '',
      tags: t.tags,
      category: t.category,
      status: t.status,
      confidence: t.confidence,
      source: t.source,
      sourceConversationId: t.sourceConversationId ?? '',
      sourcePackId: t.sourcePackId ?? '',
      usageCount: t.usageCount,
      lastUsedAt: t.lastUsedAt ?? '',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  /** Convert Weaviate object back to Technique. */
  private objectToTechnique(id: string, props: Record<string, WeaviateField>): Technique {
    return {
      id,
      title: (props.title as string) ?? '',
      content: (props.content as string) ?? '',
      type: (props.techniqueType as Technique['type']) ?? 'generic',
      priority: (props.priority as number) ?? 3,
      domain: (props.domain as string) || null,
      tags: (props.tags as string[]) ?? [],
      category: (props.category as Technique['category']) ?? 'general',
      status: (props.status as Technique['status']) ?? 'active',
      confidence: (props.confidence as number) ?? 1.0,
      source: (props.source as Technique['source']) ?? 'user-defined',
      sourceConversationId: (props.sourceConversationId as string) || null,
      sourcePackId: (props.sourcePackId as string) || null,
      usageCount: (props.usageCount as number) ?? 0,
      lastUsedAt: (props.lastUsedAt as string) || null,
      createdAt: (props.createdAt as string) ?? new Date().toISOString(),
      updatedAt: (props.updatedAt as string) ?? new Date().toISOString(),
    };
  }

  /**
   * Build a Weaviate filter from TechniqueSearchFilters.
   * Defaults status to 'active' if not specified.
   */
  private buildFilter(filters?: TechniqueSearchFilters) {
    if (!filters) {
      // Default: only active techniques
      const collection = this.getCollection();
      return collection.filter.byProperty('status').equal('active');
    }

    const collection = this.getCollection();
    const conditions: ReturnType<ReturnType<typeof collection.filter.byProperty>['equal']>[] = [];

    // Status filter (default to 'active')
    const status = filters.status ?? 'active';
    conditions.push(collection.filter.byProperty('status').equal(status));

    if (filters.type) {
      conditions.push(collection.filter.byProperty('techniqueType').equal(filters.type));
    }

    if (filters.priority !== undefined) {
      conditions.push(collection.filter.byProperty('priority').equal(filters.priority));
    }

    if (filters.maxPriority !== undefined) {
      conditions.push(
        collection.filter.byProperty('priority').lessOrEqual(filters.maxPriority)
      );
    }

    if (filters.domain) {
      conditions.push(collection.filter.byProperty('domain').like(`*${filters.domain}*`));
    }

    if (filters.category) {
      conditions.push(collection.filter.byProperty('category').equal(filters.category));
    }

    if (filters.minConfidence !== undefined) {
      conditions.push(
        collection.filter.byProperty('confidence').greaterOrEqual(filters.minConfidence)
      );
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(
        collection.filter.byProperty('tags').containsAny(filters.tags)
      );
    }

    if (conditions.length === 0) return null;
    if (conditions.length === 1) return conditions[0];

    // Combine with AND
    return Filters.and(...conditions as [typeof conditions[0], typeof conditions[0], ...typeof conditions]);
  }
}
