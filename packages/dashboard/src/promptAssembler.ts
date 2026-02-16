/**
 * promptAssembler — Builds the exploration agent system prompt from techniques DB.
 *
 * When the Techniques DB is available, the system prompt is assembled dynamically
 * from system-prompt seed techniques (category='system_prompt') plus knowledge
 * techniques. When the DB is unavailable or has no system-prompt techniques,
 * the fallback prompt is used instead.
 */

import type { TechniqueManager, Technique } from '@showrun/techniques';
import { FALLBACK_SYSTEM_PROMPT } from './fallbackPrompt.js';

/** Max total prompt size to prevent context bloat. */
const MAX_PROMPT_CHARS = 50_000;

/**
 * Extract order:N value from a technique's tags.
 * Returns Infinity if no order tag is found.
 */
function getOrder(tags: string[]): number {
  for (const tag of tags) {
    const m = tag.match(/^order:(\d+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return Infinity;
}

/**
 * Sort techniques by priority ascending, then by order tag ascending.
 */
function sortTechniques(techniques: Technique[]): Technique[] {
  return [...techniques].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return getOrder(a.tags) - getOrder(b.tags);
  });
}

/**
 * Assemble the full exploration agent system prompt from the Techniques DB.
 *
 * 1. Loads system-prompt techniques (category='system_prompt') → assembles the core prompt
 * 2. Loads knowledge techniques (P1-P2, non-system-prompt) → appends as "Pre-Loaded Techniques"
 * 3. If domain is provided, also loads domain-specific techniques
 *
 * Falls back to FALLBACK_SYSTEM_PROMPT if the DB has no system-prompt techniques.
 *
 * @param techniqueManager - TechniqueManager instance (must be available/healthy)
 * @param domain - Optional domain for domain-specific technique loading
 * @param maxKnowledgePriority - Max priority for knowledge techniques (default: 2)
 */
export async function assembleSystemPrompt(
  techniqueManager: TechniqueManager,
  domain?: string,
  maxKnowledgePriority: number = 2,
): Promise<string> {
  // 1. Load system-prompt techniques
  const systemPromptTechniques = await techniqueManager.listByCategory('system_prompt');

  if (systemPromptTechniques.length === 0) {
    // DB exists but has no system prompt techniques — use fallback
    console.log('[PromptAssembler] No system-prompt techniques found, using fallback');
    return FALLBACK_SYSTEM_PROMPT;
  }

  // 2. Sort and assemble system prompt sections
  const sorted = sortTechniques(systemPromptTechniques);
  let prompt = '';
  for (const t of sorted) {
    prompt += t.content + '\n\n---\n\n';
  }

  console.log(`[PromptAssembler] Assembled system prompt from ${sorted.length} techniques`);

  // 3. Load knowledge techniques (generic P1-P2 + domain-specific)
  //    Use loadUpTo which also records usage
  const { generic, specific } = await techniqueManager.loadUpTo(maxKnowledgePriority, domain);

  // Filter out system_prompt category (already rendered above)
  const knowledgeGeneric = generic.filter(t => t.category !== 'system_prompt');
  const knowledgeSpecific = specific.filter(t => t.category !== 'system_prompt');

  if (knowledgeGeneric.length > 0 || knowledgeSpecific.length > 0) {
    prompt += '## Pre-Loaded Techniques\n\n';

    if (knowledgeGeneric.length > 0) {
      prompt += '### Generic Best Practices\n';
      for (const t of knowledgeGeneric) {
        prompt += `- **${t.title}**: ${t.content}\n`;
      }
      prompt += '\n';
    }

    if (knowledgeSpecific.length > 0) {
      prompt += `### Domain: ${domain}\n`;
      for (const t of knowledgeSpecific) {
        prompt += `- **${t.title}**: ${t.content}\n`;
      }
      prompt += '\n';
    }
  }

  // 4. Cap total prompt size
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + '\n\n... (prompt truncated due to size)\n';
  }

  return prompt.trim();
}
