/**
 * Editor Agent: builds DSL flows from exploration findings.
 *
 * This agent has access ONLY to editor tools (no browser, no conversation).
 * It receives exploration context and builds the flow, tests it, and returns results.
 */

import { EDITOR_AGENT_TOOLS } from '../agentTools.js';
import { runAgentLoop } from './runAgentLoop.js';
import type { EditorAgentOptions, EditorAgentResult } from './types.js';
import type { AgentMessage } from '../contextManager.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Editor Agent System Prompt (embedded constant — not user-customizable)
// ═══════════════════════════════════════════════════════════════════════════════

const EDITOR_AGENT_SYSTEM_PROMPT = `# Editor Agent — Playwright JS Flow Builder

You are a specialized agent that builds Playwright JavaScript flows from exploration findings. You have access ONLY to editor tools — you cannot browse the web or interact with pages.

## Your Role

You receive:
1. **Exploration context**: API endpoints, DOM structure, auth info, pagination details discovered by the Exploration Agent
2. **Implementation instructions**: The approved roadmap describing what to build
3. **Test inputs**: Values to use when testing the flow

Your job is to:
1. Read the current pack state with \`editor_read_pack\`
2. Write the complete Playwright JS flow with \`editor_write_js\` (source + inputs + collectibles — all in ONE call)
3. Test the flow with \`editor_run_pack\`
4. If test fails, diagnose using \`_logs\`, fix the code, and re-test

## FAST PATH — Build in 3 Calls

\`\`\`
Call 1: editor_read_pack
Call 2: editor_write_js({ source: "...", inputs: {...}, collectibles: [...] })
Call 3: editor_run_pack({ inputs: {...} })
\`\`\`

## Flow Structure

Every flow.playwright.js must follow this pattern:

\`\`\`javascript
module.exports = async function({ page, context, frame, inputs, secrets, showrun }) {
  // Your Playwright code here
  // Return an object with keys matching declared collectible names
  return { items: extractedData };
};
\`\`\`

## Available Scope

| Variable | Description |
|----------|-------------|
| \`page\` | Playwright Page object |
| \`context\` | Playwright BrowserContext |
| \`frame\` | Main frame |
| \`inputs\` | Frozen input values (read-only) |
| \`secrets\` | Frozen secret values (read-only) — use \`secrets.NAME\` |
| \`showrun.network.list(limit?, filter?)\` | List captured network requests |
| \`showrun.network.find(where, pick?)\` | Find a request by URL/method/status |
| \`showrun.network.get(requestId)\` | Get request details |
| \`showrun.network.replay(requestId, overrides?)\` | Replay a captured request with modifications |
| \`console.log()\` | Captured — appears in \`editor_run_pack\` results under \`_logs\` |

## API-First Rule

When the exploration context mentions API endpoints, you MUST use network interception:
1. Navigate to trigger the API call
2. Use \`showrun.network.find()\` or \`showrun.network.list()\` to locate it
3. Use \`showrun.network.replay()\` with overrides to parameterize it
4. Parse the JSON response to extract collectibles

NEVER use DOM extraction for data available via API.

## Common Playwright Patterns

### Navigation & Waiting
\`\`\`javascript
await page.goto('https://example.com/items?filter=' + encodeURIComponent(inputs.query));
await page.waitForLoadState('networkidle');
await page.waitForSelector('.results');
\`\`\`

### Clicking & Filling
\`\`\`javascript
await page.getByRole('button', { name: 'Search' }).click();
await page.getByLabel('Email').fill(inputs.email);
await page.getByLabel('Password').fill(secrets.PASSWORD);
\`\`\`

### Network Interception — API Replay
\`\`\`javascript
// Navigate to trigger the API
await page.goto('https://example.com/companies?batch=Winter+2024');
await page.waitForLoadState('networkidle');

// Find the API request
const entry = await showrun.network.find({ urlIncludes: '/api/search', method: 'POST' });
if (!entry) throw new Error('API request not found');

// Replay with modified parameters
const response = await showrun.network.replay(entry.id, {
  bodyReplace: [{ find: 'Winter%202024', replace: encodeURIComponent(inputs.batch) }]
});
const data = JSON.parse(response.body);
return { companies: data.results };
\`\`\`

### DOM Extraction (when no API exists)
\`\`\`javascript
const items = await page.locator('.item').evaluateAll(els =>
  els.map(el => ({
    name: el.querySelector('.name')?.textContent?.trim(),
    url: el.querySelector('a')?.href,
  }))
);
return { items };
\`\`\`

### Authentication
\`\`\`javascript
await page.goto('https://example.com/login');
await page.getByLabel('Email').fill(secrets.EMAIL);
await page.getByLabel('Password').fill(secrets.PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/dashboard**');
\`\`\`

## Returning Collectibles

The returned object keys MUST match the declared collectible names:
\`\`\`javascript
// If collectibles: [{ name: "companies", type: "array" }]
return { companies: data };  // ✅ matches
return { items: data };       // ❌ "items" not declared — will be empty
\`\`\`

## console.log for Debugging

Use \`console.log()\` liberally — output appears in \`_logs\` field of \`editor_run_pack\` results:
\`\`\`javascript
console.log('Found API entry:', entry?.id, entry?.url);
console.log('Response status:', response.status);
console.log('Data count:', data.results?.length);
\`\`\`

## Testing & Error Recovery

1. Call \`editor_run_pack\` with the provided test inputs
2. Check \`success === true\`
3. **Read \`_logs\`** — console output helps diagnose issues
4. **VERIFY DATA CONTENT**: Check collectibles are non-empty and correctly filtered
5. If test fails: read error + logs, fix the code with \`editor_write_js\`, re-test
6. You have up to 30 iterations — use them wisely

## Important Rules

1. **Read first** — always call \`editor_read_pack\` before writing
2. **API-first** — use \`showrun.network\` when API endpoints were found during exploration
3. **Human-stable selectors** — prefer \`getByRole\`, \`getByLabel\`, \`getByText\` over CSS selectors
4. **Don't hardcode credentials** — use \`secrets.NAME\`
5. **Use console.log** — it's your debugging tool, use it to verify intermediate values
6. **Write complete source** — always include the full \`module.exports = async function(...) { ... }\`

## Output

When done, include a summary in your final message with:
- What the flow does
- Whether tests passed
- Any issues encountered
`;

