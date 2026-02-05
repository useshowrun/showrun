/**
 * Browser Inspector MCP Server
 * Provides tools for browser inspection and element picking
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium, type Browser, type Page } from 'playwright';
import * as z from 'zod';
import type { Target } from '@showrun/core';
import type { ElementFingerprint, ActionLog, NetworkEntry } from './types.js';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);
const NETWORK_BUFFER_MAX = 200;
const POST_DATA_CAP = 500;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    out[k] = SENSITIVE_HEADER_NAMES.has(lower) ? '[REDACTED]' : v;
  }
  return out;
}

function redactPostData(raw: string | undefined | null): string | undefined {
  if (raw == null || raw === '') return undefined;
  let s = raw.length > POST_DATA_CAP ? raw.slice(0, POST_DATA_CAP) + '...[truncated]' : raw;
  if (/["']?(?:password|token|secret|api[_-]?key)["']?\s*[:=]/i.test(s)) {
    s = '[REDACTED - may contain secret]';
  }
  return s;
}

function isLikelyApi(url: string, resourceType?: string): boolean {
  const u = url.toLowerCase();
  return (
    resourceType === 'xhr' ||
    resourceType === 'fetch' ||
    /\/api\//.test(u) ||
    /graphql/i.test(u) ||
    /\/v\d+\//.test(u)
  );
}

/** Strip response body from entry to avoid filling context; use network_get_response for body when needed */
function entryToSummary(entry: NetworkEntry): Omit<NetworkEntry, 'responseBodySnippet'> & { responseBodyAvailable?: boolean } {
  const { responseBodySnippet, ...rest } = entry;
  return { ...rest, responseBodyAvailable: !!responseBodySnippet };
}

/** Suggested pattern for network_find */
interface SuggestedPattern {
  where: {
    urlIncludes?: string;
    urlRegex?: string;
    method?: string;
  };
  description: string;
}

/**
 * Generate suggested URL patterns for matching a network request.
 * Returns multiple patterns from most specific to most general.
 */
function generateSuggestedPatterns(entry: NetworkEntry): SuggestedPattern[] {
  const patterns: SuggestedPattern[] = [];
  const url = entry.url;
  const method = entry.method;

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const pathWithoutLeadingSlash = pathname.startsWith('/') ? pathname.slice(1) : pathname;

    // Pattern 1: Full path (most specific)
    if (pathname && pathname !== '/') {
      patterns.push({
        where: { urlIncludes: pathname, method },
        description: `Exact path match: "${pathname}"`,
      });
    }

    // Pattern 2: Path without leading slash (handles double-slash edge cases)
    if (pathWithoutLeadingSlash && pathWithoutLeadingSlash !== pathname) {
      patterns.push({
        where: { urlIncludes: pathWithoutLeadingSlash, method },
        description: `Path without leading slash: "${pathWithoutLeadingSlash}"`,
      });
    }

    // Pattern 3: Last path segment(s) - useful for API endpoints
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const lastTwo = segments.slice(-2).join('/');
      patterns.push({
        where: { urlIncludes: lastTwo, method },
        description: `Last path segments: "${lastTwo}"`,
      });
    }
    if (segments.length >= 1) {
      const lastOne = segments[segments.length - 1];
      if (lastOne && !patterns.some(p => p.where.urlIncludes === lastOne)) {
        patterns.push({
          where: { urlIncludes: lastOne, method },
          description: `Last path segment: "${lastOne}"`,
        });
      }
    }

    // Pattern 4: Host + path (for cross-origin APIs)
    if (parsed.host) {
      patterns.push({
        where: { urlIncludes: `${parsed.host}${pathname}`, method },
        description: `Host + path: "${parsed.host}${pathname}"`,
      });
    }

    // Add notes about unusual URL features
    if (url.includes('//') && url.indexOf('//') !== url.indexOf('://') + 1) {
      // Has double slash not at protocol
      const doubleSlashPattern = patterns[0];
      if (doubleSlashPattern) {
        doubleSlashPattern.description += ' (note: URL contains double slash)';
      }
    }

  } catch {
    // URL parsing failed, use simple string matching
    patterns.push({
      where: { urlIncludes: url, method },
      description: 'Full URL (parsing failed)',
    });
  }

  return patterns;
}

