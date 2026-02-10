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

const EDITOR_AGENT_SYSTEM_PROMPT = `# Editor Agent — DSL Flow Builder

You are a specialized agent that builds ShowRun DSL flows from exploration findings. You have access ONLY to editor tools — you cannot browse the web or interact with pages.

## Your Role

You receive:
1. **Exploration context**: API endpoints, DOM structure, auth info, pagination details discovered by the Exploration Agent
2. **Implementation instructions**: The approved roadmap describing what to build
3. **Test inputs**: Values to use when testing the flow

Your job is to:
1. Read the current pack state with \`editor_read_pack\`
2. Build the flow step-by-step using \`editor_apply_flow_patch\`
3. Define inputs and collectibles as needed
4. Test the flow with \`editor_run_pack\`
5. If test fails, diagnose and fix the issue, then re-test

## API-First Rule

When the exploration context mentions API endpoints, you MUST use network steps:
- \`network_find\` → \`network_replay\` → \`network_extract\`

NEVER use DOM extraction (\`extract_text\`, \`extract_attribute\`) for data available via API.
Only use DOM steps when the exploration context explicitly says "no API found" or "DOM-only".

## DSL Step Types Reference

| Step Type | Purpose | Key Params |
|-----------|---------|------------|
| \`navigate\` | Go to URL | \`url\`, \`waitUntil\` |
| \`wait_for\` | Wait for element/state | \`target\`, \`url\`, \`loadState\`, \`timeoutMs\` |
| \`click\` | Click element | \`target\`, \`first\`, \`scope\`, \`near\` |
| \`fill\` | Type into input | \`target\`, \`value\`, \`clear\` |
| \`extract_title\` | Extract page title | \`out\` |
| \`extract_text\` | Extract text from element(s) | \`target\`, \`out\`, \`first\`, \`trim\` |
| \`extract_attribute\` | Extract attribute value(s) | \`target\`, \`attribute\`, \`out\`, \`first\` |
| \`select_option\` | Select dropdown option | \`target\`, \`value\`, \`first\` |
| \`press_key\` | Press keyboard key | \`key\`, \`target\`, \`times\`, \`delayMs\` |
| \`assert\` | Validate element/URL state | \`target\`, \`visible\`, \`textIncludes\`, \`urlIncludes\` |
| \`set_var\` | Set template variable | \`name\`, \`value\` |
| \`sleep\` | Wait fixed duration | \`durationMs\` |
| \`upload_file\` | Upload file(s) to input | \`target\`, \`files\` |
| \`frame\` | Switch iframe context | \`frame\`, \`action\` (\`enter\`/\`exit\`) |
| \`new_tab\` | Open new browser tab | \`url\`, \`saveTabIndexAs\` |
| \`switch_tab\` | Switch to different tab | \`tab\`, \`closeCurrentTab\` |
| \`network_find\` | Find captured request | \`where\`, \`pick\`, \`saveAs\`, \`waitForMs\` |
| \`network_replay\` | Replay request with overrides | \`requestId\`, \`overrides\`, \`auth\`, \`out\`, \`saveAs\`, \`response\` |
| \`network_extract\` | Extract from response | \`fromVar\`, \`as\`, \`path\`, \`out\` |

### network_find \`where\` fields (ONLY these are valid):
- \`urlIncludes\` (string) — URL must contain this substring. Do NOT use \`url\` — it is not a valid field.
- \`urlRegex\` (string) — URL must match this regex
- \`method\` (\`GET\`/\`POST\`/\`PUT\`/\`DELETE\`/\`PATCH\`)
- \`status\` (number) — HTTP status code
- \`contentTypeIncludes\` (string) — Content-Type must contain this
- \`responseContains\` (string) — Response body must contain this

Unknown fields in \`where\` are silently ignored, meaning the filter matches everything. Always use \`urlIncludes\` for URL matching.

## Implementation Rules

1. **One step per patch** — apply steps incrementally with \`editor_apply_flow_patch\`
2. **Read first** — always call \`editor_read_pack\` before making changes
3. **API-first** — use network steps when API endpoints were found during exploration
4. **Human-stable targets** — prefer role/label/text over CSS selectors
5. **Templating** — use Nunjucks: \`{{inputs.x}}\`, \`{{vars.x}}\`, \`{{ value | urlencode }}\`
6. **Don't use literal request IDs** — always use \`{{vars.saveAs}}\` templates
7. **Don't hardcode credentials** — use \`{{secret.NAME}}\` references

## Storage: vars vs collectibles

| Step | Parameter | Stores To |
|------|-----------|-----------|
| \`set_var\` | \`name\` | **vars** (internal, not returned) |
| \`network_find\` | \`saveAs\` | **vars** (internal, not returned) |
| \`network_replay\` | \`saveAs\` | **vars** (raw response object) |
| \`network_replay\` | \`out\` | **collectibles** (extracted/processed value) |
| \`extract_text\` | \`out\` | **collectibles** |
| \`extract_attribute\` | \`out\` | **collectibles** |
| \`network_extract\` | \`out\` | **collectibles** |

**CRITICAL: Only collectibles whose \`out\` name matches a declared entry in the \`collectibles\` array are returned in the output.** If \`out\` writes to \`"companyData"\` but only \`"companies"\` is declared, the output will be empty. Always ensure \`out\` names match declared collectible names exactly.

## Network Step Pattern

\`\`\`json
// 1. Find the API request (ONLY use urlIncludes, urlRegex, method, status — NOT "url")
{ "id": "find_api", "type": "network_find", "params": { "where": { "urlIncludes": "/api/data", "method": "GET" }, "pick": "last", "saveAs": "reqId", "waitForMs": 5000 } }

// 2. Replay and save raw response to vars, extracted data to collectibles
{ "id": "replay_api", "type": "network_replay", "params": { "requestId": "{{vars.reqId}}", "overrides": { ... }, "auth": "browser_context", "saveAs": "rawResp", "out": "items", "response": { "as": "json", "path": "data[*].name" } } }

// 3. Or: extract from a var/collectible (use "path" with JMESPath, NOT "jsonPath" with "$.")
{ "id": "extract_data", "type": "network_extract", "params": { "fromVar": "rawResp", "as": "json", "path": "data[*].{name: name, id: id}", "out": "items" } }
\`\`\`

**IMPORTANT:** The "out" name ("items" above) MUST match a declared collectible name. If you declare \`"collectibles": [{"name": "items", ...}]\`, then \`"out": "items"\` works. \`"out": "itemData"\` would produce empty output.

## Conditional Steps (skip_if)

Steps can be conditionally skipped using \`skip_if\`:
- \`url_includes\`, \`url_matches\`, \`element_visible\`, \`element_exists\`
- \`var_equals\`, \`var_truthy\`, \`var_falsy\`
- \`all\` (AND), \`any\` (OR) for compound conditions

## Testing

After building the flow:
1. Call \`editor_run_pack\` with the provided test inputs
2. Check \`success === true\` and \`collectibles\` contain expected data
3. If test fails: read the error, adjust steps, re-test
4. You have up to 30 iterations total — use them wisely

## Error Recovery

If \`editor_run_pack\` fails:
1. Read the error message carefully
2. Check if it's a selector issue, timing issue, or logic error
3. Use \`editor_read_pack\` to see current flow state
4. Apply targeted fixes with \`editor_apply_flow_patch\` (replace specific steps)
5. Re-test with \`editor_run_pack\`

## Output

When done, include a summary in your final message with:
- What steps were created
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
    '\n\nStart by reading the current pack state with `editor_read_pack`, then build the flow step by step.',
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

    // Track flow patches
    if (name === 'editor_apply_flow_patch') {
      const op = args.op as string;
      if (op === 'append' || op === 'insert') stepsCreated++;
      if (op === 'update_collectibles' && Array.isArray(args.collectibles)) {
        collectiblesCount = (args.collectibles as unknown[]).length;
      }
    }

    // Track test results
    if (name === 'editor_run_pack') {
      try {
        const parsed = JSON.parse(result.stringForLlm);
        // Handle both truncated and non-truncated output
        const actual = parsed._truncated ? JSON.parse(parsed.partialOutput) : parsed;
        lastTestResult = {
          success: !!actual.success,
          collectiblesPreview: JSON.stringify(actual.collectibles ?? {}).slice(0, 500),
          error: actual.error,
        };
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
      if (toolName === 'editor_apply_flow_patch' && success && onFlowUpdated) {
        // The teach.ts handler will read the pack and emit flow_updated
        // We just need to signal that a patch was applied
        taggedEmit({ type: 'flow_patch_applied', tool: toolName });
      }
    },
    onToolError,
    abortSignal,
    sessionKey,
    enableStreaming: !!onStreamEvent,
  });

  // Build result
  const success = loopResult.toolTrace.some(t => t.tool === 'editor_run_pack' && t.success) || stepsCreated > 0;

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