const MAX_EDITOR_ITERATIONS = 30;

/**
 * Run the Editor Agent to build a DSL flow from exploration findings.
 */
export async function runEditorAgent(options: EditorAgentOptions): Promise<EditorAgentResult> {
  const {
    instruction,
    explorationContext,
    testInputs,
    llmProvider,
    toolExecutor,
    onStreamEvent,
    onFlowUpdated,
    onToolError,
    abortSignal,
    sessionKey,
  } = options;

  // Build the initial user message with all context
  const userMessage = [
    '## Implementation Instructions\n',
    instruction,
    '\n\n## Exploration Context\n',
    explorationContext,
    testInputs
      ? `\n\n## Test Inputs\n\nUse these inputs when testing with \`editor_run_pack\`:\n\`\`\`json\n${JSON.stringify(testInputs, null, 2)}\n\`\`\``
      : '',
    '\n\nStart by reading the current pack state with `editor_read_pack`, then write the Playwright JS flow with `editor_write_js`.',
  ].join('');

  const initialMessages: AgentMessage[] = [
    { role: 'user', content: userMessage },
  ];

  // Track flow changes for the result
  let stepsCreated = 0;
  let collectiblesCount = 0;
  let lastTestResult: EditorAgentResult['testResult'] | undefined;

  // Wrap onStreamEvent to tag with agent: 'editor'
  const taggedEmit = (event: Record<string, unknown>) => {
    onStreamEvent?.({ ...event, agent: 'editor' });
  };

  // Wrap the tool executor to track flow changes
  const trackingToolExecutor = async (name: string, args: Record<string, unknown>) => {
    // Only allow editor tools
    if (!name.startsWith('editor_')) {
      return {
        stringForLlm: JSON.stringify({ error: `Tool "${name}" is not available to the Editor Agent. Only editor_* tools are allowed.` }),
      };
    }

    const result = await toolExecutor(name, args);

    // Track flow writes
    if (name === 'editor_write_js') {
      stepsCreated = 1; // Playwright JS flow is a single unit
      if (Array.isArray(args.collectibles)) {
        collectiblesCount = (args.collectibles as unknown[]).length;
      }
    }
    // Legacy: track flow patches
    if (name === 'editor_apply_flow_patch') {
      const op = args.op as string;
      if (op === 'append' || op === 'insert') stepsCreated++;
      if (op === 'batch_append' && Array.isArray(args.steps)) {
        stepsCreated += (args.steps as unknown[]).length;
      }
      if (op === 'update_collectibles' && Array.isArray(args.collectibles)) {
        collectiblesCount = (args.collectibles as unknown[]).length;
      }
    }

    // Track test results
    if (name === 'editor_run_pack') {
      try {
        const parsed = JSON.parse(result.stringForLlm);
        if (parsed._truncated && typeof parsed.partialOutput === 'string') {
          // Truncated output — JSON.parse would fail on incomplete JSON.
          // Extract key fields via regex instead.
          const successMatch = parsed.partialOutput.match(/"success"\s*:\s*(true|false)/);
          const errorMatch = parsed.partialOutput.match(/"error"\s*:\s*"([^"]{0,200})"/);
          if (successMatch) {
            lastTestResult = {
              success: successMatch[1] === 'true',
              collectiblesPreview: '(truncated)',
              error: errorMatch?.[1],
            };
          }
        } else {
          // Non-truncated — parse normally
          lastTestResult = {
            success: !!parsed.success,
            collectiblesPreview: JSON.stringify(parsed.collectibles ?? {}).slice(0, 500),
            error: parsed.error,
          };
        }
      } catch {
        // ignore parse errors
      }
    }

    return result;
  };

  const loopResult = await runAgentLoop({
    systemPrompt: EDITOR_AGENT_SYSTEM_PROMPT,
    tools: EDITOR_AGENT_TOOLS,
    initialMessages,
    llmProvider,
    toolExecutor: trackingToolExecutor,
    maxIterations: MAX_EDITOR_ITERATIONS,
    onStreamEvent: taggedEmit,
    onToolResult: (toolName, args, resultParsed, success) => {
      // Notify UI of flow updates
      if ((toolName === 'editor_write_js' || toolName === 'editor_apply_flow_patch') && success && onFlowUpdated) {
        taggedEmit({ type: 'flow_patch_applied', tool: toolName });
      }
    },
    onToolError,
    abortSignal,
    sessionKey,
    enableStreaming: !!onStreamEvent,
  });

  // Build result — require a passing editor_run_pack call for success
  // Step creation without a passing test should NOT be considered success
  const hasPassingRun = loopResult.toolTrace.some(
    t => t.tool === 'editor_run_pack' && t.success
  );
  const success = hasPassingRun;

  return {
    success: success && !loopResult.aborted,
    summary: loopResult.finalContent || `Editor Agent completed. Steps created: ${stepsCreated}, Collectibles: ${collectiblesCount}.`,
    stepsCreated,
    collectiblesCount,
    testResult: lastTestResult,
    error: loopResult.aborted ? 'Aborted by user' : undefined,
    iterationsUsed: loopResult.iterationsUsed,
  };
}