/** Full request data for replay only; never expose via API */
interface ReplayData {
  requestHeadersFull: Record<string, string>;
  postData?: string;
}

const POST_DATA_REPLAY_CAP = 64 * 1024; // 64KB
let networkIdCounter = 0;

function attachNetworkCapture(
  page: Page,
  networkBuffer: NetworkEntry[],
  networkMap: Map<string, NetworkEntry>,
  replayDataMap: Map<string, ReplayData>
): void {
  const requestToEntry = new Map<object, NetworkEntry>();

  page.on('request', (request) => {
    const id = `req-${++networkIdCounter}-${Date.now()}`;
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();
    const headers = request.headers();
    const rawPostData = request.postData();
    const headersFull: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      headersFull[k] = v;
    }
    const postDataForReplay =
      rawPostData != null && rawPostData.length > 0
        ? rawPostData.length > POST_DATA_REPLAY_CAP
          ? rawPostData.slice(0, POST_DATA_REPLAY_CAP) + '...[truncated]'
          : rawPostData
        : undefined;
    const entry: NetworkEntry = {
      id,
      ts: Date.now(),
      method,
      url,
      resourceType,
      requestHeaders: redactHeaders(headers),
      postData: redactPostData(rawPostData),
      isLikelyApi: isLikelyApi(url, resourceType),
    };
    requestToEntry.set(request as object, entry);
    networkMap.set(id, entry);
    replayDataMap.set(id, { requestHeadersFull: headersFull, postData: postDataForReplay });
    networkBuffer.push(entry);
    if (networkBuffer.length > NETWORK_BUFFER_MAX) {
      const removed = networkBuffer.shift()!;
      networkMap.delete(removed.id);
      replayDataMap.delete(removed.id);
    }
  });

  const RESPONSE_BODY_CAPTURE_MAX = 2000;

  page.on('response', async (response) => {
    const req = response.request();
    const entry = requestToEntry.get(req as object);
    if (entry) {
      entry.status = response.status();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(response.headers())) {
        headers[k] = SENSITIVE_HEADER_NAMES.has(k.toLowerCase()) ? '[REDACTED]' : v;
      }
      entry.responseHeaders = headers;
      try {
        const body = await response.body();
        const maxBytes = Math.min(body.length, RESPONSE_BODY_CAPTURE_MAX * 4);
        entry.responseBodySnippet = body.subarray(0, maxBytes).toString('utf8').slice(0, RESPONSE_BODY_CAPTURE_MAX);
      } catch {
        // ignore body read errors
      }
      requestToEntry.delete(req as object);
    }
  });
}

interface BrowserSession {
  browser: Browser;
  page: Page;
  actions: ActionLog[];
  networkBuffer: NetworkEntry[];
  networkMap: Map<string, NetworkEntry>;
  replayDataMap: Map<string, ReplayData>;
}

export interface BrowserInspectorOptions {
  /**
   * Auth token for HTTP access (if using HTTP transport)
   */
  authToken?: string;
}

