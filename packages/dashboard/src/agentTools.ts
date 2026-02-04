/**
 * Agent tools: MCP wrappers exposed to the LLM as function tools
 */

import type { ToolDef } from './llm/provider.js';
import type { TaskPackEditorWrapper } from './mcpWrappers.js';
import * as browserInspector from './browserInspector.js';
import { getSecretNamesWithValues } from './secretsUtils.js';
import { resolveTemplates, TaskPackLoader } from '@mcpify/core';
import { executePlanTool } from './contextManager.js';
import {
  updateConversation,
  type Conversation,
} from './db.js';

/** OpenAI-format tool definitions: Editor MCP + Browser MCP (always on) */
export const MCP_AGENT_TOOL_DEFINITIONS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'editor_list_packs',
      description: 'List all JSON Task Packs (id, name, version, description). Call when user asks about packs.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_read_pack',
      description: 'Read a pack: returns taskpack.json and flow.json. MUST call first when packId is provided before proposing any flow changes.',
      parameters: {
        type: 'object',
        properties: { packId: { type: 'string', description: 'Pack ID' } },
        required: ['packId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_list_secrets',
      description: 'List secrets for a pack. Returns secret names, descriptions, and whether values are set (no actual values for security). Use {{secret.NAME}} in templates to reference secret values.',
      parameters: {
        type: 'object',
        properties: { packId: { type: 'string', description: 'Pack ID' } },
        required: ['packId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_validate_flow',
      description: 'Validate flow JSON text (DSL steps and collectibles). Returns ok, errors, warnings.',
      parameters: {
        type: 'object',
        properties: { flowJsonText: { type: 'string', description: 'Flow JSON as string' } },
        required: ['flowJsonText'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_apply_flow_patch',
      description:
        'Apply ONE patch to flow.json. Pass flat params: packId, op, and for the op: index?, step?, collectibles?, inputs? at top level (no nested patch object). append: op + step. insert: op + index + step. replace: op + index + step. delete: op + index. update_collectibles: op + collectibles. update_inputs: op + inputs. Step = { id, type, params }. Templating: Nunjucks ({{inputs.x}}, {{vars.x}}; use {{ inputs.x | urlencode }} for URL/query values). Supported types: navigate, wait_for, click, fill, extract_text, extract_attribute, extract_title, sleep, assert, set_var, network_find (where, pick, saveAs; waitForMs), network_replay (requestId MUST be a template like {{vars.<saveAs>}} where <saveAs> is the variable from the preceding network_find step—never use a literal request ID; response.path uses JMESPath), network_extract (fromVar, as, path (JMESPath expression, e.g. "results[*].{id: id, name: name}"), out), select_option (target, value: string|{label}|{index}|array), press_key (key, target?, times?, delayMs?), upload_file (target, files: string|array), frame (frame: string|{name}|{url}, action: enter|exit), new_tab (url?, saveTabIndexAs?), switch_tab (tab: number|last|previous, closeCurrentTab?).',
      parameters: {
        type: 'object',
        properties: {
          packId: { type: 'string', description: 'Pack ID' },
          op: {
            type: 'string',
            enum: ['append', 'insert', 'replace', 'delete', 'update_collectibles', 'update_inputs'],
            description: 'append=add step at end; insert=add at index; replace=replace step at index; delete=remove at index; update_collectibles=replace collectibles array; update_inputs=add/update input fields',
          },
          index: { type: 'number', description: 'Required for insert, replace, delete. Step index (0-based).' },
          step: {
            type: 'object',
            description: 'Step object { id, type, params }. Required for append, insert, replace.',
          },
          collectibles: {
            type: 'array',
            description: 'Required for update_collectibles. Array of { name, type, description }.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          inputs: {
            type: 'object',
            description: 'Required for update_inputs. Object of { fieldName: { type, description?, required?, default? } }. Merges with existing inputs.',
            additionalProperties: {
              type: 'object',
              properties: {
                type: { type: 'string', description: 'Field type: string, number, boolean, etc.' },
                description: { type: 'string' },
                required: { type: 'boolean' },
                default: {},
              },
            },
          },
        },
        required: ['packId', 'op'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_create_pack',
      description:
        'Create a new JSON Task Pack. Call this FIRST when starting work on a new automation flow. Returns the created pack info including packId. After creating, use editor_apply_flow_patch to add steps to the flow. Also call conversation_link_pack to associate the pack with the current conversation.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Pack ID (e.g., "mycompany.sitename.collector"). Use reverse domain notation. Only alphanumeric, dots, underscores, hyphens.',
          },
          name: { type: 'string', description: 'Human-readable name (e.g., "Site Name Collector")' },
          description: { type: 'string', description: 'Brief description of what this pack does' },
        },
        required: ['id', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_run_pack',
      description:
        'Run a task pack with given inputs. Returns success (boolean), collectibles (extracted data), meta (url, durationMs, notes), error (if failed), plus runId, runDir, eventsPath, artifactsDir. Use success and collectibles to verify test results. Do not use for "run flow in the browser" or "execute steps in the open browser"—use browser_* tools (browser_goto, browser_click, browser_type, etc.) to execute steps in the current browser session instead.',
      parameters: {
        type: 'object',
        properties: {
          packId: { type: 'string' },
          inputs: { type: 'object', description: 'Input values object' },
        },
        required: ['packId', 'inputs'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_start_session',
      description: 'Start a headful browser session for inspection. Returns sessionId. Call when user wants to use browser or no session exists. Use engine="camoufox" for anti-detection Firefox browser (better for scraping sites that block bots).',
      parameters: {
        type: 'object',
        properties: {
          headful: { type: 'boolean', description: 'Default true' },
          engine: {
            type: 'string',
            enum: ['chromium', 'camoufox'],
            description: 'Browser engine: "chromium" (default) or "camoufox" (anti-detection Firefox)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_goto',
      description: 'Navigate browser to URL. Requires sessionId.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['sessionId', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_go_back',
      description: 'Navigate the browser back one step in history. Use when the user asks to go back.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input field. Use label for the accessible name of the field (e.g. "Search", "Email") or selector. Clears the field by default before typing.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          text: { type: 'string', description: 'Text to type' },
          label: { type: 'string', description: 'Accessible name/label of the input (e.g. "Search")' },
          selector: { type: 'string', description: 'CSS selector when label is not enough' },
          clear: { type: 'boolean', description: 'Clear field before typing (default true)' },
        },
        required: ['sessionId', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current page. Returns { imageBase64, mimeType, url, timestamp }. When you need page context (e.g. user asks "what page am I on?", "what buttons do you see?", "look at the page"), call this first; the image will be attached for you to analyze.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_links',
      description: 'Get all links on the current page (href, visible text, title). Use this to find which link to click instead of screenshot + vision; cheaper and accurate.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_dom_snapshot',
      description:
        'Get page accessibility snapshot in compact YAML format (default) or verbose JSON. YAML format shows hierarchical DOM structure with element refs [ref=eN] for targeting. Use maxDepth to limit tree depth for very large pages. ~70-80% smaller than JSON format. Prefer this over screenshot for understanding page structure.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Browser session ID' },
          format: {
            type: 'string',
            enum: ['yaml', 'json'],
            description: 'Output format: yaml (compact, default) or json (verbose legacy)',
          },
          maxDepth: {
            type: 'number',
            description: 'Max tree depth to return (default: unlimited). Only applies to yaml format.',
          },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element on the page. Use linkText for the visible text. Use role: "link" for links, "button" for buttons, "text" for other clickables (batch names, tabs, list items, divs/spans). If the item is not a link or button (e.g. "Winter 2026" in a filter), use role "text".',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          linkText: { type: 'string', description: 'Visible text of the element to click (e.g. "Sign in", "Winter 2026")' },
          role: { type: 'string', enum: ['link', 'button', 'text'], description: 'Use "link" (default) for <a>, "button" for buttons, "text" for divs/spans/list items (batch names, tabs)' },
          selector: { type: 'string', description: 'CSS selector if linkText is not sufficient' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network_list',
      description: 'List recent network requests. Returns compact format (id, method, url, status, responsePreview) by default. responsePreview shows first ~100 chars of response body. Use filter "all" to include static resources. Use browser_network_get for full headers or browser_network_get_response for full body.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'number', description: 'Max requests to return (default 50)' },
          filter: { type: 'string', enum: ['all', 'api', 'xhr'], description: 'Filter type (default "api" - likely API calls only)' },
          compact: { type: 'boolean', description: 'If true (default), return minimal fields. Set false to include request/response headers.' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network_search',
      description: 'Search network requests by query (case-insensitive). Matches URL, method, resourceType, status, request/response headers, postData, and response body. Use this to find requests by company name, text in the response, or URL. Returns matching entries (capped at 20). Prefer over network_list when the user asks for a specific request or content (e.g. "request that contains Martini").',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          query: { type: 'string', description: 'Substring to match in URL, headers, postData, or response body (case-insensitive)' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
        },
        required: ['sessionId', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network_get',
      description: 'Get one network request by id (metadata only; no response body). Use when the user provides a request ID (e.g. from the Network list). Call browser_network_get_response when you need the response body. replayPossible indicates replay with browser context is possible.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          requestId: { type: 'string', description: 'Request ID the user selected (e.g. req-1-123)' },
        },
        required: ['sessionId', 'requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network_get_response',
      description: 'Get the response body for a request. Returns first 200 characters by default; set full=true to return the full captured snippet (up to 2000 chars).',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          requestId: { type: 'string', description: 'Request ID from network list or network_get' },
          full: { type: 'boolean', description: 'If true, return full captured snippet (up to 2000 chars); default false returns first 200 chars' },
        },
        required: ['sessionId', 'requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network_replay',
      description: 'Replay a captured request using the browser context (cookies apply). Overrides: url, setQuery, setHeaders, body (Nunjucks: {{inputs.x}}, {{vars.x}}; use {{ inputs.x | urlencode }} for URL/query values). Optional urlReplace/bodyReplace: { find, replace }; replace can use $1, $2 and Nunjucks (e.g. {{inputs.page | urlencode }}). Returns status, contentType, and bounded response body.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          requestId: { type: 'string', description: 'Request ID from network list or network_get' },
          overrides: {
            type: 'object',
            description: 'Optional overrides (url, setQuery, setHeaders, body; or urlReplace/bodyReplace { find, replace })',
            properties: {
              url: { type: 'string' },
              setQuery: { type: 'object', description: 'Query params to set (merge/replace)' },
              setHeaders: { type: 'object', description: 'Non-sensitive headers only' },
              body: { type: 'string' },
              urlReplace: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, description: 'Regex find/replace on captured URL' },
              bodyReplace: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, description: 'Regex find/replace on captured body' },
            },
          },
        },
        required: ['sessionId', 'requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network_clear',
      description: 'Clear the session network buffer.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_last_actions',
      description: 'Get recent actions performed in the browser session.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'number', description: 'Default 10' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close_session',
      description: 'Close the browser session and free resources.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  // Context management tools
  {
    type: 'function',
    function: {
      name: 'agent_save_plan',
      description: 'Save your current plan/strategy. Use this whenever you formulate a multi-step plan. The plan survives conversation summarization, so include: (1) the user\'s goal, (2) your planned steps, (3) current progress, (4) key decisions made. Call this proactively when working on complex tasks.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description: 'The plan text. Include goal, steps, progress, and decisions.',
          },
        },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agent_get_plan',
      description: 'Retrieve your saved plan. Use this if you need to recall your strategy or after the conversation was summarized.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  // Conversation management tools
  {
    type: 'function',
    function: {
      name: 'conversation_update_title',
      description: 'Update the conversation title based on the user\'s goal. Call after the first user message to set a concise title (e.g., "Gmail Email Scraper", "YC Batch Collector").',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'A concise title (3-6 words) describing the user\'s goal.',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'conversation_update_description',
      description: 'Update the conversation description/summary. Call when progress is made to reflect current status (e.g., "Creating login flow", "Ready to collect emails").',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A brief description of current progress or status.',
          },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'conversation_set_status',
      description: 'Set the conversation status. Use "ready" when the flow is complete and working, "needs_input" when waiting for user decision, "error" on failure. Status defaults to "active" during work.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'ready', 'needs_input', 'error'],
            description: 'The conversation status.',
          },
        },
        required: ['status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'conversation_link_pack',
      description: 'Link the conversation to a created/edited pack. Call when you create or complete editing a pack to associate it with this conversation.',
      parameters: {
        type: 'object',
        properties: {
          packId: {
            type: 'string',
            description: 'The pack ID to link to this conversation.',
          },
        },
        required: ['packId'],
      },
    },
  },
];

export interface AgentToolContext {
  taskPackEditor: TaskPackEditorWrapper;
  /** Current browser session ID (optional; agent may start one via start_session) */
  browserSessionId?: string | null;
  /** Current pack ID for template resolution (optional; needed for {{secret.X}} resolution) */
  packId?: string | null;
  /** Session key for plan storage (typically packId or a unique session identifier) */
  sessionKey?: string;
  /** Current conversation ID (optional; needed for conversation_* tools) */
  conversationId?: string | null;
}

/**
 * Resolve templates in a string value using pack secrets.
 * Falls back to returning the original value if resolution fails.
 */
async function resolveTemplateValue(
  value: string,
  ctx: AgentToolContext
): Promise<string> {
  if (!value || typeof value !== 'string') return value;
  // Only attempt resolution if the value contains template syntax
  if (!value.includes('{{')) return value;

  // Get pack path and load secrets if packId is available
  let secrets: Record<string, string> = {};
  if (ctx.packId) {
    try {
      const packs = await ctx.taskPackEditor.listPacks();
      const pack = packs.find((p: { id: string; path?: string }) => p.id === ctx.packId);
      if (pack?.path) {
        secrets = TaskPackLoader.loadSecrets(pack.path);
      }
    } catch (e) {
      console.warn('[agentTools] Failed to load secrets for template resolution:', e);
    }
  }

  try {
    // Resolve templates using the core templating function
    const resolved = resolveTemplates(value, {
      inputs: {},
      vars: {},
      secrets,
    });
    return resolved as string;
  } catch (e) {
    console.warn('[agentTools] Template resolution failed, using original value:', e);
    return value;
  }
}

/** Strip editor_, browser_, agent_, or conversation_ prefix for internal dispatch (OpenAI allows only [a-zA-Z0-9_-] in tool names) */
function toolNameToInternal(name: string): string {
  if (name.startsWith('editor_')) return name.slice(7);
  if (name.startsWith('browser_')) return name.slice(8);
  if (name.startsWith('agent_')) return name.slice(6);
  if (name.startsWith('conversation_')) return name.slice(13);
  return name;
}

/** Max characters for tool outputs before truncation */
const MAX_TOOL_OUTPUT_CHARS = 8000;

/**
 * Truncate large tool output to prevent context bloat.
 * Returns original if under limit, otherwise returns truncated with metadata.
 */
function truncateToolOutput(output: string, label?: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) {
    return output;
  }

  const truncated = output.slice(0, MAX_TOOL_OUTPUT_CHARS);
  const result = {
    _truncated: true,
    _totalChars: output.length,
    _shownChars: MAX_TOOL_OUTPUT_CHARS,
    _message: `Output truncated from ${output.length.toLocaleString()} to ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} characters.${label ? ` (${label})` : ''} The operation completed successfully.`,
    partialOutput: truncated + '\n... (truncated)',
  };
  return JSON.stringify(result, null, 2);
}

/** Result of executing a tool: string for LLM, optional browser snapshot for HTTP response */
export interface ExecuteToolResult {
  stringForLlm: string;
  browserSnapshot?: { screenshotBase64: string; mimeType: string; url: string };
}

/**
 * Execute one agent tool by name (editor.* or browser.*) with parsed arguments.
 * Returns string for LLM and optional browser snapshot for response.
 */
export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext
): Promise<ExecuteToolResult> {
  const { taskPackEditor } = ctx;
  const internal = toolNameToInternal(name);

  const wrap = (
    s: string,
    snapshot?: { screenshotBase64: string; mimeType: string; url: string }
  ): ExecuteToolResult => (snapshot ? { stringForLlm: s, browserSnapshot: snapshot } : { stringForLlm: s });

  try {
    switch (internal) {
      case 'list_packs': {
        const result = await taskPackEditor.listPacks();
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'read_pack': {
        const packId = args.packId as string;
        if (!packId) throw new Error('packId required');
        const result = await taskPackEditor.readPack(packId);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'list_secrets': {
        const packId = args.packId as string;
        if (!packId) throw new Error('packId required');
        // Get pack path from editor
        const packInfo = await taskPackEditor.readPack(packId);
        // Extract path from taskpackJson - we need to get it from the wrapper
        // For now, use a workaround: list packs and find path
        const packs = await taskPackEditor.listPacks();
        const pack = packs.find((p: { id: string }) => p.id === packId);
        if (!pack || !pack.path) {
          throw new Error(`Pack ${packId} not found or path not available`);
        }
        const secrets = getSecretNamesWithValues(pack.path);
        return wrap(JSON.stringify({ secrets, note: 'Use {{secret.NAME}} in templates to reference secret values. Never ask for secret values - they are managed through the UI.' }, null, 2));
      }
      case 'validate_flow': {
        const flowJsonText = args.flowJsonText as string;
        if (typeof flowJsonText !== 'string') throw new Error('flowJsonText required');
        const result = await taskPackEditor.validateFlow(flowJsonText);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'apply_flow_patch': {
        const packId = args.packId as string;
        if (!packId) throw new Error('packId required');
        // Accept flat params (packId, op, index?, step?, collectibles?, inputs?) or legacy nested patch
        const legacyPatch = args.patch as Record<string, unknown> | undefined;
        const patch: Record<string, unknown> = legacyPatch
          ? { ...legacyPatch }
          : {
              op: args.op,
              ...(args.index !== undefined && { index: args.index }),
              ...(args.step !== undefined && { step: args.step }),
              ...(args.collectibles !== undefined && { collectibles: args.collectibles }),
              ...(args.inputs !== undefined && { inputs: args.inputs }),
            };
        if (!patch.op) throw new Error('op required (append, insert, replace, delete, update_collectibles, or update_inputs)');
        const result = await taskPackEditor.applyFlowPatch(packId, patch as any);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'create_pack': {
        const id = args.id as string;
        const name = args.name as string;
        const description = args.description as string | undefined;
        if (!id) throw new Error('id required');
        if (!name) throw new Error('name required');
        const result = await taskPackEditor.createPack(id, name, description);
        return wrap(JSON.stringify({
          ...result,
          message: `Pack "${id}" created successfully. Use editor_apply_flow_patch to add steps, and conversation_link_pack to associate it with this conversation.`,
        }, null, 2));
      }
      case 'run_pack': {
        const packId = args.packId as string;
        const inputs = (args.inputs as Record<string, unknown>) || {};
        if (!packId) throw new Error('packId required');
        const result = await taskPackEditor.runPack(packId, inputs);
        const fullJson = JSON.stringify(result, null, 2);
        return wrap(truncateToolOutput(fullJson, 'run_pack result'));
      }
      case 'start_session': {
        const headful = args.headful !== false;
        const engine = (args.engine as 'chromium' | 'camoufox') || 'chromium';
        const sessionId = await browserInspector.startBrowserSession(headful, engine);
        return wrap(JSON.stringify({ sessionId, engine }, null, 2));
      }
      case 'close_session': {
        const sessionId = args.sessionId as string;
        if (!sessionId) throw new Error('sessionId required');
        await browserInspector.closeSession(sessionId);
        return wrap(JSON.stringify({ success: true }, null, 2));
      }
      case 'goto': {
        const sessionId = args.sessionId as string;
        const url = args.url as string;
        if (!sessionId || !url) throw new Error('sessionId and url required');
        // Resolve templates in URL (e.g., {{secret.BASE_URL}})
        const resolvedUrl = await resolveTemplateValue(url, ctx);
        const currentUrl = await browserInspector.gotoUrl(sessionId, resolvedUrl);
        return wrap(JSON.stringify({ url: currentUrl }, null, 2));
      }
      case 'go_back': {
        const sessionId = args.sessionId as string;
        if (!sessionId) throw new Error('sessionId required');
        const result = await browserInspector.goBack(sessionId);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'type': {
        const sessionId = args.sessionId as string;
        const text = args.text as string;
        if (!sessionId || text === undefined) throw new Error('sessionId and text required');
        const label = args.label as string | undefined;
        const selector = args.selector as string | undefined;
        if (!label && !selector) throw new Error('label or selector required');
        // Resolve templates in text (e.g., {{secret.USERNAME}}, {{secret.PASSWORD}})
        const resolvedText = await resolveTemplateValue(text, ctx);
        const result = await browserInspector.typeInElement(sessionId, {
          text: resolvedText,
          label,
          selector,
          clear: args.clear !== false,
        });
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'click': {
        const sessionId = args.sessionId as string;
        if (!sessionId) throw new Error('sessionId required');
        const linkText = args.linkText as string | undefined;
        const selector = args.selector as string | undefined;
        const role = (args.role as 'link' | 'button' | 'text') || 'link';
        if (!linkText && !selector) throw new Error('linkText or selector required');
        const result = await browserInspector.clickElement(sessionId, { linkText, selector, role });
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'screenshot': {
        const sessionId = args.sessionId as string;
        if (!sessionId) throw new Error('sessionId required');
        const result = await browserInspector.takeScreenshot(sessionId);
        return wrap(
          JSON.stringify(
            {
              url: result.url,
              timestamp: result.timestamp,
              mimeType: result.mimeType,
              imageAttached: true,
              note: 'Screenshot captured. Image is attached in the next message for analysis.',
            },
            null,
            2
          ),
          { screenshotBase64: result.imageBase64, mimeType: result.mimeType, url: result.url }
        );
      }
      case 'get_links': {
        const sessionId = args.sessionId as string;
        if (!sessionId) throw new Error('sessionId required');
        const result = await browserInspector.getLinks(sessionId);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'get_dom_snapshot': {
        const sessionId = args.sessionId as string;
        if (!sessionId) throw new Error('sessionId required');
        const format = (args.format as 'yaml' | 'json') ?? 'yaml';
        const maxDepth = args.maxDepth as number | undefined;
        const result = await browserInspector.getDomSnapshot(sessionId, { format, maxDepth });
        // For YAML format, return the snapshot string directly for compactness
        if (format === 'yaml' && 'snapshot' in result) {
          const output = `URL: ${result.url}\nTitle: ${result.title}\n\n${result.snapshot}`;
          return wrap(truncateToolOutput(output, 'DOM snapshot'));
        }
        return wrap(truncateToolOutput(JSON.stringify(result, null, 2), 'DOM snapshot'));
      }
      case 'network_list': {
        const sessionId = args.sessionId as string;
        if (!sessionId) throw new Error('sessionId required');
        const limit = (args.limit as number) ?? 50;
        const filter = (args.filter as 'all' | 'api' | 'xhr') ?? 'api';
        const compact = args.compact !== false; // default true
        const list = browserInspector.networkList(sessionId, { limit, filter, compact });
        return wrap(JSON.stringify(list, null, 2));
      }
      case 'network_search': {
        const sessionId = args.sessionId as string;
        const query = args.query as string;
        if (!sessionId || query == null) throw new Error('sessionId and query required');
        const limit = (args.limit as number) ?? 20;
        const list = browserInspector.networkSearch(sessionId, query, limit);
        return wrap(JSON.stringify(list, null, 2));
      }
      case 'network_get': {
        const sessionId = args.sessionId as string;
        const requestId = args.requestId as string;
        if (!sessionId || !requestId) throw new Error('sessionId and requestId required');
        const result = browserInspector.networkGet(sessionId, requestId);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'network_get_response': {
        const sessionId = args.sessionId as string;
        const requestId = args.requestId as string;
        if (!sessionId || !requestId) throw new Error('sessionId and requestId required');
        const full = args.full === true;
        const result = browserInspector.networkGetResponse(sessionId, requestId, full);
        return wrap(truncateToolOutput(JSON.stringify(result, null, 2), 'network response'));
      }
      case 'network_replay': {
        const sessionId = args.sessionId as string;
        const requestId = args.requestId as string;
        if (!sessionId || !requestId) throw new Error('sessionId and requestId required');
        const overrides = args.overrides as Record<string, unknown> | undefined;
        const result = await browserInspector.networkReplay(sessionId, requestId, overrides as Parameters<typeof browserInspector.networkReplay>[2]);
        return wrap(truncateToolOutput(JSON.stringify(result, null, 2), 'network replay'));
      }
      case 'network_clear': {
        const sessionId = args.sessionId as string;
        if (!sessionId) throw new Error('sessionId required');
        browserInspector.networkClear(sessionId);
        return wrap(JSON.stringify({ success: true }, null, 2));
      }
      case 'last_actions': {
        const sessionId = args.sessionId as string;
        const limit = (args.limit as number) || 10;
        if (!sessionId) throw new Error('sessionId required');
        const actions = browserInspector.getLastActions(sessionId, limit);
        return wrap(JSON.stringify(actions, null, 2));
      }
      // Context management tools (agent_ prefix)
      case 'save_plan':
      case 'get_plan': {
        const sessionKey = ctx.sessionKey || ctx.packId || 'default';
        const result = executePlanTool(`agent_${internal}`, args, sessionKey);
        return wrap(result);
      }
      // Conversation management tools (conversation_ prefix -> update_title, etc.)
      case 'update_title': {
        const title = args.title as string;
        if (!title) throw new Error('title required');
        if (!ctx.conversationId) {
          return wrap(JSON.stringify({ warning: 'No conversation context, title not saved but noted' }));
        }
        const updated = updateConversation(ctx.conversationId, { title });
        if (!updated) throw new Error('Conversation not found');
        return wrap(JSON.stringify({ success: true, title }));
      }
      case 'update_description': {
        const description = args.description as string;
        if (!description) throw new Error('description required');
        if (!ctx.conversationId) {
          return wrap(JSON.stringify({ warning: 'No conversation context, description not saved but noted' }));
        }
        const updated = updateConversation(ctx.conversationId, { description });
        if (!updated) throw new Error('Conversation not found');
        return wrap(JSON.stringify({ success: true, description }));
      }
      case 'set_status': {
        const status = args.status as Conversation['status'];
        if (!status || !['active', 'ready', 'needs_input', 'error'].includes(status)) {
          throw new Error('status must be active, ready, needs_input, or error');
        }
        if (!ctx.conversationId) {
          return wrap(JSON.stringify({ warning: 'No conversation context, status not saved but noted' }));
        }
        const updated = updateConversation(ctx.conversationId, { status });
        if (!updated) throw new Error('Conversation not found');
        return wrap(JSON.stringify({ success: true, status }));
      }
      case 'link_pack': {
        const packId = args.packId as string;
        if (!packId) throw new Error('packId required');
        if (!ctx.conversationId) {
          return wrap(JSON.stringify({ warning: 'No conversation context, pack link not saved but noted' }));
        }
        const updated = updateConversation(ctx.conversationId, { packId });
        if (!updated) throw new Error('Conversation not found');
        return wrap(JSON.stringify({ success: true, packId }));
      }
      default:
        return wrap(JSON.stringify({ error: `Unknown tool: ${name}` }));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrap(JSON.stringify({ error: message }));
  }
}
