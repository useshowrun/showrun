/**
 * Weaviate setup helper — verifies connection, creates collection, seeds techniques.
 * Used by `showrun techniques setup` CLI command.
 */

import { WeaviateVectorStore } from './index.js';
import { TechniqueManager } from '../techniqueManager.js';
import type { VectorStoreConfig } from '../types.js';

export interface SetupResult {
  connected: boolean;
  collectionCreated: boolean;
  seeded: number;
  errors: string[];
}

export async function setupWeaviate(config: VectorStoreConfig): Promise<SetupResult> {
  const result: SetupResult = {
    connected: false,
    collectionCreated: false,
    seeded: 0,
    errors: [],
  };

  // 1. Create store and initialize (connects + creates collection if needed)
  const store = new WeaviateVectorStore(config);
  try {
    await store.initialize();
    result.connected = true;
    result.collectionCreated = true;
    console.log('[Setup] Connected to Weaviate and collection is ready.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Connection failed: ${msg}`);
    console.error(`[Setup] Failed to connect to Weaviate: ${msg}`);
    return result;
  }

  // 2. Health check
  const healthy = await store.isHealthy();
  if (!healthy) {
    result.errors.push('Weaviate health check failed after initialization');
    console.error('[Setup] Weaviate health check failed.');
    return result;
  }

  // 3. Seed built-in techniques
  try {
    const manager = new TechniqueManager(store);
    result.seeded = await manager.seedIfEmpty();
    if (result.seeded > 0) {
      console.log(`[Setup] Seeded ${result.seeded} built-in techniques.`);
    } else {
      console.log('[Setup] Seed techniques already exist, skipping.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Seeding failed: ${msg}`);
    console.error(`[Setup] Failed to seed techniques: ${msg}`);
  }

  return result;
}
