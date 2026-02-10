import type { TaskPack, CollectibleDefinition } from './types.js';
import type { DslStep } from './dsl/types.js';
import { validateFlow, ValidationError } from './dsl/validation.js';

/** Step types that produce collectible output via an "out" parameter */
const STEPS_WITH_OUT = new Set([
  'extract_title', 'extract_text', 'extract_attribute',
  'network_replay', 'network_extract',
]);

/**
 * Validates that collectibles referenced in flow steps exist
 */
export function validateCollectiblesMatchFlow(
  collectibles: CollectibleDefinition[],
  flow: DslStep[]
): void {
  const collectibleNames = new Set(collectibles.map((c) => c.name));
  const referencedOuts = new Set<string>();

  // Extract all 'out' parameters from steps that write to collectibles
  for (const step of flow) {
    if (STEPS_WITH_OUT.has(step.type)) {
      const out = (step.params as { out?: string })?.out;
      if (out && typeof out === 'string') {
        referencedOuts.add(out);
      }
    }
  }

  // Check that all referenced outs exist in collectibles
  const mismatches: string[] = [];
  for (const out of referencedOuts) {
    if (!collectibleNames.has(out)) {
      mismatches.push(out);
    }
  }
  if (mismatches.length > 0) {
    throw new ValidationError(
      `Flow step(s) write to undeclared collectible(s): [${mismatches.join(', ')}]. Only declared collectibles are returned in the output. Declared: [${[...collectibleNames].join(', ')}]`
    );
  }
}

/**
 * Validates a JSON Task Pack structure
 */
export function validateJsonTaskPack(pack: TaskPack): void {
  const errors: string[] = [];

  // Validate metadata
  if (!pack.metadata.id || !pack.metadata.name || !pack.metadata.version) {
    errors.push('Task pack must have metadata.id, metadata.name, and metadata.version');
  }

  // Validate inputs schema
  if (!pack.inputs || typeof pack.inputs !== 'object') {
    errors.push('Task pack must have an inputs object');
  }

  // Validate collectibles
  if (!Array.isArray(pack.collectibles)) {
    errors.push('Task pack must have a collectibles array');
  }

  // Validate flow
  if (!pack.flow || !Array.isArray(pack.flow)) {
    errors.push('Task pack must have a flow array');
  } else {
    // Validate flow (includes step validation and duplicate ID check)
    validateFlow(pack.flow, errors);

    // Validate collectibles match flow
    if (pack.collectibles && pack.flow) {
      try {
        validateCollectiblesMatchFlow(pack.collectibles, pack.flow);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(`Task pack validation failed:\n${errors.join('\n')}`);
  }
}
