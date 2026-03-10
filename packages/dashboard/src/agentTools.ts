/**
 * Agent tools: MCP wrappers exposed to the LLM as function tools
 */

import type { ToolDef } from './llm/provider.js';
import type { TaskPackEditorWrapper } from './mcpWrappers.js';
import * as browserInspector from './browserInspector.js';
import { isSessionAlive, startBrowserSession, closeSession, getSessionPage } from './browserInspector.js';
import { getSecretNamesWithValues } from './secretsUtils.js';
import { resolveTemplates, TaskPackLoader, saveVersion, resolveProxy } from '@showrun/core';
import type { ProxyConfig } from '@showrun/core';
import { executePlanTool } from './contextManager.js';
import {
  updateConversation,
  type Conversation,
} from './db.js';
import { join } from 'path';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

/**
 * Redact common sensitive patterns (tokens, passwords, credentials) from error messages.
 */
function redactSensitive(msg: string): string {
  return msg
    .replace(/(?:Bearer|Basic)\s+\S+/gi, (m) => m.split(/\s+/)[0] + ' [REDACTED]')
    .replace(/(api[_-]?key|token|password|secret|authorization)[=:]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/(?<=:\/\/)[^:]+:[^@]+(?=@)/g, '[REDACTED]:[REDACTED]');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Browser Session Management (per-conversation, in-memory)
// ═══════════════════════════════════════════════════════════════════════════════

/** Map of conversationId -> browserSessionId (in-memory, not persisted) */
const conversationBrowserSessions = new Map<string, string>();

/** Get the browser session for a conversation, if any */
export function getConversationBrowserSession(conversationId: string): string | null {
  return conversationBrowserSessions.get(conversationId) ?? null;
}

/** Set the browser session for a conversation */
export function setConversationBrowserSession(conversationId: string, sessionId: string | null): void {
  if (sessionId) {
    conversationBrowserSessions.set(conversationId, sessionId);
  } else {
    conversationBrowserSessions.delete(conversationId);
  }
}

/** OpenAI-format tool definitions: Editor MCP + Browser MCP (always on) */
export const MCP_AGENT_TOOL_DEFINITIONS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'editor_read_pack',
      description: 'Read the linked pack: returns taskpack.json and flow.json. MUST call first before proposing any flow changes.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_list_secrets',
      description: 'List secrets for the linked pack. Returns secret names, descriptions, and whether values are set (no actual values for security). Use {{secret.NAME}} in templates to reference secret values.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
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
        'Apply ONE patch to the linked pack\'s flow.json. Pass flat params: op, and for the op: index?, step?, steps?, collectibles?, inputs? at top level (no nested patch object). append: op + step. batch_append: op + steps (array) — preferred for adding multiple steps at once. insert: op + index + step. replace: op + index + step. delete: op + index. update_collectibles: op + collectibles. update_inputs: op + inputs. Step = { id, type, params }. Templating: Nunjucks ({{inputs.x}}, {{vars.x}}; use {{ inputs.x | urlencode }} for URL/query values). Supported types: navigate, wait_for, click, fill, extract_text, extract_attribute, extract_title, sleep, assert, set_var, network_find (where, pick, saveAs; waitForMs), network_replay (requestId MUST be a template like {{vars.<saveAs>}} where <saveAs> is the variable from the preceding network_find step—never use a literal request ID; response.path uses JMESPath), network_extract (fromVar, as, path (JMESPath expression, e.g. "results[*].{id: id, name: name}"), out), select_option (target, value: string|{label}|{index}|array), press_key (key, target?, times?, delayMs?), upload_file (target, files: string|array), frame (frame: string|{name}|{url}, action: enter|exit), new_tab (url?, saveTabIndexAs?), switch_tab (tab: number|last|previous, closeCurrentTab?), dom_scrape (target for repeating elements, collect: [{key, target, extract?: text|attribute|html, attribute?}], skip_empty?, out).',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['append', 'batch_append', 'insert', 'replace', 'delete', 'update_collectibles', 'update_inputs'],
            description: 'append=add step at end; batch_append=add multiple steps at once (preferred); insert=add at index; replace=replace step at index; delete=remove at index; update_collectibles=replace collectibles array; update_inputs=add/update input fields',
          },
          index: { type: 'number', description: 'Required for insert, replace, delete. Step index (0-based).' },
          step: {
            type: 'object',
            description: 'Step object { id, type, params }. Required for append, insert, replace.',
          },
          steps: {
            type: 'array',
            description: 'Array of step objects { id, type, params }. Required for batch_append. Use this to add multiple steps in a single call.',
            items: { type: 'object' },
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
        required: ['op'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_write_js',
      description:
        'Write the full flow.playwright.js source code. Auto-converts json-dsl packs to playwright-js kind on first call. ' +
        'Pass the complete source (module.exports = async function({ page, context, frame, inputs, secrets, showrun }) { ... }), ' +
        'plus optional inputs schema and collectibles definitions for taskpack.json.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Full JavaScript source code for flow.playwright.js',
          },
          inputs: {
            type: 'object',
            description: 'Optional input schema for taskpack.json. Object of { fieldName: { type, description?, required?, default? } }.',
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
          collectibles: {
            type: 'array',
            description: 'Optional collectible definitions for taskpack.json. Array of { name, type, description }.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editor_create_pack',
      description:
        'Create a new Task Pack. Call this FIRST when starting work on a new automation flow. Returns the created pack info including packId. After creating, use editor_write_js to write the flow. Also call conversation_link_pack to associate the pack with the current conversation.',
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
        'Run the linked pack with given inputs. Returns success (boolean), collectibles (extracted data), meta (url, durationMs, notes), error (if failed), plus runId, runDir, eventsPath, artifactsDir. Use success and collectibles to verify test results. Do not use for "run flow in the browser" or "execute steps in the open browser"—use browser_* tools (browser_goto, browser_click, browser_type, etc.) to execute steps in the current browser session instead.',
      parameters: {
        type: 'object',
        properties: {
          inputs: { type: 'object', description: 'Input values object' },
        },
        required: ['inputs'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_goto',
      description: 'Navigate browser to URL. Browser session is managed automatically. IMPORTANT: After navigating, always call browser_network_list to check for API endpoints before using DOM tools.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
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
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input field. Use label for the accessible name of the field (e.g. "Search", "Email") or selector. Clears the field by default before typing. Automatically searches iframes if the element is not found on the main page. Supports secret templates: use {{secret.NAME}} for passwords and {{secret.NAME | totp}} to generate a 6-digit TOTP code from a stored TOTP secret key. IMPORTANT for TOTP: always use submit=true when typing time-sensitive codes so Enter is pressed immediately after typing (no round-trip delay).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          label: { type: 'string', description: 'Accessible name/label of the input (e.g. "Search")' },
          selector: { type: 'string', description: 'CSS selector when label is not enough' },
          clear: { type: 'boolean', description: 'Clear field before typing (default true)' },
          submit: { type: 'boolean', description: 'Press Enter immediately after typing (default false). Use true for time-sensitive codes like TOTP to avoid round-trip delay.' },
        },
        required: ['text'],
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
        properties: {},
        required: [],
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
        properties: {},
        required: [],
      },
    },
  },
  // ── Network / API tools (call these BEFORE DOM tools after every navigation) ──
  {
    type: 'function',
    function: {
      name: 'browser_network_list',
      description: 'IMPORTANT: Call this after EVERY browser_goto or page navigation to check for API endpoints. List recent network requests. Returns compact format (id, method, url, status, responsePreview) by default. responsePreview shows first ~100 chars of response body. If APIs exist that return the data you need, ALWAYS prefer using them via browser_network_replay instead of extracting from DOM. Use filter "all" to include static resources. Use browser_network_get for full headers or browser_network_get_response for full body.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max requests to return (default 50)' },
          filter: { type: 'string', enum: ['all', 'api', 'xhr'], description: 'Filter type (default "api" - likely API calls only)' },
          compact: { type: 'boolean', description: 'If true (default), return minimal fields. Set false to include request/response headers.' },
        },
        required: [],
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
          query: { type: 'string', description: 'Substring to match in URL, headers, postData, or response body (case-insensitive)' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
        },
        required: ['query'],
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
          requestId: { type: 'string', description: 'Request ID the user selected (e.g. req-1-123)' },
        },
        required: ['requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network_get_response',
      description: 'Get the response body for a request. Returns first 200 characters by default; set full=true to return the full captured snippet (up to 8000 chars). Use this to inspect API responses before deciding whether to extract data via API replay or DOM.',
      parameters: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: 'Request ID from network list or network_get' },
          full: { type: 'boolean', description: 'If true, return full captured snippet (up to 2000 chars); default false returns first 200 chars' },
        },
        required: ['requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network_replay',
      description: 'Replay a captured request using the browser context (cookies apply). This is the PREFERRED way to extract data when an API endpoint exists — replay the API call and use the structured response instead of parsing DOM. Overrides: url, setQuery, setHeaders, body (Nunjucks: {{inputs.x}}, {{vars.x}}; use {{ inputs.x | urlencode }} for URL/query values). Optional urlReplace/bodyReplace: { find, replace }; replace can use $1, $2 and Nunjucks (e.g. {{inputs.page | urlencode }}). Returns status, contentType, and bounded response body.',
      parameters: {
        type: 'object',
        properties: {
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
        required: ['requestId'],
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
        properties: {},
        required: [],
      },
    },
  },
  // ── DOM / Page structure tools (check network traffic FIRST before using these) ──
  {
    type: 'function',
    function: {
      name: 'browser_get_dom_snapshot',
      description:
        'Get page accessibility snapshot in compact YAML format (default) or verbose JSON. IMPORTANT: Before using this tool, ALWAYS call browser_network_list first to check if the data you need is available via an API endpoint. Only use DOM extraction when no suitable API exists. YAML format shows hierarchical DOM structure with element refs [ref=eN] for targeting. Use maxDepth to limit tree depth for very large pages. ~70-80% smaller than JSON format. NOTE: DOM snapshots may not capture all visual state (expanded/collapsed panels, overlays, dynamic content). If you performed an action (click, type) and the DOM looks unchanged, take a browser_screenshot to visually verify the page state.',
      parameters: {
        type: 'object',
        properties: {
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
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element on the page. Uses exact text matching. Use linkText for the visible text. Use role: "link" for links, "button" for buttons, "text" for other clickables (batch names, tabs, list items, divs/spans). If the item is not a link or button (e.g. "Winter 2026" in a filter), use role "text". Automatically searches iframes if the element is not found on the main page.',
      parameters: {
        type: 'object',
        properties: {
          linkText: { type: 'string', description: 'Visible text of the element to click (e.g. "Sign in", "Winter 2026")' },
          role: { type: 'string', enum: ['link', 'button', 'text'], description: 'Use "link" (default) for <a>, "button" for buttons, "text" for divs/spans/list items (batch names, tabs)' },
          selector: { type: 'string', description: 'CSS selector if linkText is not sufficient' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click_coordinates',
      description: 'Click at exact x,y coordinates on the page. Use for clicking on elements inside iframes (like reCAPTCHA checkbox) where normal selectors don\'t work across iframe boundaries. Get coordinates from browser_get_element_bounds or by analyzing a screenshot. With Camoufox engine, cursor movements appear human-like.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate (pixels from left edge of viewport)' },
          y: { type: 'number', description: 'Y coordinate (pixels from top edge of viewport)' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to click (default "left")' },
          clickCount: { type: 'number', description: '1 for single click, 2 for double click (default 1)' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_solve_turnstile',
      description: 'Detect and solve Cloudflare Turnstile CAPTCHA. Uses image-based detection to find the checkbox (works even with shadow-DOM). Takes a screenshot, detects the widget, and clicks the checkbox. Supports both light and dark themes. Use this when you encounter a Cloudflare Turnstile challenge on a page.',
      parameters: {
        type: 'object',
        properties: {
          scale: { type: 'number', description: 'Scale factor for HiDPI/retina displays (default 1). Use 2 if detection fails on high-resolution screens.' },
          retries: { type: 'number', description: 'Number of retry attempts (default 3)' },
          waitAfterClick: { type: 'number', description: 'Milliseconds to wait after clicking (default 2000)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_detect_turnstile',
      description: 'Detect Cloudflare Turnstile checkbox position without clicking. Returns found (boolean), x, y coordinates, widget bounds, and detected theme. Use this to check if a page has Turnstile before deciding to solve it.',
      parameters: {
        type: 'object',
        properties: {
          scale: { type: 'number', description: 'Scale factor for HiDPI/retina displays (default 1)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_element_bounds',
      description: 'Get the bounding box of an element by CSS selector. Returns position (x, y), dimensions (width, height), and center point (centerX, centerY) for clicking. Use this to find coordinates for elements that are difficult to target with normal selectors, such as iframe contents or positioned elements.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element (e.g., "iframe[title*=\'reCAPTCHA\']", "#my-element")' },
        },
        required: ['selector'],
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
          limit: { type: 'number', description: 'Default 10' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close_session',
      description: 'Close the browser session and free resources. Note: Browser is automatically closed when pack is marked as ready.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  // Proxy tool
  {
    type: 'function',
    function: {
      name: 'set_proxy',
      description: 'Enable or disable proxy for the current flow. Affects both browser sessions and HTTP-only request replays. Use when: IP ban detected (403/429/CAPTCHAs), user requests proxy, or technique instructs. Closes current browser session; it will restart with proxy on next browser tool call. Persistent profile (cookies) is preserved.',
      parameters: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'Whether to enable (true) or disable (false) the proxy',
          },
          mode: {
            type: 'string',
            enum: ['session', 'random'],
            description: 'Proxy mode: "session" for sticky IP (default), "random" for rotating IP per request',
          },
          country: {
            type: 'string',
            description: 'Two-letter ISO country code for geo-targeting (e.g., "US", "GB")',
          },
        },
        required: ['enabled'],
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
      description: 'Set the conversation status. Use "ready" ONLY when the flow has been fully implemented with DSL steps and tested with editor_run_pack. The pack must have actual flow steps — extracting data during exploration does NOT count. Use "needs_input" when waiting for user decision, "error" on failure. Status defaults to "active" during work.',
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
  {
    type: 'function',
    function: {
      name: 'request_secrets',
      description: 'Request the user to provide secret values needed for the automation (e.g., passwords, API keys, TOTP secrets). This will show a modal to the user where they can enter the values securely. The AI never sees the actual values - only knows when they have been provided. Use this when the pack needs credentials that are not yet set. IMPORTANT: For TOTP/2FA, ask the user for their TOTP secret key (a base32 string), NOT a 6-digit code. Then use {{secret.TOTP_KEY_NAME | totp}} in browser_type to auto-generate the current 6-digit code.',
      parameters: {
        type: 'object',
        properties: {
          secrets: {
            type: 'array',
            description: 'List of secrets to request from the user',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Secret name (must match the secret defined in taskpack.json)' },
                description: { type: 'string', description: 'Description of what this secret is used for' },
                required: { type: 'boolean', description: 'Whether this secret is required (default true)' },
              },
              required: ['name'],
            },
          },
          message: {
            type: 'string',
            description: 'A message explaining to the user why these secrets are needed',
          },
        },
        required: ['secrets', 'message'],
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Technique DB tools (optional — only available when TechniqueManager is configured)
// ═══════════════════════════════════════════════════════════════════════════════

export const TECHNIQUE_TOOL_DEFINITIONS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'techniques_load',
      description:
        'Load techniques up to a priority threshold. Returns both generic AND domain-matched specific techniques. ' +
        'Call this at the START of every session with maxPriority=2 to get critical techniques. ' +
        'If a domain is detected, include it to also load domain-specific techniques.',
      parameters: {
        type: 'object',
        properties: {
          maxPriority: {
            type: 'number',
            description: 'Load all techniques with priority <= this value (1-5). Start with 2 for P1-P2.',
          },
          domain: {
            type: 'string',
            description: 'Domain to load specific techniques for (e.g. "linkedin.com", "amazon.com").',
          },
        },
        required: ['maxPriority'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'techniques_search',
      description:
        'Hybrid search the techniques DB for relevant patterns. Uses vector similarity + keyword matching. ' +
        'Use this for on-demand lookups during exploration (e.g. "pagination pattern", "auth flow for linkedin"). ' +
        'If a technique provides specific step-by-step instructions (API endpoint, body format, extraction path), ' +
        'you can skip exploration and use the technique as your exploration context directly.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g. "pagination API pattern", "login flow")' },
          type: { type: 'string', enum: ['generic', 'specific'], description: 'Filter by technique type' },
          domain: { type: 'string', description: 'Filter by domain (e.g. "linkedin.com")' },
          category: { type: 'string', description: 'Filter by category (e.g. "api_extraction", "pagination")' },
          maxPriority: { type: 'number', description: 'Only return techniques with priority <= this value' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'techniques_propose',
      description:
        'Propose new techniques learned during this session. Call after successfully completing a flow. ' +
        'Each technique must specify type (generic=universal, specific=domain-bound) and priority (1-5). ' +
        'Proposed techniques are saved with source="agent-learned" and are immediately active.',
      parameters: {
        type: 'object',
        properties: {
          techniques: {
            type: 'array',
            description: 'Array of techniques to propose',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short technique title' },
                content: { type: 'string', description: 'Full technique description (will be embedded for search)' },
                type: { type: 'string', enum: ['generic', 'specific'], description: 'generic=universal, specific=domain-bound' },
                priority: { type: 'number', description: 'Priority 1-5 (1=critical, 5=edge-case)' },
                domain: { type: 'string', description: 'Domain this applies to (required for specific, null for generic)' },
                category: {
                  type: 'string',
                  enum: ['api_extraction', 'dom_extraction', 'navigation', 'auth', 'pagination', 'anti_detection', 'form_interaction', 'network_patterns', 'data_transformation', 'error_handling', 'system_prompt', 'general'],
                  description: 'Technique category',
                },
                tags: { type: 'array', items: { type: 'string' }, description: 'Searchable tags' },
                confidence: { type: 'number', description: 'Confidence score 0.0-1.0' },
              },
              required: ['title', 'content', 'type', 'priority', 'category', 'confidence'],
            },
          },
        },
        required: ['techniques'],
      },
    },
  },
];

export interface AgentToolContext {
  taskPackEditor: TaskPackEditorWrapper;
  /** Current pack ID for template resolution (optional; needed for {{secret.X}} resolution) */
  packId?: string | null;
  /** Session key for plan storage (typically packId or a unique session identifier) */
  sessionKey?: string;
  /** Current conversation ID (optional; needed for conversation_* and browser_* tools) */
  conversationId?: string | null;
  /** Callback to trigger secrets request modal (set by server) */
  onSecretsRequest?: (request: { secrets: Array<{ name: string; description?: string; required?: boolean }>; message: string }) => void;
  /** Whether to run browser in headful mode (default: true for dashboard) */
  headful?: boolean;
  /** Pack map for version auto-save (optional; provided by dashboard) */
  packMap?: Map<string, { pack: unknown; path: string }>;
  /** Technique manager (null when vector store not configured) */
  techniqueManager?: import('@showrun/techniques').TechniqueManager | null | undefined;
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
      console.log(`[resolveTemplateValue] packId=${ctx.packId}, packFound=${!!pack}, packPath=${pack?.path}`);
      if (pack?.path) {
        secrets = TaskPackLoader.loadSecrets(pack.path);
        console.log(`[resolveTemplateValue] Loaded ${Object.keys(secrets).length} secrets: ${Object.keys(secrets).join(', ')}`);
      } else {
        console.warn(`[resolveTemplateValue] Pack not found or no path for packId=${ctx.packId}`);
      }
    } catch (e) {
      console.warn('[agentTools] Failed to load secrets for template resolution:', e);
    }
  } else {
    console.warn(`[resolveTemplateValue] No packId in context, cannot load secrets for template: ${value}`);
  }

  try {
    // Resolve templates using the core templating function
    const resolved = resolveTemplates(value, {
      inputs: {},
      vars: {},
      secrets,
    });
    // Check for unresolved templates — surface error so the agent sees the problem
    if (typeof resolved === 'string' && /\{\{.*?\}\}/.test(resolved)) {
      console.warn(`[agentTools] Unresolved templates in: ${resolved}`);
      return `[TEMPLATE_ERROR: Some templates could not be resolved in "${value}". Available secrets: ${Object.keys(secrets).join(', ') || 'none'}]`;
    }
    return resolved as string;
  } catch (e) {
    console.warn('[agentTools] Template resolution failed:', e);
    return `[TEMPLATE_ERROR: Resolution failed for "${value}": ${e instanceof Error ? e.message : String(e)}. Available secrets: ${Object.keys(secrets).join(', ') || 'none'}]`;
  }
}

/**
 * Recursively resolve Nunjucks templates in override values.
 * Walks the object tree and resolves any string values containing {{ ... }}.
 */
async function resolveOverrideTemplates(
  overrides: Record<string, unknown>,
  ctx: AgentToolContext
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      resolved[key] = await resolveTemplateValue(value, ctx);
    } else if (Array.isArray(value)) {
      resolved[key] = await Promise.all(
        value.map(async (item) => {
          if (typeof item === 'string') return resolveTemplateValue(item, ctx);
          if (item && typeof item === 'object') return resolveOverrideTemplates(item as Record<string, unknown>, ctx);
          return item;
        })
      );
    } else if (value && typeof value === 'object') {
      resolved[key] = await resolveOverrideTemplates(value as Record<string, unknown>, ctx);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a browser action, wait for the page to settle, take a screenshot,
 * and return both the JSON result and the snapshot for visual feedback.
 */
async function actionWithScreenshot(
  sessionId: string,
  actionResult: unknown,
  delayMs = 5000
): Promise<{ resultJson: string; snapshot: { screenshotBase64: string; mimeType: string; url: string } }> {
  await sleep(delayMs);
  const screenshot = await browserInspector.takeScreenshot(sessionId);
  return {
    resultJson: JSON.stringify(actionResult, null, 2),
    snapshot: { screenshotBase64: screenshot.imageBase64, mimeType: screenshot.mimeType, url: screenshot.url },
  };
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
/** Tools that only the initializer agent should use (pack creation is automatic now) */
const INITIALIZER_ONLY_TOOLS = new Set([
  'editor_create_pack',
  'conversation_link_pack',
]);

/** Tool definitions for the main agent (excludes pack creation/linking - handled by initializer) */
export const MAIN_AGENT_TOOL_DEFINITIONS: ToolDef[] = MCP_AGENT_TOOL_DEFINITIONS.filter(
  t => !INITIALIZER_ONLY_TOOLS.has(t.function.name)
);

// ═══════════════════════════════════════════════════════════════════════════════
// Two-Agent Architecture: Exploration + Editor tool splits
// ═══════════════════════════════════════════════════════════════════════════════

/** The agent_build_flow tool — invokes the Editor Agent from the Exploration Agent */
const AGENT_BUILD_FLOW_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'agent_build_flow',
    description:
      'Delegate flow building to the Editor Agent. Call this after exploration is complete and roadmap is approved. ' +
      'The Editor Agent will build a Playwright JS flow, test it with editor_run_pack, and return results. ' +
      'You MUST provide comprehensive exploration context (all API endpoints, DOM structure, auth info, pagination). ' +
      'Do not call this more than 3 times per conversation.',
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description:
            'The approved roadmap + implementation instructions. Include: what steps to build, approach (API vs DOM), data to extract, inputs/collectibles to define.',
        },
        explorationContext: {
          type: 'string',
          description:
            'All exploration findings. Include: API endpoints discovered (URL, method, response structure), ' +
            'the EXACT request body for POST requests, ' +
            'whether the site supports URL-based filtering (e.g., /items?category=X triggers filtered API calls) — ' +
            'if yes, provide a hardcoded example URL with a specific filter value so the Editor Agent can use the ' +
            '"navigate with known value then bodyReplace" strategy for complex POST bodies. ' +
            'Also include DOM structure notes, auth requirements, pagination info, and relevant techniques from the Techniques DB.',
        },
        testInputs: {
          type: 'object',
          description: 'Input values for testing the flow with editor_run_pack (e.g., {"batch": "W24"}).',
        },
      },
      required: ['instruction', 'explorationContext'],
    },
  },
};

/** Editor-only tools (for the Editor Agent) */
const EDITOR_TOOL_NAMES = new Set([
  'editor_read_pack',
  'editor_list_secrets',
  'editor_write_js',
  'editor_run_pack',
]);

/** Editor Agent tools: editor tools only (no browser, no conversation) */
export const EDITOR_AGENT_TOOLS: ToolDef[] = MCP_AGENT_TOOL_DEFINITIONS.filter(
  t => EDITOR_TOOL_NAMES.has(t.function.name)
);

/** Validator-only tools (read-only + run — no flow modification) */
const VALIDATOR_TOOL_NAMES = new Set([
  'editor_read_pack',
  'editor_validate_flow',
  'editor_run_pack',
]);

/** Validator Agent tools: read + validate + run (no patch, no browser, no conversation) */
export const VALIDATOR_AGENT_TOOLS: ToolDef[] = MCP_AGENT_TOOL_DEFINITIONS.filter(
  t => VALIDATOR_TOOL_NAMES.has(t.function.name)
);

/** The agent_validate_flow tool — invokes the Validator Agent from the Exploration Agent */
const AGENT_VALIDATE_FLOW_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'agent_validate_flow',
    description:
      'Delegate multi-scenario flow validation to the Validator Agent. Call this after agent_build_flow succeeds ' +
      'to test the flow with multiple inputs and edge cases. The Validator Agent will run the flow with each scenario, ' +
      'check structural validity, and return a detailed report. It CANNOT modify the flow — only test and report.',
    parameters: {
      type: 'object',
      properties: {
        flowDescription: {
          type: 'string',
          description:
            'Brief description of what the flow does and what data it extracts. ' +
            'Helps the Validator Agent understand expected behavior and generate edge cases.',
        },
        testScenarios: {
          type: 'array',
          description:
            'Optional array of test scenarios. Each has a name, inputs object, and optional expectedBehavior string. ' +
            'If fewer than 3 scenarios are provided, the Validator Agent will generate additional edge cases.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Scenario name (e.g., "normal input", "empty string", "special chars")' },
              inputs: { type: 'object', description: 'Input values for this scenario' },
              expectedBehavior: { type: 'string', description: 'What should happen (e.g., "returns non-empty array", "returns error gracefully")' },
            },
            required: ['name', 'inputs'],
          },
        },
        explorationContext: {
          type: 'string',
          description:
            'Optional exploration context to help the Validator Agent understand the target site and expected data format.',
        },
      },
      required: ['flowDescription'],
    },
  },
};

/** Exploration Agent tool names — browser + network + context + conversation + read_pack + agent_build_flow */
const EXPLORATION_ONLY_TOOL_NAMES = new Set([
  // Browser tools
  'browser_goto', 'browser_go_back', 'browser_type', 'browser_screenshot',
  'browser_get_links', 'browser_get_dom_snapshot', 'browser_click',
  'browser_click_coordinates', 'browser_get_element_bounds',
  'browser_solve_turnstile', 'browser_detect_turnstile',
  'browser_last_actions', 'browser_close_session',
  // Network tools
  'browser_network_list', 'browser_network_search', 'browser_network_get',
  'browser_network_get_response', 'browser_network_replay', 'browser_network_clear',
  // Context management
  'agent_save_plan', 'agent_get_plan',
  // Conversation management
  'conversation_update_title', 'conversation_update_description', 'conversation_set_status',
  // Secrets
  'request_secrets',
  // Proxy
  'set_proxy',
  // Read-only pack inspection
  'editor_read_pack',
  // Techniques DB
  'techniques_load', 'techniques_search', 'techniques_propose',
]);

/** Exploration Agent tools: browser + context + conversation + read_pack + agent_build_flow + agent_validate_flow + techniques */
export const EXPLORATION_AGENT_TOOLS: ToolDef[] = [
  ...MCP_AGENT_TOOL_DEFINITIONS.filter(t => EXPLORATION_ONLY_TOOL_NAMES.has(t.function.name)),
  AGENT_BUILD_FLOW_TOOL,
  AGENT_VALIDATE_FLOW_TOOL,
  ...TECHNIQUE_TOOL_DEFINITIONS,
];

// ═══════════════════════════════════════════════════════════════════════════════
// Browser Tools that need automatic session management
// ═══════════════════════════════════════════════════════════════════════════════

/** Browser tools that need a session - sessionId is auto-injected */
const BROWSER_TOOLS = new Set([
  'goto',
  'go_back',
  'type',
  'screenshot',
  'get_links',
  'get_dom_snapshot',
  'click',
  'click_coordinates',
  'get_element_bounds',
  'network_list',
  'network_search',
  'network_get',
  'network_get_response',
  'network_replay',
  'network_clear',
  'last_actions',
  'close_session',
]);

/** Per-conversation lock to prevent concurrent session creation */
const sessionCreationLocks = new Map<string, Promise<string>>();

/**
 * Get or create a browser session for the conversation.
 * Auto-starts camoufox if no session exists or session is dead.
 * Uses a per-conversation lock to prevent duplicate session creation from concurrent tool calls.
 *
 * When packId is set in context, uses the pack's .browser-profile/ directory
 * for persistent browser state (cookies, localStorage, etc.). This enables
 * AI exploration sessions to persist auth state to the pack's profile.
 */
async function ensureBrowserSession(ctx: AgentToolContext): Promise<string> {
  if (!ctx.conversationId) {
    throw new Error('Browser tools require a conversation context');
  }

  const convId = ctx.conversationId;

  // If a creation is in-flight for this conversation, wait for it
  const pending = sessionCreationLocks.get(convId);
  if (pending) return pending;

  const existingSessionId = getConversationBrowserSession(convId);

  // Check if existing session is still alive
  if (existingSessionId && isSessionAlive(existingSessionId)) {
    return existingSessionId;
  }

  // Create new session with lock to prevent races
  const promise = (async () => {
    try {
      // Always use camoufox for better anti-detection
      const headful = ctx.headful !== false; // Default true for dashboard
      const engine = 'camoufox' as const;

      // Determine persistent context directory and proxy based on linked pack
      let persistentContextDir: string | undefined;
      let resolvedProxy: import('@showrun/core').ResolvedProxy | undefined;

      if (ctx.packId) {
        const packs = await ctx.taskPackEditor.listPacks();
        const pack = packs.find((p: { id: string; path?: string }) => p.id === ctx.packId);
        if (pack?.path) {
          persistentContextDir = join(pack.path, '.browser-profile');
          mkdirSync(persistentContextDir, { recursive: true });
          console.log(`[BrowserAuto] Using persistent profile for pack ${ctx.packId}: ${persistentContextDir}`);

          // Resolve proxy from pack's browser.proxy config
          try {
            const manifestJson = readFileSync(join(pack.path, 'taskpack.json'), 'utf-8');
            const manifest = JSON.parse(manifestJson);
            const proxyResult = resolveProxy(manifest.browser?.proxy);
            if (proxyResult) {
              resolvedProxy = proxyResult;
              console.log(`[BrowserAuto] Proxy enabled for pack ${ctx.packId}`);
            }
          } catch {
            // Ignore errors reading manifest for proxy
          }
        }
      }

      console.log(`[BrowserAuto] Starting camoufox session for conversation ${convId}${persistentContextDir ? ' (persistent)' : ''}${resolvedProxy ? ' (proxied)' : ''}`);
      const sessionId = await startBrowserSession(headful, engine, {
        persistentContextDir,
        packId: ctx.packId ?? undefined,
        proxy: resolvedProxy,
      });

      // Store session in memory map
      setConversationBrowserSession(convId, sessionId);

      return sessionId;
    } finally {
      sessionCreationLocks.delete(convId);
    }
  })();

  sessionCreationLocks.set(convId, promise);
  return promise;
}

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

  // Auto-inject sessionId for browser tools
  let effectiveArgs = args;
  if (BROWSER_TOOLS.has(internal)) {
    try {
      const sessionId = await ensureBrowserSession(ctx);
      effectiveArgs = { ...args, sessionId };
    } catch (err) {
      return wrap(JSON.stringify({
        error: `Browser session failed: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'The browser may have been closed. Try the operation again to auto-restart.',
      }));
    }
  }

  try {
    switch (internal) {
      case 'read_pack': {
        const packId = (args.packId as string) || ctx.packId;
        if (!packId) throw new Error('No pack linked to this conversation');
        const result = await taskPackEditor.readPack(packId);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'list_secrets': {
        const packId = (args.packId as string) || ctx.packId;
        if (!packId) throw new Error('No pack linked to this conversation');
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
        const packId = (args.packId as string) || ctx.packId;
        if (!packId) throw new Error('No pack linked to this conversation');
        // Accept flat params (op, index?, step?, steps?, collectibles?, inputs?) or legacy nested patch
        const legacyPatch = args.patch as Record<string, unknown> | undefined;
        const patch: Record<string, unknown> = legacyPatch
          ? { ...legacyPatch }
          : {
              op: args.op,
              ...(args.index !== undefined && { index: args.index }),
              ...(args.step !== undefined && { step: args.step }),
              ...(args.steps !== undefined && { steps: args.steps }),
              ...(args.collectibles !== undefined && { collectibles: args.collectibles }),
              ...(args.inputs !== undefined && { inputs: args.inputs }),
            };
        if (!patch.op) throw new Error('op required (append, batch_append, insert, replace, delete, update_collectibles, or update_inputs)');
        const result = await taskPackEditor.applyFlowPatch(packId, patch as any);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'write_js': {
        const packId = (args.packId as string) || ctx.packId;
        if (!packId) throw new Error('No pack linked to this conversation');
        const source = args.source as string;
        if (!source || typeof source !== 'string') throw new Error('source (string) is required');
        const jsInputs = args.inputs as Record<string, { type: string; description?: string; required?: boolean; default?: unknown }> | undefined;
        const jsCollectibles = args.collectibles as Array<{ name: string; type: string; description?: string }> | undefined;
        const result = await taskPackEditor.writePlaywrightJsSource(packId, source, jsInputs, jsCollectibles);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'create_pack': {
        // Check if conversation already has a linked pack
        if (ctx.packId) {
          return wrap(JSON.stringify({
            error: `A pack is already linked to this conversation: "${ctx.packId}". Do not create a new pack. Use editor_read_pack() to see the current flow, then use editor_write_js to write the flow.`,
            existingPackId: ctx.packId,
            suggestion: 'Call editor_read_pack() first to understand the existing flow, then use editor_write_js to write the Playwright code.',
          }, null, 2));
        }

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
        const packId = (args.packId as string) || ctx.packId;
        const inputs = (args.inputs as Record<string, unknown>) || {};
        if (!packId) throw new Error('No pack linked to this conversation');
        const result = await taskPackEditor.runPack(packId, inputs);
        const fullJson = JSON.stringify(result, null, 2);

        // For large results with a stored key, return a summary with the key
        // instead of blindly truncating (which would cut off _resultKey at the end)
        if (result._resultKey && fullJson.length > MAX_TOOL_OUTPUT_CHARS) {
          const collectiblesPreview = JSON.stringify(result.collectibles, null, 2).slice(0, 2000);
          const summary = {
            success: result.success,
            meta: result.meta,
            _resultKey: result._resultKey,
            _stored: true,
            _hint: `Result stored with key="${result._resultKey}". Use showrun_query_results with pack_tool_name and this key to retrieve, filter, or paginate.`,
            _collectiblesPreview: collectiblesPreview + '\n... (truncated)',
            _totalChars: fullJson.length,
          };
          return wrap(JSON.stringify(summary, null, 2));
        }

        return wrap(truncateToolOutput(fullJson, 'run_pack result'));
      }
      // Browser tools - sessionId is auto-injected via effectiveArgs
      case 'set_proxy': {
        // Verify proxy env vars are configured
        const proxyUsername = process.env.SHOWRUN_PROXY_USERNAME;
        const proxyPassword = process.env.SHOWRUN_PROXY_PASSWORD;
        const proxyEnabled = args.enabled as boolean;

        if (proxyEnabled && (!proxyUsername || !proxyPassword)) {
          return wrap(JSON.stringify({
            error: 'Proxy credentials not configured. Set SHOWRUN_PROXY_USERNAME and SHOWRUN_PROXY_PASSWORD environment variables.',
            hint: 'Ask the system administrator to configure proxy credentials.',
          }, null, 2));
        }

        // Build ProxyConfig
        const proxyConfig: ProxyConfig = {
          enabled: proxyEnabled,
          mode: (args.mode as 'session' | 'random') ?? 'session',
        };
        if (args.country) {
          proxyConfig.country = (args.country as string).toUpperCase();
        }

        // Persist to taskpack.json
        const packId = ctx.packId;
        if (!packId) throw new Error('No pack linked to this conversation');
        const packs = await ctx.taskPackEditor.listPacks();
        const pack = packs.find((p: { id: string; path?: string }) => p.id === packId);
        if (!pack?.path) throw new Error(`Pack ${packId} not found or path not available`);

        const manifestPath = join(pack.path, 'taskpack.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (!manifest.browser) manifest.browser = {};
        if (proxyEnabled) {
          manifest.browser.proxy = proxyConfig;
        } else {
          delete manifest.browser.proxy;
        }
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

        // Close existing browser session if open
        if (ctx.conversationId) {
          const existingSessionId = getConversationBrowserSession(ctx.conversationId);
          if (existingSessionId && isSessionAlive(existingSessionId)) {
            await closeSession(existingSessionId);
            setConversationBrowserSession(ctx.conversationId, null);
          }
        }

        const statusMsg = proxyEnabled
          ? `Proxy enabled (mode: ${proxyConfig.mode}${proxyConfig.country ? `, country: ${proxyConfig.country}` : ''}). Browser session closed and will restart with proxy on next browser tool call. Persistent profile (cookies) preserved.`
          : 'Proxy disabled. Browser session closed and will restart without proxy on next browser tool call.';

        return wrap(JSON.stringify({ success: true, message: statusMsg }, null, 2));
      }
      case 'close_session': {
        const sessionId = effectiveArgs.sessionId as string;
        await closeSession(sessionId);
        // Remove from tracking
        if (ctx.conversationId) {
          setConversationBrowserSession(ctx.conversationId, null);
        }
        return wrap(JSON.stringify({ success: true }, null, 2));
      }
      case 'goto': {
        const sessionId = effectiveArgs.sessionId as string;
        const url = args.url as string;
        if (!url) throw new Error('url required');
        // Resolve templates in URL (e.g., {{secret.BASE_URL}})
        const resolvedUrl = await resolveTemplateValue(url, ctx);
        const result = await browserInspector.gotoUrl(sessionId, resolvedUrl);
        const { resultJson, snapshot } = await actionWithScreenshot(sessionId, result);
        return wrap(resultJson, snapshot);
      }
      case 'go_back': {
        const sessionId = effectiveArgs.sessionId as string;
        const result = await browserInspector.goBack(sessionId);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'type': {
        const sessionId = effectiveArgs.sessionId as string;
        const text = args.text as string;
        if (text === undefined) throw new Error('text required');
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
          submit: args.submit === true,
        });
        const { resultJson, snapshot } = await actionWithScreenshot(sessionId, result);
        return wrap(resultJson, snapshot);
      }
      case 'click': {
        const sessionId = effectiveArgs.sessionId as string;
        const linkText = args.linkText as string | undefined;
        const selector = args.selector as string | undefined;
        const role = (args.role as 'link' | 'button' | 'text') || 'link';
        if (!linkText && !selector) throw new Error('linkText or selector required');
        const result = await browserInspector.clickElement(sessionId, { linkText, selector, role });
        const { resultJson, snapshot } = await actionWithScreenshot(sessionId, result);
        return wrap(resultJson, snapshot);
      }
      case 'click_coordinates': {
        const sessionId = effectiveArgs.sessionId as string;
        const x = args.x as number;
        const y = args.y as number;
        if (typeof x !== 'number' || typeof y !== 'number') {
          throw new Error('x and y coordinates are required and must be numbers');
        }
        const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
        const clickCount = (args.clickCount as number) ?? 1;
        const result = await browserInspector.clickAtCoordinates(sessionId, x, y, { button, clickCount });
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'solve_turnstile': {
        const sessionId = effectiveArgs.sessionId as string;
        const page = getSessionPage(sessionId);
        if (!page) throw new Error('No active browser session');
        
        const { solveCloudflareTurnstile } = await import('@showrun/core');
        const scale = (args.scale as number) ?? 1;
        const retries = (args.retries as number) ?? 3;
        const waitAfterClick = (args.waitAfterClick as number) ?? 2000;
        
        const result = await solveCloudflareTurnstile(page, { scale, retries, waitAfterClick });
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'detect_turnstile': {
        const sessionId = effectiveArgs.sessionId as string;
        const page = getSessionPage(sessionId);
        if (!page) throw new Error('No active browser session');
        
        const { detectCloudflareTurnstile } = await import('@showrun/core');
        const scale = (args.scale as number) ?? 1;
        
        const result = await detectCloudflareTurnstile(page, { scale });
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'get_element_bounds': {
        const sessionId = effectiveArgs.sessionId as string;
        const selector = args.selector as string;
        if (!selector) throw new Error('selector required');
        const result = await browserInspector.getElementBounds(sessionId, selector);
        if (result === null) {
          return wrap(JSON.stringify({ found: false, message: 'Element not found or not visible' }, null, 2));
        }
        return wrap(JSON.stringify({ found: true, ...result }, null, 2));
      }
      case 'screenshot': {
        const sessionId = effectiveArgs.sessionId as string;
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
        const sessionId = effectiveArgs.sessionId as string;
        const result = await browserInspector.getLinks(sessionId);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'get_dom_snapshot': {
        const sessionId = effectiveArgs.sessionId as string;
        const format = (args.format as 'yaml' | 'json') ?? 'yaml';
        const maxDepth = args.maxDepth as number | undefined;
        const result = await browserInspector.getDomSnapshot(sessionId, { format, maxDepth });
        // For YAML format, return the snapshot string directly for compactness
        if (format === 'yaml' && 'snapshot' in result) {
          const output = `URL: ${result.url}\nTitle: ${result.title}\n\n${result.snapshot}\n\n[Hint: DOM snapshots may not capture all visual state. If something looks wrong or unchanged after an action, use browser_screenshot to visually verify.]`;
          return wrap(truncateToolOutput(output, 'DOM snapshot'));
        }
        return wrap(truncateToolOutput(JSON.stringify(result, null, 2), 'DOM snapshot'));
      }
      case 'network_list': {
        const sessionId = effectiveArgs.sessionId as string;
        const limit = (args.limit as number) ?? 50;
        const filter = (args.filter as 'all' | 'api' | 'xhr') ?? 'api';
        const compact = args.compact !== false; // default true
        const list = browserInspector.networkList(sessionId, { limit, filter, compact });
        return wrap(JSON.stringify(list, null, 2));
      }
      case 'network_search': {
        const sessionId = effectiveArgs.sessionId as string;
        const query = args.query as string;
        if (query == null) throw new Error('query required');
        const limit = (args.limit as number) ?? 20;
        const list = browserInspector.networkSearch(sessionId, query, limit);
        return wrap(JSON.stringify(list, null, 2));
      }
      case 'network_get': {
        const sessionId = effectiveArgs.sessionId as string;
        const requestId = args.requestId as string;
        if (!requestId) throw new Error('requestId required');
        const result = browserInspector.networkGet(sessionId, requestId);
        return wrap(JSON.stringify(result, null, 2));
      }
      case 'network_get_response': {
        const sessionId = effectiveArgs.sessionId as string;
        const requestId = args.requestId as string;
        if (!requestId) throw new Error('requestId required');
        const full = args.full === true;
        const result = browserInspector.networkGetResponse(sessionId, requestId, full);
        return wrap(truncateToolOutput(JSON.stringify(result, null, 2), 'network response'));
      }
      case 'network_replay': {
        const sessionId = effectiveArgs.sessionId as string;
        const requestId = args.requestId as string;
        if (!requestId) throw new Error('requestId required');
        let overrides = args.overrides as Record<string, unknown> | undefined;
        // Resolve Nunjucks templates in override values (e.g. {{secret.API_KEY}})
        if (overrides) {
          overrides = await resolveOverrideTemplates(overrides, ctx);
        }
        const result = await browserInspector.networkReplay(sessionId, requestId, overrides as Parameters<typeof browserInspector.networkReplay>[2]);
        return wrap(truncateToolOutput(JSON.stringify(result, null, 2), 'network replay'));
      }
      case 'network_clear': {
        const sessionId = effectiveArgs.sessionId as string;
        browserInspector.networkClear(sessionId);
        return wrap(JSON.stringify({ success: true }, null, 2));
      }
      case 'last_actions': {
        const sessionId = effectiveArgs.sessionId as string;
        const limit = (args.limit as number) || 10;
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

        // Guard: "ready" requires a pack with actual flow steps and collectibles
        if (status === 'ready') {
          if (!ctx.packId) {
            return wrap(JSON.stringify({
              error: 'Cannot set status to "ready" without a linked pack. Create a pack and implement flow steps first.',
            }));
          }
          try {
            const packData = await ctx.taskPackEditor.readPack(ctx.packId);
            const hasFlow = !!(packData as any).playwrightJsSource || ((packData as any).flowJson?.flow?.length ?? 0) > 0;
            if (!hasFlow) {
              return wrap(JSON.stringify({
                error: `Cannot set status to "ready": the pack "${ctx.packId}" has no flow. You must implement a flow using editor_write_js before marking as ready. Exploration alone is not enough — the goal is a reusable, deterministic flow.`,
              }));
            }
          } catch (readErr) {
            console.warn(`[Agent] Could not verify pack "${ctx.packId}" for ready guard:`, readErr);
            // If we can't read the pack, allow the status change (don't block on read errors)
          }
        }

        // Auto-close browser when pack is ready
        if (status === 'ready') {
          const existingSessionId = getConversationBrowserSession(ctx.conversationId);
          if (existingSessionId) {
            console.log(`[BrowserAuto] Closing browser for completed pack (conversation ${ctx.conversationId})`);
            await closeSession(existingSessionId);
            setConversationBrowserSession(ctx.conversationId, null);
          }

          // Auto-version on ready
          if (ctx.packId && ctx.packMap) {
            try {
              const packInfo = ctx.packMap.get(ctx.packId);
              if (packInfo) {
                saveVersion(packInfo.path, {
                  source: 'agent',
                  conversationId: ctx.conversationId ?? undefined,
                  label: 'Auto-saved on ready',
                });
                console.log(`[Versioning] Auto-saved version for pack ${ctx.packId}`);
              }
            } catch (e) {
              console.error('[Versioning] Auto-save failed:', e);
            }
          }
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
      // ── Techniques DB tools (techniques_ prefix is NOT stripped) ──
      case 'techniques_load': {
        if (!ctx.techniqueManager) {
          return wrap(JSON.stringify({ error: 'Techniques DB not configured. Set WEAVIATE_URL and EMBEDDING_API_KEY environment variables.' }));
        }
        const maxPriority = args.maxPriority as number;
        const domain = args.domain as string | undefined;
        if (typeof maxPriority !== 'number' || maxPriority < 1 || maxPriority > 5) {
          throw new Error('maxPriority must be a number between 1 and 5');
        }
        const result = await ctx.techniqueManager.loadUpTo(maxPriority, domain);
        return wrap(truncateToolOutput(JSON.stringify(result, null, 2), 'techniques_load'));
      }
      case 'techniques_search': {
        if (!ctx.techniqueManager) {
          return wrap(JSON.stringify({ error: 'Techniques DB not configured. Set WEAVIATE_URL and EMBEDDING_API_KEY environment variables.' }));
        }
        const query = args.query as string;
        if (!query) throw new Error('query required');
        const searchFilters: Record<string, unknown> = {};
        if (args.type) searchFilters.type = args.type;
        if (args.domain) searchFilters.domain = args.domain;
        if (args.category) searchFilters.category = args.category;
        if (args.maxPriority) searchFilters.maxPriority = args.maxPriority;
        const results = await ctx.techniqueManager.search(query, searchFilters as any, 10);
        return wrap(truncateToolOutput(JSON.stringify(results, null, 2), 'techniques_search'));
      }
      case 'techniques_propose': {
        if (!ctx.techniqueManager) {
          return wrap(JSON.stringify({ error: 'Techniques DB not configured. Set WEAVIATE_URL and EMBEDDING_API_KEY environment variables.' }));
        }
        const techniques = args.techniques as Array<Record<string, unknown>>;
        if (!Array.isArray(techniques) || techniques.length === 0) {
          throw new Error('techniques array is required and must not be empty');
        }
        const proposed = techniques.map(t => ({
          title: t.title as string,
          content: t.content as string,
          type: t.type as 'generic' | 'specific',
          priority: t.priority as number,
          domain: (t.domain as string) ?? null,
          category: t.category as string,
          tags: (t.tags as string[]) ?? [],
          confidence: t.confidence as number,
        }));
        const created = await ctx.techniqueManager.propose(proposed as any, ctx.conversationId ?? undefined, ctx.packId ?? undefined);
        return wrap(JSON.stringify({
          success: true,
          proposedCount: created.length,
          techniqueIds: created.map(t => t.id),
        }, null, 2));
      }
      // Secrets request tool
      case 'request_secrets': {
        const secrets = args.secrets as Array<{ name: string; description?: string; required?: boolean }>;
        const message = args.message as string;
        if (!Array.isArray(secrets) || secrets.length === 0) {
          throw new Error('secrets array is required and must not be empty');
        }
        if (!message) {
          throw new Error('message is required');
        }
        // The actual secret request is handled by the server via streaming event
        // This tool just returns a signal that the agent should wait
        return wrap(JSON.stringify({
          _type: 'secrets_request',
          secrets,
          message,
          note: 'Secrets request sent to user. The agent loop will pause and resume when secrets are provided.',
        }));
      }
      default:
        return wrap(JSON.stringify({ error: `Unknown tool: ${name}` }));
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    // Only parse Playwright-specific errors (locator.click, page.goto, browser.newContext etc.)
    // Require a dot after each keyword to avoid false positives (e.g. "browser_context" in hints)
    if (/(?:locator|page|frame|browser)\.\w+/i.test(rawMessage)) {
      const parsed = parsePlaywrightError(rawMessage);
      return wrap(JSON.stringify(parsed));
    }
    return wrap(JSON.stringify({ error: redactSensitive(rawMessage) }));
  }
}

/**
 * Parse Playwright error messages into structured, actionable feedback.
 * Strips ANSI codes, extracts the call log, and adds hints for common failures.
 */
export function parsePlaywrightError(raw: string): { error: string; hint?: string; callLog?: string[] } {
  // Strip ANSI escape codes
  const clean = raw.replace(/\u001b\[\d+m/g, '');

  // Extract call log lines (indented lines starting with "- ")
  const callLogLines: string[] = [];
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      callLogLines.push(trimmed.slice(2));
    }
  }

  // Extract the first line as the core error
  const firstLine = clean.split('\n')[0].trim();

  // Detect specific failure patterns and provide hints
  let hint: string | undefined;

  // Pattern: element found + click attempted but timed out → intercepted click
  if (/timeout.*exceeded/i.test(firstLine)) {
    const resolved = callLogLines.some(l => /locator resolved to/.test(l));
    const performingClick = callLogLines.some(l => /performing click action/.test(l));
    const waitingVisible = callLogLines.some(l => /waiting for element to be visible/.test(l));
    const isVisible = callLogLines.some(l => /element is visible, enabled and stable/.test(l));
    const intercepted = callLogLines.some(l => /intercept/i.test(l));

    if (resolved && performingClick) {
      // Element was found, click was attempted, but timed out after "performing click action"
      // This means another element intercepted the click (overlay, sticky nav, cookie banner, etc.)
      hint = 'The element was found and visible, but the click was intercepted by another element covering it (overlay, sticky header, cookie banner, popup). Try: (1) scroll the page first, (2) close any overlays/popups, (3) use browser_click_coordinates with coordinates from browser_get_element_bounds, or (4) use a more specific CSS selector.';
    } else if (resolved && isVisible && !performingClick) {
      hint = 'The element was found and visible but the click could not be performed. An overlay or another element may be blocking it. Try using browser_click_coordinates or closing overlays first.';
    } else if (resolved && waitingVisible && !isVisible) {
      hint = 'The element was found in the DOM but is not visible (hidden, off-screen, or display:none). Try scrolling to it, waiting for it to appear, or checking if the page state is correct.';
    } else if (!resolved) {
      hint = 'The element was not found on the page. Check that: (1) the text/selector is correct, (2) the page has finished loading, (3) the element is not inside an iframe (use frame step first).';
    }
  }

  // Pattern: strict mode violation (multiple elements matched)
  if (/strict mode violation/i.test(clean)) {
    const match = clean.match(/(\d+) elements/);
    const count = match ? match[1] : 'multiple';
    hint = `${count} elements matched the selector. Use a more specific selector, add "first: true" to target the first match, or use "scope"/"near" params to narrow down.`;
  }

  // Pattern: element is not attached to the DOM
  if (/not attached/i.test(clean) || /detached/i.test(clean)) {
    hint = 'The element was removed from the DOM before the action completed. The page may have re-rendered. Try adding a wait_for step before this action, or retry after the page stabilizes.';
  }

  // Pattern: navigation / frame detached
  if (/frame.*detached/i.test(clean) || /navigating/i.test(clean)) {
    hint = 'A navigation occurred during the action, causing the page context to change. Add a wait_for step (waitUntil: "networkidle" or a specific element) after navigation before interacting.';
  }

  return {
    error: firstLine,
    ...(hint ? { hint } : {}),
    ...(callLogLines.length > 0 ? { callLog: callLogLines } : {}),
  };
}