export async function createBrowserInspectorServer(
  options: BrowserInspectorOptions = {}
): Promise<void> {
  const sessions = new Map<string, BrowserSession>();

  const server = new McpServer({
    name: 'browser-inspector-mcp',
    version: '0.1.0',
  });

  // Helper: Get element fingerprint from Playwright element handle
  async function getElementFingerprint(page: Page, elementHandle: any): Promise<ElementFingerprint> {
    // Evaluate element properties in the browser context
    const elementInfo = await page.evaluate((el: Element) => {
      const getVisibleText = (elem: Element): string => {
        // Get text content, excluding script and style elements
        const clone = elem.cloneNode(true) as Element;
        const scripts = clone.querySelectorAll('script, style');
        scripts.forEach((s: Element) => s.remove());
        return clone.textContent?.trim() || '';
      };

      const getAccessibleName = (elem: Element): string | undefined => {
        // Try aria-label, aria-labelledby, or title
        const ariaLabel = elem.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        const title = elem.getAttribute('title');
        if (title) return title;
        return undefined;
      };

      const getRole = (elem: Element): string | undefined => {
        const role = elem.getAttribute('role');
        if (role) return role;
        // Infer role from tag name
        const tag = elem.tagName.toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'input') {
          const type = elem.getAttribute('type') || 'text';
          if (type === 'submit') return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return 'textbox';
        }
        if (tag === 'a') return 'link';
        if (tag === 'img') return 'img';
        return undefined;
      };

      const visibleText = getVisibleText(el);
      const tagName = el.tagName.toLowerCase();
      const role = getRole(el);
      const accessibleName = getAccessibleName(el);
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || undefined;
      const placeholder = el.getAttribute('placeholder') || undefined;
      const altText = (el as HTMLImageElement).alt || undefined;
      const id = el.id || undefined;
      const name = (el as HTMLInputElement).name || undefined;
      const type = (el as HTMLInputElement).type || undefined;
      const ariaLabel = el.getAttribute('aria-label') || undefined;
      const dataTestid = el.getAttribute('data-testid') || undefined;

      // Build DOM path hint (simplified)
      const pathParts: string[] = [];
      let current: Element | null = el;
      let depth = 0;
      while (current && depth < 5) {
        const tag = current.tagName.toLowerCase();
        const id = current.id ? `#${current.id}` : '';
        const classes = current.className && typeof current.className === 'string' 
          ? `.${current.className.split(' ').filter(Boolean).join('.')}` 
          : '';
        pathParts.unshift(tag + id + classes);
        current = current.parentElement;
        depth++;
      }
      const domPathHint = pathParts.join(' > ');

      return {
        visibleText: visibleText || undefined,
        tagName,
        role,
        accessibleName,
        label,
        placeholder,
        altText,
        id,
        name,
        type,
        ariaLabel,
        dataTestid,
        domPathHint,
      };
    }, elementHandle);

    // Build candidates (ranked by stability)
    const candidates: Target[] = [];

    // 1. Role + name (most stable)
    if (elementInfo.role && elementInfo.accessibleName) {
      candidates.push({
        kind: 'role',
        role: elementInfo.role as any,
        name: elementInfo.accessibleName,
        exact: true,
      });
    }

    // 2. Label (stable)
    if (elementInfo.label) {
      candidates.push({
        kind: 'label',
        text: elementInfo.label,
        exact: true,
      });
    }

    // 3. Visible text (if meaningful)
    if (elementInfo.visibleText && elementInfo.visibleText.length > 0 && elementInfo.visibleText.length < 100) {
      candidates.push({
        kind: 'text',
        text: elementInfo.visibleText,
        exact: true,
      });
    }

    // 4. Placeholder
    if (elementInfo.placeholder) {
      candidates.push({
        kind: 'placeholder',
        text: elementInfo.placeholder,
        exact: true,
      });
    }

    // 5. Alt text
    if (elementInfo.altText) {
      candidates.push({
        kind: 'altText',
        text: elementInfo.altText,
        exact: true,
      });
    }

    // 6. Test ID (if present)
    if (elementInfo.dataTestid) {
      candidates.push({
        kind: 'testId',
        id: elementInfo.dataTestid,
      });
    }

    // 7. CSS selector as fallback (least stable)
    if (elementInfo.id) {
      candidates.push({
        kind: 'css',
        selector: `#${elementInfo.id}`,
      });
    } else if (elementInfo.name) {
      candidates.push({
        kind: 'css',
        selector: `[name="${elementInfo.name}"]`,
      });
    }

    return {
      text: {
        visibleText: elementInfo.visibleText || undefined,
        exactCandidates: elementInfo.visibleText ? [elementInfo.visibleText] : [],
      },
      role: elementInfo.role
        ? {
            role: elementInfo.role,
            name: elementInfo.accessibleName,
          }
        : undefined,
      label: elementInfo.label,
      placeholder: elementInfo.placeholder,
      altText: elementInfo.altText,
      tagName: elementInfo.tagName,
      attributes: {
        id: elementInfo.id,
        name: elementInfo.name,
        type: elementInfo.type,
        ariaLabel: elementInfo.ariaLabel,
        dataTestid: elementInfo.dataTestid,
      },
      domPathHint: elementInfo.domPathHint,
      candidates,
    };
  }

  // Tool: start_session
  server.registerTool(
    'start_session',
    {
      title: 'Start Browser Session',
      description: 'Launches Playwright chromium headful',
      inputSchema: z.object({
        headful: z.boolean().optional().default(true),
      }),
    },
    async (args: { headful?: boolean }) => {
      const { headful } = args;
      const browser = await chromium.launch({
        headless: !headful,
        channel: 'chromium',
      });

      const page = await browser.newPage();
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const networkBuffer: NetworkEntry[] = [];
      const networkMap = new Map<string, NetworkEntry>();
      const replayDataMap = new Map<string, ReplayData>();

      sessions.set(sessionId, {
        browser,
        page,
        actions: [],
        networkBuffer,
        networkMap,
        replayDataMap,
      });

      attachNetworkCapture(page, networkBuffer, networkMap, replayDataMap);

      sessions.get(sessionId)!.actions.push({
        timestamp: Date.now(),
        action: 'start_session',
        details: { headful },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sessionId }, null, 2),
          },
        ],
        structuredContent: { sessionId },
      };
    }
  );

  // Tool: goto
  server.registerTool(
    'goto',
    {
      title: 'Navigate to URL',
      description: 'Navigates the browser to a URL',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
        url: z.string().describe('URL to navigate to'),
      }),
    },
    async (args: { sessionId: string; url: string }) => {
      const { sessionId, url } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      await session.page.goto(url, { waitUntil: 'domcontentloaded' });
      const currentUrl = session.page.url();

      session.actions.push({
        timestamp: Date.now(),
        action: 'goto',
        details: { url, currentUrl },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ url: currentUrl }, null, 2),
          },
        ],
        structuredContent: { url: currentUrl },
      };
    }
  );

  // Tool: go_back
  server.registerTool(
    'go_back',
    {
      title: 'Go Back',
      description: 'Navigates the browser back one step in history',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
      }),
    },
    async (args: { sessionId: string }) => {
      const { sessionId } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      await session.page.goBack();
      const url = session.page.url();
      session.actions.push({
        timestamp: Date.now(),
        action: 'go_back',
        details: { url },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ url }, null, 2),
          },
        ],
        structuredContent: { url },
      };
    }
  );

  // Tool: type
  server.registerTool(
    'type',
    {
      title: 'Type in Element',
      description: 'Types text into an input field. Target the field by label (accessible name) or CSS selector.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
        text: z.string().describe('Text to type'),
        label: z.string().optional().describe('Accessible name/label of the input (e.g. "Search", "Email")'),
        selector: z.string().optional().describe('CSS selector when label is not enough'),
        clear: z.boolean().optional().default(true).describe('Clear the field before typing'),
      }),
    },
    async (args: { sessionId: string; text: string; label?: string; selector?: string; clear?: boolean }) => {
      const { sessionId, text, label, selector, clear = true } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      if (!label && !selector) {
        throw new Error('Either label or selector is required');
      }
      const page = session.page;
      if (label) {
        const locator = page.getByRole('textbox', { name: label }).first();
        if (clear) await locator.clear();
        await locator.fill(text);
      } else {
        const locator = page.locator(selector!).first();
        if (clear) await locator.clear();
        await locator.fill(text);
      }
      session.actions.push({
        timestamp: Date.now(),
        action: 'type',
        details: { label, selector, textLength: text.length, url: page.url() },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ url: page.url(), typed: true }, null, 2),
          },
        ],
        structuredContent: { url: page.url(), typed: true } as unknown as Record<string, unknown>,
      };
    }
  );

  // Tool: get_links
  server.registerTool(
    'get_links',
    {
      title: 'Get Links',
      description: 'Returns all links on the current page (href, visible text, title). Cheaper than screenshot + vision when you need to find or click a link.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
      }),
    },
    async (args: { sessionId: string }) => {
      const { sessionId } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const page = session.page;
      const url = page.url();
      const MAX_LINKS = 300;
      const links = await page.evaluate((max: number) => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
        return anchors.slice(0, max).map((a: HTMLAnchorElement) => {
          const href = a.href.trim();
          const text = (a.textContent || '').trim().slice(0, 150) || undefined;
          const title = (a.title || '').trim() || undefined;
          return { href, text, title };
        });
      }, MAX_LINKS);
      session.actions.push({
        timestamp: Date.now(),
        action: 'get_links',
        details: { url, count: links.length },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ url, links }, null, 2),
          },
        ],
        structuredContent: { url, links } as unknown as Record<string, unknown>,
      };
    }
  );

  // Tool: screenshot
  server.registerTool(
    'screenshot',
    {
      title: 'Take Screenshot',
      description: 'Captures a screenshot of the current page',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
      }),
    },
    async (args: { sessionId: string }) => {
      const { sessionId } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const imageBuffer = await session.page.screenshot({ type: 'png' });
      const imageBase64 = imageBuffer.toString('base64');
      const url = session.page.url();

      session.actions.push({
        timestamp: Date.now(),
        action: 'screenshot',
        details: { url },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                imageBase64,
                url,
                timestamp: Date.now(),
              },
              null,
              2
            ),
          },
        ],
        structuredContent: {
          imageBase64,
          url,
          timestamp: Date.now(),
        },
      };
    }
  );

  // Tool: last_actions
  server.registerTool(
    'last_actions',
    {
      title: 'Get Last Actions',
      description: 'Returns recent actions performed via inspector tools',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
        limit: z.number().optional().default(10),
      }),
    },
    async (args: { sessionId: string; limit?: number }) => {
      const { sessionId, limit = 10 } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const actions = session.actions.slice(-limit);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(actions, null, 2),
          },
        ],
        structuredContent: actions as unknown as Record<string, unknown>,
      };
    }
  );

  // Tool: network_list
  server.registerTool(
    'network_list',
    {
      title: 'List Network Requests',
      description: 'Returns recent network requests (redacted). Optional filter: all, api, xhr.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
        limit: z.number().optional().default(50),
        filter: z.enum(['all', 'api', 'xhr']).optional().default('all'),
      }),
    },
    async (args: { sessionId: string; limit?: number; filter?: 'all' | 'api' | 'xhr' }) => {
      const { sessionId, limit = 50, filter = 'all' } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      let list = session.networkBuffer.slice(-limit);
      if (filter === 'api' || filter === 'xhr') {
        list = list.filter((e) => e.isLikelyApi || e.resourceType === 'xhr' || e.resourceType === 'fetch');
      }
      const summaryList = list.map(entryToSummary);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summaryList, null, 2) }],
        structuredContent: summaryList as unknown as Record<string, unknown>,
      };
    }
  );

  // Helper: match query against URL, method, headers, postData, status, resourceType
  function entryMatchesSearch(e: NetworkEntry, q: string): boolean {
    if (e.url.toLowerCase().includes(q)) return true;
    if (e.method.toLowerCase().includes(q)) return true;
    if (e.resourceType?.toLowerCase().includes(q)) return true;
    if (e.status != null && String(e.status).includes(q)) return true;
    if (e.postData?.toLowerCase().includes(q)) return true;
    if (e.responseBodySnippet?.toLowerCase().includes(q)) return true;
    for (const [k, v] of Object.entries(e.requestHeaders ?? {})) {
      if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) return true;
    }
    for (const [k, v] of Object.entries(e.responseHeaders ?? {})) {
      if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) return true;
    }
    return false;
  }

  // Tool: network_search
  server.registerTool(
    'network_search',
    {
      title: 'Search Network Requests',
      description: 'Search network requests by query (case-insensitive). Matches URL, method, resourceType, status, request/response headers, and postData. Returns only matching entries (capped at 20).',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
        query: z.string().describe('Substring to match in URL, method, headers, body, or status'),
        limit: z.number().optional().default(20),
      }),
    },
    async (args: { sessionId: string; query: string; limit?: number }) => {
      const { sessionId, query, limit = 20 } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const q = query.trim().toLowerCase();
      if (!q) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify([], null, 2) }],
          structuredContent: [] as unknown as Record<string, unknown>,
        };
      }
      const matches = session.networkBuffer.filter((e) => entryMatchesSearch(e, q));
      const list = matches.slice(-limit).map(entryToSummary);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
        structuredContent: list as unknown as Record<string, unknown>,
      };
    }
  );

  // Tool: network_get
  server.registerTool(
    'network_get',
    {
      title: 'Get Network Request',
      description: 'Returns one request by id (metadata only; no response body). Use network_get_response when you need the response body. replayPossible indicates replay with browser context is possible.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
        requestId: z.string().describe('Request ID from network_list'),
      }),
    },
    async (args: { sessionId: string; requestId: string }) => {
      const { sessionId, requestId } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const entry = session.networkMap.get(requestId);
      if (!entry) {
        throw new Error(`Request not found: ${requestId}`);
      }
      const suggestedPatterns = generateSuggestedPatterns(entry);
      const result = {
        entry: entryToSummary(entry),
        replayPossible: true,
        suggestedPatterns,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // Tool: network_get_response
  const RESPONSE_BODY_DEFAULT_RETURN = 200;
  server.registerTool(
    'network_get_response',
    {
      title: 'Get Response Body',
      description: 'Get the response body for a request. Returns first 200 characters by default; set full=true to return the full captured snippet (up to 2000 chars).',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
        requestId: z.string().describe('Request ID from network_list or network_get'),
        full: z.boolean().optional().default(false).describe('If true, return full captured snippet (up to 2000 chars)'),
      }),
    },
    async (args: { sessionId: string; requestId: string; full?: boolean }) => {
      const { sessionId, requestId, full = false } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const entry = session.networkMap.get(requestId);
      if (!entry) {
        throw new Error(`Request not found: ${requestId}`);
      }
      const snippet = entry.responseBodySnippet ?? '';
      const responseBody = full ? snippet : snippet.slice(0, RESPONSE_BODY_DEFAULT_RETURN);
      const result = { requestId, responseBody };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // Tool: network_clear
  server.registerTool(
    'network_clear',
    {
      title: 'Clear Network Buffer',
      description: 'Clears the session network buffer.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
      }),
    },
    async (args: { sessionId: string }) => {
      const { sessionId } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      session.networkBuffer.length = 0;
      session.networkMap.clear();
      session.replayDataMap.clear();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }, null, 2) }],
        structuredContent: { success: true },
      };
    }
  );

  // Tool: network_replay
  server.registerTool(
    'network_replay',
    {
      title: 'Replay Network Request',
      description: 'Replay a captured request using the browser context (cookies apply). Optionally override url, query params, headers (non-sensitive), or body. Returns status, contentType, and bounded response body.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID'),
        requestId: z.string().describe('Request ID from network_list or network_get'),
        overrides: z
          .object({
            url: z.string().optional(),
            setQuery: z.record(z.union([z.string(), z.number()])).optional(),
            setHeaders: z.record(z.string()).optional(),
            body: z.string().optional(),
          })
          .optional(),
      }),
    },
    async (args: { sessionId: string; requestId: string; overrides?: { url?: string; setQuery?: Record<string, string | number>; setHeaders?: Record<string, string>; body?: string } }) => {
      const { sessionId, requestId, overrides } = args;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const entry = session.networkMap.get(requestId);
      if (!entry) {
        throw new Error(`Request not found: ${requestId}`);
      }
      const replayData = session.replayDataMap.get(requestId);
      if (!replayData) {
        throw new Error(`Replay data not found for request: ${requestId}`);
      }
      for (const key of SENSITIVE_HEADER_NAMES) {
        if (overrides?.setHeaders && Object.keys(overrides.setHeaders).some((k) => k.toLowerCase() === key)) {
          throw new Error(`Cannot set sensitive header: ${key}`);
        }
      }
      const requestContext = (session.page as { request?: { fetch: (url: string, options?: object) => Promise<{ status: () => number; headers: () => Record<string, string>; body: () => Promise<Buffer> }> } }).request;
      if (!requestContext || typeof requestContext.fetch !== 'function') {
        throw new Error('Browser context does not support API request (replay). Playwright version may be too old.');
      }
      let url = overrides?.url ?? entry.url;
      const method = entry.method;
      const headers: Record<string, string> = { ...replayData.requestHeadersFull };
      if (overrides?.setHeaders) {
        for (const [k, v] of Object.entries(overrides.setHeaders)) {
          if (SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) continue;
          headers[k] = v;
        }
      }
      if (overrides?.setQuery) {
        const u = new URL(url);
        for (const [k, v] of Object.entries(overrides.setQuery)) {
          u.searchParams.set(k, String(v));
        }
        url = u.toString();
      }
      const body = overrides?.body ?? replayData.postData ?? undefined;

      const response = await requestContext.fetch(url, {
        method,
        headers,
        data: body,
      });
      const respBody = await response.body();
      const bodySize = respBody.length;
      const contentType = response.headers()['content-type'] ?? response.headers()['Content-Type'];
      const bodyText =
        bodySize <= 256 * 1024
          ? respBody.toString('utf8')
          : respBody.toString('utf8').slice(0, 2048) + '...[truncated]';
      const result = { status: response.status(), contentType, body: bodyText, bodySize };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[Browser Inspector MCP] Server started and ready');
}
