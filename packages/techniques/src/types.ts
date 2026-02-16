/**
 * Techniques DB — Core Types
 *
 * A technique is the minimal unit of approach to achieve a result in web automation.
 * Two orthogonal dimensions classify each technique:
 *   - type:     scope/shareability (generic = all sessions, specific = domain-scoped)
 *   - priority: loading order within either type (1 = critical … 5 = edge-case)
 */

// ── Technique ────────────────────────────────────────────────────────────────

export interface Technique {
  id: string;
  title: string;
  /** The full technique text — this is what gets embedded for vector search. */
  content: string;

  // ── Two orthogonal dimensions ──
  type: TechniqueType;
  priority: number; // 1–5

  /** Domain this applies to (required when type = 'specific', null when 'generic'). */
  domain: string | null;
  tags: string[];
  category: TechniqueCategory;

  // ── Non-vector-indexed annotations ──
  status: TechniqueStatus;
  /** Reliability score, 0.0 – 1.0. */
  confidence: number;
  source: TechniqueSource;
  sourceConversationId: string | null;
  sourcePackId: string | null;
  usageCount: number;
  lastUsedAt: string | null; // ISO 8601
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ── Enums / union types ──────────────────────────────────────────────────────

/**
 * TYPE = scope / shareability
 *   generic  — shared across ALL sessions, all domains. Master prompt layer.
 *   specific — tied to a domain. Exportable as a bundle alongside taskpacks.
 */
export type TechniqueType = 'generic' | 'specific';

/**
 * PRIORITY = loading order WITHIN either type
 *   1 = Critical:   always loaded first, non-negotiable rules
 *   2 = Important:  loaded early, strongly recommended patterns
 *   3 = Useful:     loaded in second pass, good-to-know context
 *   4 = Contextual: loaded on-demand via search, situational
 *   5 = Edge-case:  rarely needed, very specific detail
 */
export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 5;

export type TechniqueStatus = 'active' | 'deprecated' | 'not_working';

export type TechniqueSource =
  | 'agent-learned'
  | 'user-defined'
  | 'imported'
  | 'seed';

export type TechniqueCategory =
  | 'api_extraction'
  | 'dom_extraction'
  | 'navigation'
  | 'auth'
  | 'pagination'
  | 'anti_detection'
  | 'form_interaction'
  | 'network_patterns'
  | 'data_transformation'
  | 'error_handling'
  | 'system_prompt'
  | 'general';

// ── Search / filter types ────────────────────────────────────────────────────

export interface TechniqueSearchFilters {
  type?: TechniqueType;
  /** Exact priority match. */
  priority?: number;
  /** Load all techniques with priority <= N. */
  maxPriority?: number;
  /** Fuzzy domain match (substring). */
  domain?: string;
  category?: TechniqueCategory;
  /** Defaults to 'active' — not_working / deprecated are never served unless explicitly requested. */
  status?: TechniqueStatus;
  minConfidence?: number;
  tags?: string[];
}

export interface TechniqueSearchResult {
  technique: Technique;
  /** Relevance score from hybrid search (higher = more relevant). */
  score: number;
}

// ── Proposal types ───────────────────────────────────────────────────────────

export interface ProposedTechnique {
  title: string;
  content: string;
  type: TechniqueType;
  priority: number;
  domain: string | null;
  category: TechniqueCategory;
  tags: string[];
  confidence: number;
}

// ── Config types ─────────────────────────────────────────────────────────────

export interface EmbeddingConfig {
  apiKey: string;
  /** Model name, e.g. "text-embedding-3-small". */
  model: string;
  /** OpenAI-compatible base URL. Defaults to "https://api.openai.com/v1". */
  baseUrl?: string;
  /** Embedding dimensions. Defaults to 1536. */
  dimensions?: number;
}

export interface VectorStoreConfig {
  url: string;
  apiKey?: string;
  /**
   * External embedding config (bring-your-own-vectors mode).
   * When omitted, Weaviate's built-in vectorizer module is used instead.
   */
  embeddingConfig?: EmbeddingConfig;
  /**
   * Weaviate vectorizer module name (e.g. 'text2vec-transformers', 'text2vec-openai').
   * Only used when embeddingConfig is NOT provided.
   * Defaults to 'text2vec-transformers'.
   */
  vectorizer?: string;
  /** Weaviate collection name. Defaults to "ShowrunTechniques". */
  collectionName?: string;
}
