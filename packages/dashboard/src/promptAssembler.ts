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
const MAX_PROMPT_TOKENS = 12_000;

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
 * 2. Knowledge techniques are NOT pre-loaded — they're retrieved dynamically by the
 *    research agent or the agent's techniques_load/techniques_search tool calls.
 *
 * Falls back to FALLBACK_SYSTEM_PROMPT if the DB has no system-prompt techniques.
 *
 * @param techniqueManager - TechniqueManager instance (must be available/healthy)
 * @param domain - Optional domain (reserved for future use)
 * @param maxKnowledgePriority - Unused, kept for API compat
 */
export async function assembleSystemPrompt(
  techniqueManager: TechniqueManager,
  _domain?: string,
  _maxKnowledgePriority: number = 2,
  countTokensFn?: (text: string) => number,
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

  // 3. Knowledge techniques are loaded dynamically by the research agent
  //    or via techniques_load/techniques_search tool calls — not pre-loaded here.

  // 4. Cap total prompt size — use token-based truncation if tokenizer available
  const counter = countTokensFn ?? ((t: string) => Math.ceil(t.length / 4));
  if (counter(prompt) > MAX_PROMPT_TOKENS) {
    // Binary-ish trim: cut chars until under token budget
    let end = Math.min(prompt.length, MAX_PROMPT_CHARS);
    while (end > 1000 && counter(prompt.slice(0, end)) > MAX_PROMPT_TOKENS) {
      end = Math.floor(end * 0.9);
    }
    prompt = prompt.slice(0, end) + '\n\n... (prompt truncated due to size)\n';
  }

  return prompt.trim();
}
