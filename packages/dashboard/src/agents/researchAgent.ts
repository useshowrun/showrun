/**
 * Research Agent: searches the Techniques DB (Weaviate vector store) for
 * the best techniques relevant to a given task description, then compiles
 * them into a structured prompt that can be reviewed and overridden by the user.
 *
 * Unlike the Editor/Validator agents, the Research Agent does NOT run an LLM loop.
 * It performs vector search, groups results, and assembles a prompt deterministically.
 */

import type { TechniqueManager, TechniqueSearchResult } from '@showrun/techniques';
import type { LlmProvider } from '../llm/provider.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ResearchAgentOptions {
  /** The user's task description / goal */
  taskDescription: string;
  /** Optional domain hint (e.g. "linkedin.com", "gmail.com") */
  domain?: string;
  /** Optional categories to focus on */
  categories?: string[];
  /** TechniqueManager for vector search */
  techniqueManager: TechniqueManager;
  /** LLM provider for optional prompt refinement */
  llmProvider?: LlmProvider;
  /** Max techniques to include in the compiled prompt */
  maxTechniques?: number;
}

export interface ResearchAgentResult {
  /** Whether the research completed successfully */
  success: boolean;
  /** The compiled prompt ready for agent use */
  compiledPrompt: string;
  /** Techniques that were found and included, grouped by category */
  techniqueGroups: Array<{
    category: string;
    techniques: Array<{
      id: string;
      title: string;
      content: string;
      priority: number;
      score: number;
      domain: string | null;
    }>;
  }>;
  /** Total number of techniques found */
  totalTechniquesFound: number;
  /** Search queries that were used */
  searchQueries: string[];
  /** Error message if failed */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Derive search queries from the task description.
 * Generates multiple focused queries for broader coverage.
 */
function deriveSearchQueries(taskDescription: string, domain?: string): string[] {
  const queries: string[] = [taskDescription];

  // Extract action-oriented keywords
  const actionPatterns = [
    /\b(scrape|extract|collect|fetch|download|get|retrieve)\b/i,
    /\b(login|auth|sign.?in|authenticate|session)\b/i,
    /\b(paginate|scroll|load.?more|next.?page|infinite)\b/i,
    /\b(navigate|browse|visit|open|go.?to)\b/i,
    /\b(fill|submit|form|input|type|click)\b/i,
    /\b(api|endpoint|request|response|network|xhr|fetch)\b/i,
    /\b(captcha|bot|detection|block|rate.?limit)\b/i,
  ];

  for (const pattern of actionPatterns) {
    const match = taskDescription.match(pattern);
    if (match) {
      queries.push(`${match[0]} technique web automation`);
    }
  }

  // Add domain-specific query
  if (domain) {
    queries.push(`${domain} automation technique`);
    queries.push(`${domain} api extraction`);
  }

  // Deduplicate
  return [...new Set(queries)];
}

/**
 * Group techniques by category and deduplicate.
 */
function groupAndDeduplicate(
  results: Array<TechniqueSearchResult & { query: string }>,
  maxTotal: number,
): ResearchAgentResult['techniqueGroups'] {
  const seen = new Set<string>();
  const groups = new Map<string, ResearchAgentResult['techniqueGroups'][0]['techniques']>();

  // Sort by score descending
  const sorted = [...results].sort((a, b) => b.score - a.score);

  for (const r of sorted) {
    if (seen.has(r.technique.id)) continue;
    if (seen.size >= maxTotal) break;

    seen.add(r.technique.id);
    const cat = r.technique.category || 'general';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push({
      id: r.technique.id,
      title: r.technique.title,
      content: r.technique.content,
      priority: r.technique.priority,
      score: r.score,
      domain: r.technique.domain,
    });
  }

  return Array.from(groups.entries())
    .map(([category, techniques]) => ({ category, techniques }))
    .sort((a, b) => {
      // Sort categories: system_prompt first, then by average priority
      if (a.category === 'system_prompt') return -1;
      if (b.category === 'system_prompt') return 1;
      const avgA = a.techniques.reduce((s, t) => s + t.priority, 0) / a.techniques.length;
      const avgB = b.techniques.reduce((s, t) => s + t.priority, 0) / b.techniques.length;
      return avgA - avgB;
    });
}

const CATEGORY_LABELS: Record<string, string> = {
  system_prompt: 'Core Agent Instructions',
  api_extraction: 'API Extraction Patterns',
  dom_extraction: 'DOM Extraction Patterns',
  navigation: 'Navigation Strategies',
  auth: 'Authentication Techniques',
  pagination: 'Pagination Handling',
  anti_detection: 'Anti-Detection / Stealth',
  form_interaction: 'Form Interaction',
  network_patterns: 'Network Patterns',
  data_transformation: 'Data Transformation',
  error_handling: 'Error Handling',
  general: 'General Techniques',
};

/**
 * Compile technique groups into a structured prompt.
 */
function compilePrompt(
  taskDescription: string,
  groups: ResearchAgentResult['techniqueGroups'],
  domain?: string,
): string {
  const sections: string[] = [];

  sections.push(`# Research Results for Task\n`);
  sections.push(`**Task:** ${taskDescription}`);
  if (domain) sections.push(`**Domain:** ${domain}`);
  sections.push('');

  sections.push(`## Retrieved Techniques\n`);
  sections.push(`The following techniques were retrieved from the knowledge base, ranked by relevance.\n`);

  for (const group of groups) {
    const label = CATEGORY_LABELS[group.category] || group.category;
    sections.push(`### ${label}\n`);

    for (const tech of group.techniques) {
      const pLabel = `P${tech.priority}`;
      const domainTag = tech.domain ? ` [${tech.domain}]` : '';
      sections.push(`#### ${tech.title} (${pLabel}${domainTag})\n`);
      sections.push(tech.content);
      sections.push('');
    }
  }

  sections.push(`---\n`);
  sections.push(`## Guidance for Agent\n`);
  sections.push(`Apply the techniques above when executing the task. Prioritize P1 techniques over P2+. Domain-specific techniques take precedence over generic ones when applicable.\n`);

  return sections.join('\n');
}

/**
 * Run the Research Agent to find and compile relevant techniques.
 */
export async function runResearchAgent(options: ResearchAgentOptions): Promise<ResearchAgentResult> {
  const {
    taskDescription,
    domain,
    categories,
    techniqueManager,
    maxTechniques = 20,
  } = options;

  try {
    // 1. Derive search queries from task description
    const searchQueries = deriveSearchQueries(taskDescription, domain);

    // 2. Execute searches in parallel
    const allResults: Array<TechniqueSearchResult & { query: string }> = [];

    const searchPromises = searchQueries.map(async (query) => {
      const filters: Record<string, unknown> = {};
      // Only include domain-specific techniques when domain matches
      // Without a domain, restrict to generic techniques to avoid
      // pulling in irrelevant site-specific entries (e.g. LinkedIn for non-LinkedIn tasks)
      if (domain) {
        filters.domain = domain;
      } else {
        filters.type = 'generic';
      }
      if (categories && categories.length > 0) {
        // Search per category for broader coverage
        const perCat = await Promise.all(
          categories.map(cat =>
            techniqueManager.search(query, { category: cat as any, ...filters }, 5)
          ),
        );
        return perCat.flat().map(r => ({ ...r, query }));
      }
      const results = await techniqueManager.search(query, filters as any, 10);
      return results.map(r => ({ ...r, query }));
    });

    const searchResults = await Promise.all(searchPromises);
    for (const batch of searchResults) {
      allResults.push(...batch);
    }

    // 3. Also load knowledge techniques (P1-P3) as baseline, excluding system_prompt
    //    System prompt entries are handled separately by the promptAssembler.
    const { generic, specific } = await techniqueManager.loadUpTo(3, domain);
    for (const t of [...generic, ...specific]) {
      if (t.category === 'system_prompt') continue;
      allResults.push({
        technique: t,
        score: t.priority === 1 ? 0.9 : t.priority === 2 ? 0.7 : 0.5,
        query: 'baseline-load',
      });
    }

    // 4. Group, deduplicate, and limit
    const techniqueGroups = groupAndDeduplicate(allResults, maxTechniques);
    const totalFound = techniqueGroups.reduce((sum, g) => sum + g.techniques.length, 0);

    // 5. Compile prompt
    const compiledPrompt = compilePrompt(taskDescription, techniqueGroups, domain);

    return {
      success: true,
      compiledPrompt,
      techniqueGroups,
      totalTechniquesFound: totalFound,
      searchQueries,
    };
  } catch (err) {
    return {
      success: false,
      compiledPrompt: '',
      techniqueGroups: [],
      totalTechniquesFound: 0,
      searchQueries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
