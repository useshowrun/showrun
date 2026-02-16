import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TechniqueManager } from '../techniqueManager.js';
import type { VectorStore, MetadataUpdate } from '../vectorStore.js';
import type {
  Technique,
  TechniqueSearchFilters,
  TechniqueSearchResult,
} from '../types.js';
import { SEED_TECHNIQUES } from '../seeds.js';

// ── Mock VectorStore ──────────────────────────────────────────────────────────

function makeTechnique(overrides: Partial<Technique> = {}): Technique {
  return {
    id: 'test-id-1',
    title: 'Test Technique',
    content: 'Test content for embedding.',
    type: 'generic',
    priority: 1,
    domain: null,
    tags: ['test'],
    category: 'general',
    status: 'active',
    confidence: 1.0,
    source: 'seed',
    sourceConversationId: null,
    sourcePackId: null,
    usageCount: 0,
    lastUsedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockStore(): VectorStore & {
  _techniques: Map<string, Technique>;
} {
  const techniques = new Map<string, Technique>();

  return {
    _techniques: techniques,

    async initialize(): Promise<void> {},

    async upsert(items: Technique[]): Promise<void> {
      for (const t of items) {
        techniques.set(t.id, { ...t });
      }
    },

    async search(
      query: string,
      filters?: TechniqueSearchFilters,
      limit?: number,
    ): Promise<TechniqueSearchResult[]> {
      const results = this._matchFilters(filters);
      // Simple substring matching for the mock
      const scored = results
        .map(t => ({
          technique: t,
          score: query
            ? (t.title.includes(query) || t.content.includes(query) ? 0.9 : 0.1)
            : 0.5,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit ?? 10);
      return scored;
    },

    async get(id: string): Promise<Technique | null> {
      return techniques.get(id) ?? null;
    },

    async delete(id: string): Promise<boolean> {
      return techniques.delete(id);
    },

    async updateMetadata(id: string, updates: MetadataUpdate): Promise<void> {
      const existing = techniques.get(id);
      if (!existing) return;
      techniques.set(id, { ...existing, ...updates });
    },

    async list(filters?: TechniqueSearchFilters): Promise<Technique[]> {
      return this._matchFilters(filters);
    },

    async isHealthy(): Promise<boolean> {
      return true;
    },

    // Helper for filtering
    _matchFilters(filters?: TechniqueSearchFilters): Technique[] {
      let results = [...techniques.values()];
      if (!filters) return results;

      if (filters.status) {
        results = results.filter(t => t.status === filters.status);
      }
      if (filters.type) {
        results = results.filter(t => t.type === filters.type);
      }
      if (filters.maxPriority !== undefined) {
        results = results.filter(t => t.priority <= filters.maxPriority!);
      }
      if (filters.priority !== undefined) {
        results = results.filter(t => t.priority === filters.priority);
      }
      if (filters.domain) {
        results = results.filter(t => t.domain?.includes(filters.domain!) ?? false);
      }
      if (filters.category) {
        results = results.filter(t => t.category === filters.category);
      }
      if (filters.minConfidence !== undefined) {
        results = results.filter(t => t.confidence >= filters.minConfidence!);
      }
      return results;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TechniqueManager', () => {
  let store: ReturnType<typeof createMockStore>;
  let manager: TechniqueManager;

  beforeEach(() => {
    store = createMockStore();
    manager = new TechniqueManager(store);
  });

  describe('seedIfEmpty', () => {
    it('seeds techniques when store is empty', async () => {
      const count = await manager.seedIfEmpty();
      expect(count).toBe(SEED_TECHNIQUES.length);
      expect(store._techniques.size).toBe(SEED_TECHNIQUES.length);
    });

    it('skips seeding when seeds already exist', async () => {
      // First seed
      await manager.seedIfEmpty();
      const firstSize = store._techniques.size;

      // Second seed should be a no-op
      const count = await manager.seedIfEmpty();
      expect(count).toBe(0);
      expect(store._techniques.size).toBe(firstSize);
    });

    it('seeds with correct metadata', async () => {
      await manager.seedIfEmpty();
      const all = [...store._techniques.values()];
      for (const t of all) {
        expect(t.source).toBe('seed');
        expect(t.status).toBe('active');
        expect(t.confidence).toBe(1.0);
        expect(t.usageCount).toBe(0);
        expect(t.id).toBeTruthy();
      }
    });
  });

  describe('loadUpTo', () => {
    it('loads generic techniques up to priority threshold', async () => {
      store._techniques.set('g1', makeTechnique({ id: 'g1', type: 'generic', priority: 1 }));
      store._techniques.set('g2', makeTechnique({ id: 'g2', type: 'generic', priority: 2 }));
      store._techniques.set('g3', makeTechnique({ id: 'g3', type: 'generic', priority: 3 }));

      const result = await manager.loadUpTo(2);
      expect(result.generic).toHaveLength(2);
      expect(result.specific).toHaveLength(0);
      expect(result.generic.map(t => t.id).sort()).toEqual(['g1', 'g2']);
    });

    it('loads both generic and specific techniques when domain provided', async () => {
      store._techniques.set('g1', makeTechnique({ id: 'g1', type: 'generic', priority: 1 }));
      store._techniques.set('s1', makeTechnique({
        id: 's1', type: 'specific', priority: 1, domain: 'example.com',
      }));
      store._techniques.set('s2', makeTechnique({
        id: 's2', type: 'specific', priority: 3, domain: 'example.com',
      }));

      const result = await manager.loadUpTo(2, 'example.com');
      expect(result.generic).toHaveLength(1);
      expect(result.specific).toHaveLength(1);
      expect(result.specific[0].id).toBe('s1');
    });

    it('does not load specific techniques when no domain provided', async () => {
      store._techniques.set('s1', makeTechnique({
        id: 's1', type: 'specific', priority: 1, domain: 'example.com',
      }));

      const result = await manager.loadUpTo(5);
      expect(result.specific).toHaveLength(0);
    });

    it('records usage for loaded techniques', async () => {
      store._techniques.set('g1', makeTechnique({ id: 'g1', usageCount: 0 }));

      await manager.loadUpTo(5);

      const updated = store._techniques.get('g1')!;
      expect(updated.usageCount).toBe(1);
      expect(updated.lastUsedAt).toBeTruthy();
    });
  });

  describe('search', () => {
    it('searches with active status by default', async () => {
      store._techniques.set('a1', makeTechnique({
        id: 'a1', title: 'Active API', status: 'active',
      }));
      store._techniques.set('nw1', makeTechnique({
        id: 'nw1', title: 'Not Working API', status: 'not_working',
      }));

      const results = await manager.search('API');
      expect(results).toHaveLength(1);
      expect(results[0].technique.id).toBe('a1');
    });

    it('returns results with scores', async () => {
      store._techniques.set('a1', makeTechnique({ id: 'a1', title: 'Test technique' }));

      const results = await manager.search('Test');
      expect(results).toHaveLength(1);
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].technique).toBeDefined();
    });

    it('records usage for search results', async () => {
      store._techniques.set('a1', makeTechnique({ id: 'a1', usageCount: 5 }));

      await manager.search('');

      const updated = store._techniques.get('a1')!;
      expect(updated.usageCount).toBe(6);
    });
  });

  describe('propose', () => {
    it('creates techniques with agent-learned source', async () => {
      const proposed = await manager.propose([{
        title: 'New Pattern',
        content: 'A new pattern I discovered.',
        type: 'specific',
        priority: 3,
        domain: 'test.com',
        category: 'api_extraction',
        tags: ['api', 'test'],
        confidence: 0.8,
      }]);

      expect(proposed).toHaveLength(1);
      expect(proposed[0].source).toBe('agent-learned');
      expect(proposed[0].status).toBe('active');
      expect(proposed[0].domain).toBe('test.com');
      expect(proposed[0].id).toBeTruthy();
    });

    it('clamps priority to 1-5 range', async () => {
      const proposed = await manager.propose([
        {
          title: 'Too Low', content: 'x', type: 'generic', priority: 0,
          domain: null, category: 'general', tags: [], confidence: 1.0,
        },
        {
          title: 'Too High', content: 'x', type: 'generic', priority: 10,
          domain: null, category: 'general', tags: [], confidence: 1.0,
        },
      ]);

      expect(proposed[0].priority).toBe(1);
      expect(proposed[1].priority).toBe(5);
    });

    it('clamps confidence to 0-1 range', async () => {
      const proposed = await manager.propose([{
        title: 'Bad Confidence', content: 'x', type: 'generic', priority: 1,
        domain: null, category: 'general', tags: [], confidence: 2.5,
      }]);

      expect(proposed[0].confidence).toBe(1);
    });

    it('attaches conversation and pack IDs', async () => {
      const proposed = await manager.propose(
        [{
          title: 'With Context', content: 'x', type: 'generic', priority: 1,
          domain: null, category: 'general', tags: [], confidence: 1.0,
        }],
        'conv-123',
        'pack-456',
      );

      expect(proposed[0].sourceConversationId).toBe('conv-123');
      expect(proposed[0].sourcePackId).toBe('pack-456');
    });
  });

  describe('markNotWorking', () => {
    it('sets status to not_working', async () => {
      store._techniques.set('t1', makeTechnique({ id: 't1', status: 'active' }));

      await manager.markNotWorking(['t1']);

      const updated = store._techniques.get('t1')!;
      expect(updated.status).toBe('not_working');
    });

    it('makes technique invisible to default search', async () => {
      store._techniques.set('t1', makeTechnique({ id: 't1', title: 'API Pattern' }));

      await manager.markNotWorking(['t1']);

      const results = await manager.search('API');
      expect(results).toHaveLength(0);
    });
  });

  describe('deprecate', () => {
    it('sets status to deprecated', async () => {
      store._techniques.set('t1', makeTechnique({ id: 't1', status: 'active' }));

      await manager.deprecate(['t1']);

      const updated = store._techniques.get('t1')!;
      expect(updated.status).toBe('deprecated');
    });
  });

  describe('exportBundle', () => {
    beforeEach(() => {
      store._techniques.set('g1', makeTechnique({ id: 'g1', type: 'generic' }));
      store._techniques.set('s1', makeTechnique({
        id: 's1', type: 'specific', domain: 'example.com',
      }));
      store._techniques.set('s2', makeTechnique({
        id: 's2', type: 'specific', domain: 'other.com',
      }));
    });

    it('exports all active techniques when no filters given', async () => {
      const bundle = await manager.exportBundle();
      expect(bundle).toHaveLength(3);
    });

    it('exports only specific techniques for a given domain', async () => {
      const bundle = await manager.exportBundle({ type: 'specific', domain: 'example.com' });
      expect(bundle).toHaveLength(1);
      expect(bundle[0].id).toBe('s1');
    });

    it('exports all generic techniques', async () => {
      const bundle = await manager.exportBundle({ type: 'generic' });
      expect(bundle).toHaveLength(1);
      expect(bundle[0].id).toBe('g1');
    });

    it('exports by domain without type filter (gets both generic and specific)', async () => {
      store._techniques.set('g2', makeTechnique({
        id: 'g2', type: 'generic', domain: 'example.com',
      }));
      const bundle = await manager.exportBundle({ domain: 'example.com' });
      expect(bundle).toHaveLength(2); // s1 + g2
    });
  });

  describe('importBundle', () => {
    it('imports new techniques', async () => {
      const toImport = [
        makeTechnique({ id: 'imp-1', source: 'user-defined' }),
        makeTechnique({ id: 'imp-2', source: 'user-defined' }),
      ];

      const result = await manager.importBundle(toImport);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);

      // Verify source is overridden to 'imported'
      const imported = store._techniques.get('imp-1')!;
      expect(imported.source).toBe('imported');
    });

    it('skips techniques that already exist', async () => {
      store._techniques.set('existing', makeTechnique({ id: 'existing' }));

      const result = await manager.importBundle([
        makeTechnique({ id: 'existing' }),
        makeTechnique({ id: 'new-one' }),
      ]);

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('isAvailable', () => {
    it('returns true when store is healthy', async () => {
      expect(await manager.isAvailable()).toBe(true);
    });

    it('returns false when store is unhealthy', async () => {
      store.isHealthy = async () => false;
      expect(await manager.isAvailable()).toBe(false);
    });
  });
});
