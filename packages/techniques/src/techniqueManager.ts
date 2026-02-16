/**
 * TechniqueManager — High-level API for technique operations.
 *
 * Wraps VectorStore with business logic for loading layers,
 * proposing/approving techniques, and managing annotations.
 */

import { v4 as uuidv4 } from 'uuid';
import type { VectorStore } from './vectorStore.js';
import type {
  Technique,
  TechniqueCategory,
  TechniqueSearchFilters,
  TechniqueSearchResult,
  ProposedTechnique,
} from './types.js';
import { SEED_TECHNIQUES } from './seeds.js';

export class TechniqueManager {
  constructor(private readonly store: VectorStore) {}

  /**
   * Load techniques up to a priority threshold.
   * Returns both generic AND domain-matched specific techniques.
   *
   * @param maxPriority Load all techniques with priority <= this value (1-5)
   * @param domain      If provided, also loads specific techniques for this domain
   */
  async loadUpTo(
    maxPriority: number,
    domain?: string,
  ): Promise<{ generic: Technique[]; specific: Technique[] }> {
    // Always load generic techniques at the requested priority level
    const generic = await this.store.list({
      type: 'generic',
      maxPriority,
      status: 'active',
    });

    let specific: Technique[] = [];
    if (domain) {
      specific = await this.store.list({
        type: 'specific',
        maxPriority,
        domain,
        status: 'active',
      });
    }

    // Record usage for all returned techniques
    const allIds = [...generic, ...specific].map(t => t.id);
    if (allIds.length > 0) {
      await this.recordUsage(allIds);
    }

    return { generic, specific };
  }

  /**
   * Hybrid search with status='active' default filter.
   */
  async search(
    query: string,
    filters?: TechniqueSearchFilters,
    limit: number = 10,
  ): Promise<TechniqueSearchResult[]> {
    const results = await this.store.search(
      query,
      { status: 'active', ...filters },
      limit,
    );

    // Record usage for returned techniques
    const ids = results.map(r => r.technique.id);
    if (ids.length > 0) {
      await this.recordUsage(ids);
    }

    return results;
  }

  /**
   * Propose new techniques learned during a session.
   * Saves with source='agent-learned'. User must approve before they enter the active pool.
   */
  async propose(
    techniques: ProposedTechnique[],
    conversationId?: string,
    packId?: string,
  ): Promise<Technique[]> {
    const now = new Date().toISOString();
    const created: Technique[] = techniques.map(t => ({
      id: uuidv4(),
      title: t.title,
      content: t.content,
      type: t.type,
      priority: Math.max(1, Math.min(5, Math.round(t.priority))), // clamp 1-5
      domain: t.domain,
      tags: t.tags,
      category: t.category,
      status: 'active' as const, // Active but source='agent-learned' flags it as proposed
      confidence: Math.max(0, Math.min(1, t.confidence)),
      source: 'agent-learned' as const,
      sourceConversationId: conversationId ?? null,
      sourcePackId: packId ?? null,
      usageCount: 0,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }));

    await this.store.upsert(created);
    return created;
  }

  /** Approve proposed techniques (mark source as user-confirmed). */
  async approve(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.store.updateMetadata(id, {
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /** Mark techniques as not_working — they will be filtered out from all queries. */
  async markNotWorking(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.store.updateMetadata(id, {
        status: 'not_working',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /** Mark techniques as deprecated — superseded by better techniques. */
  async deprecate(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.store.updateMetadata(id, {
        status: 'deprecated',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /** Increment usage counter for techniques. */
  async recordUsage(ids: string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const id of ids) {
      const existing = await this.store.get(id);
      if (existing) {
        await this.store.updateMetadata(id, {
          usageCount: existing.usageCount + 1,
          lastUsedAt: now,
        });
      }
    }
  }

  /**
   * List techniques by category, with optional additional filters.
   */
  async listByCategory(
    category: TechniqueCategory,
    filters?: Omit<TechniqueSearchFilters, 'category'>,
  ): Promise<Technique[]> {
    return this.store.list({
      category,
      status: 'active',
      ...filters,
    });
  }

  /**
   * Seed built-in techniques (incremental).
   * Only inserts seed techniques whose titles don't already exist in the DB.
   * Returns the number of newly seeded techniques.
   */
  async seedIfEmpty(): Promise<number> {
    const existing = await this.store.list({ status: 'active' });
    const existingTitles = new Set(
      existing.filter(t => t.source === 'seed').map(t => t.title),
    );

    const missing = SEED_TECHNIQUES.filter(t => !existingTitles.has(t.title));
    if (missing.length === 0) return 0;

    const now = new Date().toISOString();
    const seeds: Technique[] = missing.map(t => ({
      id: uuidv4(),
      title: t.title,
      content: t.content,
      type: t.type,
      priority: t.priority,
      domain: t.domain,
      tags: t.tags,
      category: t.category,
      status: 'active' as const,
      confidence: t.confidence,
      source: 'seed' as const,
      sourceConversationId: null,
      sourcePackId: null,
      usageCount: 0,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }));

    await this.store.upsert(seeds);
    return seeds.length;
  }

  /** Export techniques matching filters (both generic and specific are exportable). */
  async exportBundle(filters?: TechniqueSearchFilters): Promise<Technique[]> {
    return this.store.list({
      status: 'active',
      ...filters,
    });
  }

  /** Import a technique bundle. Skips techniques whose IDs already exist. */
  async importBundle(
    techniques: Technique[],
  ): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;

    for (const t of techniques) {
      const existing = await this.store.get(t.id);
      if (existing) {
        skipped++;
        continue;
      }

      const now = new Date().toISOString();
      await this.store.upsert([{
        ...t,
        source: 'imported',
        usageCount: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      }]);
      imported++;
    }

    return { imported, skipped };
  }

  /** Check if the vector store is connected and healthy. */
  async isAvailable(): Promise<boolean> {
    return this.store.isHealthy();
  }
}
