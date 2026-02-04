/**
 * Browser Inspector
 * Direct browser session management for Teach Mode
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Target } from '@mcpify/core';

export type BrowserEngine = 'chromium' | 'camoufox';

// ElementFingerprint type (matches browser-inspector-mcp)
export interface ElementFingerprint {
  text?: { visibleText?: string; exactCandidates: string[] };
  role?: { role: string; name?: string };
  label?: string;
  placeholder?: string;
  altText?: string;
  tagName: string;
  attributes: {
    id?: string;
    name?: string;
    type?: string;
    ariaLabel?: string;
    dataTestid?: string;
  };
  domPathHint?: string;
  candidates: Target[];
}

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

const RESPONSE_BODY_CAPTURE_MAX = 2000; // chars we store per response
const RESPONSE_BODY_DEFAULT_RETURN = 200; // default chars returned by get_response unless full

export interface NetworkEntry {
  id: string;
  ts: number;
  method: string;
  url: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  status?: number;
  responseHeaders?: Record<string, string>;
  postData?: string;
  isLikelyApi?: boolean;
  /** First RESPONSE_BODY_CAPTURE_MAX chars of response body (if captured) */
  responseBodySnippet?: string;
}

/** Entry without response body to avoid filling context; use networkGetResponse for body when needed */
export type NetworkEntrySummary = Omit<NetworkEntry, 'responseBodySnippet'> & {
  responseBodyAvailable?: boolean;
};

/** Compact entry with minimal fields for list overview */
export interface NetworkEntryCompact {
  id: string;
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  isLikelyApi?: boolean;
  /** First ~100 chars of response body for quick inspection */
  responsePreview?: string;
}

/** How many chars to include in compact response preview */
const COMPACT_RESPONSE_PREVIEW_LENGTH = 100;

function entryToSummary(entry: NetworkEntry): NetworkEntrySummary {
  const { responseBodySnippet, ...rest } = entry;
  return { ...rest, responseBodyAvailable: !!responseBodySnippet };
}

function entryToCompact(entry: NetworkEntry): NetworkEntryCompact {
  const result: NetworkEntryCompact = {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    resourceType: entry.resourceType,
    isLikelyApi: entry.isLikelyApi,
  };
  if (entry.responseBodySnippet) {
    const preview = entry.responseBodySnippet.slice(0, COMPACT_RESPONSE_PREVIEW_LENGTH);
    result.responsePreview = preview.length < entry.responseBodySnippet.length
      ? preview + '...'
      : preview;
  }
  return result;
}

/** Full request data for replay only; never expose via API/MCP */
interface ReplayData {
  requestHeadersFull: Record<string, string>;
  postData?: string;
}

interface BrowserSession {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  engine: BrowserEngine;
  actions: Array<{ timestamp: number; action: string; details?: any }>;
  networkBuffer: NetworkEntry[];
  networkMap: Map<string, NetworkEntry>;
  /** Full headers + postData for replay only; keyed by request id */
  replayDataMap: Map<string, ReplayData>;
}

const POST_DATA_REPLAY_CAP = 64 * 1024; // 64KB for replay

const sessions = new Map<string, BrowserSession>();
let networkIdCounter = 0;

function attachNetworkCapture(
  _sessionId: string,
  page: Page,
  networkBuffer: NetworkEntry[],
  networkMap: Map<string, NetworkEntry>,
  replayDataMap: Map<string, ReplayData>
) {
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
        // ignore body read errors (e.g. already consumed)
      }
      requestToEntry.delete(req as object);
    }
  });
}

export async function startBrowserSession(headful = true, engine: BrowserEngine = 'chromium'): Promise<string> {
  let browser: Browser | null = null;
  let context: BrowserContext;
  let page: Page;

  if (engine === 'camoufox') {
    // Dynamic import to avoid loading Camoufox when not needed
    let Camoufox: (options: { headless?: boolean }) => Promise<BrowserContext>;
    try {
      const camoufoxModule = await import('camoufox-js');
      Camoufox = camoufoxModule.Camoufox;
    } catch (error) {
      throw new Error(
        'Camoufox is not available. Run "npx camoufox-js fetch" to download the browser. ' +
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Camoufox returns a BrowserContext directly
    context = await Camoufox({ headless: !headful });
    const existingPages = context.pages();
    page = existingPages.length > 0 ? existingPages[0] : await context.newPage();
  } else {
    // Default: Chromium
    browser = await chromium.launch({
      headless: !headful,
      channel: 'chromium',
    });
    context = await browser.newContext();
    page = await context.newPage();
  }

  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const networkBuffer: NetworkEntry[] = [];
  const networkMap = new Map<string, NetworkEntry>();
  const replayDataMap = new Map<string, ReplayData>();

  sessions.set(sessionId, {
    browser,
    context,
    page,
    engine,
    actions: [],
    networkBuffer,
    networkMap,
    replayDataMap,
  });

  attachNetworkCapture(sessionId, page, networkBuffer, networkMap, replayDataMap);

  sessions.get(sessionId)!.actions.push({
    timestamp: Date.now(),
    action: 'start_session',
    details: { headful, engine },
  });

  return sessionId;
}

export async function gotoUrl(sessionId: string, url: string): Promise<string> {
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

  return currentUrl;
}

export async function goBack(sessionId: string): Promise<{ url: string }> {
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
  return { url };
}

export interface PageLink {
  href: string;
  text?: string;
  title?: string;
}

/** Max links to return to avoid huge payloads */
const MAX_LINKS = 300;

export async function getLinks(sessionId: string): Promise<{ url: string; links: PageLink[] }> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const { page } = session;
  const url = page.url();

  const links = await page.evaluate((max: number) => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    return anchors.slice(0, max).map((a) => {
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

  return { url, links };
}

/** Options for typing into an input: target by label (accessible name) or selector */
export interface TypeOptions {
  /** Text to type into the field */
  text: string;
  /** Accessible name/label of the input (e.g. "Search", "Email"). Use getByRole('textbox', { name }). */
  label?: string;
  /** CSS selector when label is not enough */
  selector?: string;
  /** If true, clear the field before typing (default true) */
  clear?: boolean;
}

export async function typeInElement(
  sessionId: string,
  options: TypeOptions
): Promise<{ url: string; typed: boolean }> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const { page } = session;
  const text = options.text;
  const label = options.label?.trim();
  const selector = options.selector?.trim();
  const clear = options.clear !== false;

  if (!text) {
    throw new Error('text is required');
  }
  if (!label && !selector) {
    throw new Error('Either label or selector is required');
  }

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
    details: { label: label ?? undefined, selector: selector ?? undefined, textLength: text.length, url: page.url() },
  });
  return { url: page.url(), typed: true };
}

const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_MAX_BASE64_BYTES = 3_000_000; // ~4MB base64 cap

export async function takeScreenshot(
  sessionId: string
): Promise<{ imageBase64: string; mimeType: string; url: string; timestamp: number }> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const { page } = session;
  const prevViewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: SCREENSHOT_MAX_WIDTH, height: 720 });
  } catch {
    // ignore viewport errors
  }

  let imageBuffer: Buffer;
  let mimeType: string;
  imageBuffer = await page.screenshot({ type: 'png' });
  mimeType = 'image/png';
  let imageBase64 = imageBuffer.toString('base64');
  if (imageBase64.length > SCREENSHOT_MAX_BASE64_BYTES) {
    imageBuffer = await page.screenshot({ type: 'jpeg', quality: 0.82 });
    mimeType = 'image/jpeg';
    imageBase64 = imageBuffer.toString('base64');
  }

  if (prevViewport) {
    await page.setViewportSize(prevViewport).catch(() => {});
  }

  const url = page.url();
  session.actions.push({
    timestamp: Date.now(),
    action: 'screenshot',
    details: { url, mimeType },
  });

  return { imageBase64, mimeType, url, timestamp: Date.now() };
}

/** Options for clicking an element: linkText/buttonText (visible text) or CSS selector */
export interface ClickOptions {
  /** Visible text of the element to click (e.g. "Sign in", "Winter 2026"). */
  linkText?: string;
  /** Role when using linkText: "link" | "button" | "text". Use "text" for divs, spans, list items (e.g. batch names, tabs). */
  role?: 'link' | 'button' | 'text';
  /** CSS selector when linkText is not enough (e.g. "a.sign-in"). */
  selector?: string;
}

export async function clickElement(
  sessionId: string,
  options: ClickOptions
): Promise<{ url: string; clicked: boolean }> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const { page } = session;
  const linkText = options.linkText?.trim();
  const role = options.role ?? 'link';
  const selector = options.selector?.trim();

  if (!linkText && !selector) {
    throw new Error('Either linkText or selector is required');
  }

  if (linkText) {
    const locator =
      role === 'text'
        ? page.getByText(linkText, { exact: true }).first()
        : page.getByRole(role, { name: linkText }).first();
    await locator.click();
    session.actions.push({
      timestamp: Date.now(),
      action: 'click',
      details: { linkText, role, url: page.url() },
    });
    return { url: page.url(), clicked: true };
  }

  const locator = page.locator(selector!).first();
  await locator.click();
  session.actions.push({
    timestamp: Date.now(),
    action: 'click',
    details: { selector, url: page.url() },
  });
  return { url: page.url(), clicked: true };
}

export async function pickElement(sessionId: string): Promise<ElementFingerprint> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Inject overlay script (same as browser inspector MCP)
  await session.page.evaluate(() => {
    const existing = document.getElementById('mcpify-pick-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'mcpify-pick-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 999999;
      cursor: crosshair;
      background: rgba(0, 0, 0, 0.1);
    `;

    let hoveredElement: Element | null = null;

    overlay.addEventListener('mouseover', (e) => {
      if (e.target === overlay) return;
      const target = e.target as Element;
      if (hoveredElement) {
        (hoveredElement as HTMLElement).style.outline = '';
      }
      hoveredElement = target;
      (target as HTMLElement).style.outline = '2px solid #007bff';
    });

    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.target === overlay) return;
      const target = e.target as Element;
      (window as any).__mcpify_picked_element = target;
      overlay.remove();
    });

    document.body.appendChild(overlay);
  });

  // Wait for element to be picked
  let pickedElement: any = null;
  const maxWait = 30000;
  const startTime = Date.now();

  while (!pickedElement && Date.now() - startTime < maxWait) {
    pickedElement = await session.page.evaluate(() => {
      return (window as any).__mcpify_picked_element || null;
    });

    if (!pickedElement) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!pickedElement) {
    await session.page.evaluate(() => {
      const overlay = document.getElementById('mcpify-pick-overlay');
      if (overlay) overlay.remove();
    });
    throw new Error('Element pick timeout');
  }

  const elementHandle = await session.page.evaluateHandle(() => {
    return (window as any).__mcpify_picked_element;
  });

  const fingerprint = await getElementFingerprint(session.page, elementHandle);

  session.actions.push({
    timestamp: Date.now(),
    action: 'pick_element',
    details: { fingerprint },
  });

  return fingerprint;
}

async function getElementFingerprint(page: Page, elementHandle: any): Promise<ElementFingerprint> {
  const elementInfo = await page.evaluate((el: Element) => {
    const getVisibleText = (elem: Element): string => {
      const clone = elem.cloneNode(true) as Element;
      const scripts = clone.querySelectorAll('script, style');
      scripts.forEach((s) => s.remove());
      return clone.textContent?.trim() || '';
    };

    const getAccessibleName = (elem: Element): string | undefined => {
      const ariaLabel = elem.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      const title = elem.getAttribute('title');
      if (title) return title;
      return undefined;
    };

    const getRole = (elem: Element): string | undefined => {
      const role = elem.getAttribute('role');
      if (role) return role;
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

  const candidates: Target[] = [];

  if (elementInfo.role && elementInfo.accessibleName) {
    candidates.push({
      kind: 'role',
      role: elementInfo.role as any,
      name: elementInfo.accessibleName,
      exact: true,
    });
  }

  if (elementInfo.label) {
    candidates.push({
      kind: 'label',
      text: elementInfo.label,
      exact: true,
    });
  }

  if (elementInfo.visibleText && elementInfo.visibleText.length > 0 && elementInfo.visibleText.length < 100) {
    candidates.push({
      kind: 'text',
      text: elementInfo.visibleText,
      exact: true,
    });
  }

  if (elementInfo.placeholder) {
    candidates.push({
      kind: 'placeholder',
      text: elementInfo.placeholder,
      exact: true,
    });
  }

  if (elementInfo.altText) {
    candidates.push({
      kind: 'altText',
      text: elementInfo.altText,
      exact: true,
    });
  }

  if (elementInfo.dataTestid) {
    candidates.push({
      kind: 'testId',
      id: elementInfo.dataTestid,
    });
  }

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

export function getLastActions(sessionId: string, limit = 10) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return session.actions.slice(-limit);
}

export type NetworkListFilter = 'all' | 'api' | 'xhr';

export interface NetworkListOptions {
  limit?: number;
  filter?: NetworkListFilter;
  /** If true (default), return compact entries (id, method, url, status). Set false for full headers. */
  compact?: boolean;
}

export function networkList(
  sessionId: string,
  options: NetworkListOptions = {}
): NetworkEntryCompact[] | NetworkEntrySummary[] {
  const { limit = 50, filter = 'api', compact = true } = options;
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const buf = session.networkBuffer ?? [];
  let list = buf.slice(-limit);
  if (filter === 'api' || filter === 'xhr') {
    list = list.filter((e) => e.isLikelyApi || e.resourceType === 'xhr' || e.resourceType === 'fetch');
  }
  return compact ? list.map(entryToCompact) : list.map(entryToSummary);
}

const NETWORK_SEARCH_DEFAULT_LIMIT = 20;

function entryMatchesQuery(e: NetworkEntry, q: string): boolean {
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

/**
 * Search network buffer by query (case-insensitive). Matches URL, method, resourceType, status,
 * request/response headers, postData, and response body snippet. Returns matching entries, capped to limit.
 */
export function networkSearch(
  sessionId: string,
  query: string,
  limit = NETWORK_SEARCH_DEFAULT_LIMIT
): NetworkEntrySummary[] {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const buf = session.networkBuffer ?? [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = buf.filter((e) => entryMatchesQuery(e, q));
  return matches.slice(-limit).map(entryToSummary);
}

export function networkGet(sessionId: string, requestId: string): { entry: NetworkEntrySummary; replayPossible: boolean } {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const entry = session.networkMap?.get(requestId);
  if (!entry) {
    throw new Error(`Request not found: ${requestId}`);
  }
  return { entry: entryToSummary(entry), replayPossible: true };
}

/**
 * Get response body for a request. Returns first 200 chars by default; set full=true to return the full captured snippet (up to 2000 chars).
 */
export function networkGetResponse(
  sessionId: string,
  requestId: string,
  full = false
): { requestId: string; responseBody: string } {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const entry = session.networkMap?.get(requestId);
  if (!entry) {
    throw new Error(`Request not found: ${requestId}`);
  }
  const snippet = entry.responseBodySnippet ?? '';
  const responseBody = full ? snippet : snippet.slice(0, RESPONSE_BODY_DEFAULT_RETURN);
  return { requestId, responseBody };
}

export interface NetworkReplayOverrides {
  url?: string;
  setQuery?: Record<string, string | number>;
  setHeaders?: Record<string, string>;
  body?: string;
  urlReplace?: { find: string; replace: string };
  bodyReplace?: { find: string; replace: string };
}

/**
 * Replay a captured request using the browser context (cookies apply). Full headers used only server-side; response returned is bounded.
 */
export async function networkReplay(
  sessionId: string,
  requestId: string,
  overrides?: NetworkReplayOverrides
): Promise<{ status: number; contentType?: string; body: string; bodySize: number }> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const entry = session.networkMap?.get(requestId);
  if (!entry) {
    throw new Error(`Request not found: ${requestId}`);
  }
  const replayData = session.replayDataMap?.get(requestId);
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
  let url = entry.url;
  if (overrides?.urlReplace) {
    try {
      const re = new RegExp(overrides.urlReplace.find, 'g');
      url = url.replace(re, overrides.urlReplace.replace);
    } catch (e) {
      throw new Error(`overrides.urlReplace.find is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (overrides?.url != null) url = overrides.url;
  let body: string | undefined = replayData.postData ?? undefined;
  if (body != null && overrides?.bodyReplace) {
    try {
      const re = new RegExp(overrides.bodyReplace.find, 'g');
      body = body.replace(re, overrides.bodyReplace.replace);
    } catch (e) {
      throw new Error(`overrides.bodyReplace.find is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (overrides?.body != null) body = overrides.body;
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
  return {
    status: response.status(),
    contentType,
    body: bodyText,
    bodySize,
  };
}

export function networkClear(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.networkBuffer) session.networkBuffer.length = 0;
  if (session.networkMap) session.networkMap.clear();
  if (session.replayDataMap) session.replayDataMap.clear();
}

export function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    return Promise.resolve();
  }
  sessions.delete(sessionId);
  // Close browser if available (Chromium), otherwise close context (Camoufox)
  if (session.browser) {
    return session.browser.close();
  }
  return session.context.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM Snapshot for Autonomous Exploration
// ─────────────────────────────────────────────────────────────────────────────

/** Target hint for step proposals - matches the Target type from @mcpify/core */
export interface TargetHint {
  kind: 'css' | 'text' | 'role' | 'label' | 'placeholder' | 'testId' | 'altText';
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  id?: string;
  exact?: boolean;
}

export interface InteractiveElement {
  index: number;
  tagName: string;
  role: string;
  text: string;
  ariaLabel?: string;
  placeholder?: string;
  href?: string;
  type?: string;
  name?: string;
  id?: string;
  isVisible: boolean;
  target: TargetHint;
}

export interface FormField {
  name?: string;
  type: string;
  label?: string;
  placeholder?: string;
  required: boolean;
}

export interface FormInfo {
  action?: string;
  method: string;
  fields: FormField[];
}

export interface HeadingInfo {
  level: number;
  text: string;
}

export interface NavigationInfo {
  links: { text: string; href?: string }[];
}

export interface DomSnapshot {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  forms: FormInfo[];
  headings: HeadingInfo[];
  navigation: NavigationInfo[];
}

/** Options for getDomSnapshot */
export interface DomSnapshotOptions {
  /** Output format: 'yaml' (compact ARIA snapshot, default) or 'json' (verbose legacy format) */
  format?: 'yaml' | 'json';
  /** Maximum tree depth to return (default: unlimited). Only applies to 'yaml' format. */
  maxDepth?: number;
}

/** Result type for YAML format DOM snapshot */
export interface DomSnapshotYaml {
  url: string;
  title: string;
  snapshot: string;
}

const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_FORMS = 20;
const MAX_HEADINGS = 50;
const MAX_NAV_LINKS = 100;

/**
 * Add element refs [ref=eN] to ARIA snapshot YAML lines.
 * Only adds refs to actual elements (roles), not to attribute lines (e.g., /placeholder, /url).
 * Also optionally limits depth based on indentation.
 */
function addElementRefs(yaml: string, maxDepth?: number): string {
  let refCounter = 1;
  const lines = yaml.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) {
      result.push(line);
      continue;
    }

    // Calculate depth based on leading spaces (2 spaces = 1 level of depth)
    const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
    const depth = Math.floor(leadingSpaces / 2);

    // If maxDepth is specified and we exceed it, skip this line
    if (maxDepth !== undefined && depth > maxDepth) {
      continue;
    }

    // Check if line represents an element (starts with "- " after indentation)
    const trimmed = line.trimStart();
    if (trimmed.startsWith('- ')) {
      // Skip attribute lines (start with "- /") - these are ARIA attributes, not elements
      // e.g., "- /placeholder: Enter email" or "- /url: /home"
      if (trimmed.startsWith('- /')) {
        result.push(line);
        continue;
      }

      const ref = `[ref=e${refCounter++}]`;
      // Insert ref before colon (if present) or at the end of the element name
      if (trimmed.includes(':')) {
        // Element has children or inline text, insert ref before the colon
        const colonIndex = line.indexOf(':');
        const modified = line.slice(0, colonIndex) + ` ${ref}` + line.slice(colonIndex);
        result.push(modified);
      } else {
        // Element is a leaf, append ref at the end
        result.push(`${line} ${ref}`);
      }
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Get a DOM snapshot in compact YAML format (default) or verbose JSON format.
 *
 * YAML format uses Playwright's built-in ARIA snapshot - a hierarchical accessibility tree
 * that's ~70-80% smaller than JSON and optimized for LLM consumption.
 *
 * Each element has a [ref=eN] that can be used to target it in subsequent actions.
 *
 * @param sessionId - Browser session ID
 * @param options - Optional configuration (format, maxDepth)
 * @returns YAML string with refs (format='yaml') or DomSnapshot object (format='json')
 */
export async function getDomSnapshot(
  sessionId: string,
  options: DomSnapshotOptions = {}
): Promise<DomSnapshot | DomSnapshotYaml> {
  const { format = 'yaml', maxDepth } = options;
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const { page } = session;
  const url = page.url();
  const title = await page.title();

  // YAML format: Use Playwright's built-in ARIA snapshot
  if (format === 'yaml') {
    // Get the ARIA snapshot from the body element
    const ariaSnapshot = await page.locator('body').ariaSnapshot();

    // Add element refs and optionally limit depth
    const snapshotWithRefs = addElementRefs(ariaSnapshot, maxDepth);

    session.actions.push({
      timestamp: Date.now(),
      action: 'get_dom_snapshot',
      details: {
        url,
        format: 'yaml',
        maxDepth,
        snapshotLength: snapshotWithRefs.length,
      },
    });

    return {
      url,
      title,
      snapshot: snapshotWithRefs,
    };
  }

  // JSON format: Use existing verbose implementation for backwards compatibility
  const snapshot = await page.evaluate(
    ({ maxElements, maxForms, maxHeadings, maxNavLinks }) => {
      // Helper: check if element is visible
      function isElementVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      // Helper: infer role from element
      function inferRole(el: Element): string {
        const role = el.getAttribute('role');
        if (role) return role;
        const tag = el.tagName.toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a') return 'link';
        if (tag === 'input') {
          const type = (el as HTMLInputElement).type || 'text';
          if (type === 'submit' || type === 'button') return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return 'textbox';
        }
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return 'button';
        return 'generic';
      }

      // Helper: find label for form element
      function findLabel(el: Element): string | undefined {
        // Check for aria-label
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;

        // Check for associated label by id
        const id = el.getAttribute('id');
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) return label.textContent?.trim();
        }

        // Check for parent label
        const parentLabel = el.closest('label');
        if (parentLabel) {
          return parentLabel.textContent?.trim();
        }

        // Check for aria-labelledby
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) return labelEl.textContent?.trim();
        }

        return undefined;
      }

      // Helper: build target hint for an element
      function buildTargetHint(el: Element): {
        kind: string;
        selector?: string;
        text?: string;
        role?: string;
        name?: string;
        id?: string;
        exact?: boolean;
      } {
        const role = inferRole(el);
        const ariaLabel = el.getAttribute('aria-label');
        const placeholder = el.getAttribute('placeholder');
        const visibleText = el.textContent?.trim().slice(0, 100) || '';
        const id = el.getAttribute('id');
        const testId = el.getAttribute('data-testid');

        // Prefer role + accessible name
        if (role && role !== 'generic' && (ariaLabel || visibleText)) {
          return {
            kind: 'role',
            role,
            name: ariaLabel || visibleText,
            exact: true,
          };
        }

        // Placeholder for inputs
        if (placeholder) {
          return { kind: 'placeholder', text: placeholder, exact: true };
        }

        // Text for short visible text
        if (visibleText && visibleText.length < 80) {
          return { kind: 'text', text: visibleText, exact: true };
        }

        // TestId
        if (testId) {
          return { kind: 'testId', id: testId };
        }

        // ID selector
        if (id) {
          return { kind: 'css', selector: `#${id}` };
        }

        // Fallback to tag-based CSS
        return { kind: 'css', selector: el.tagName.toLowerCase() };
      }

      const result: {
        title: string;
        interactiveElements: Array<{
          index: number;
          tagName: string;
          role: string;
          text: string;
          ariaLabel?: string;
          placeholder?: string;
          href?: string;
          type?: string;
          name?: string;
          id?: string;
          isVisible: boolean;
          target: ReturnType<typeof buildTargetHint>;
        }>;
        forms: Array<{
          action?: string;
          method: string;
          fields: Array<{
            name?: string;
            type: string;
            label?: string;
            placeholder?: string;
            required: boolean;
          }>;
        }>;
        headings: Array<{ level: number; text: string }>;
        navigation: Array<{ links: Array<{ text: string; href?: string }> }>;
      } = {
        title: document.title,
        interactiveElements: [],
        forms: [],
        headings: [],
        navigation: [],
      };

      // Extract interactive elements
      const interactiveSelector =
        'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="combobox"], [onclick], [tabindex]:not([tabindex="-1"])';
      const interactives = document.querySelectorAll(interactiveSelector);
      let index = 0;
      for (const el of interactives) {
        if (index >= maxElements) break;
        if (!isElementVisible(el)) continue;

        const tagName = el.tagName.toLowerCase();
        const role = inferRole(el);
        const text = el.textContent?.trim().slice(0, 100) || '';
        const ariaLabel = el.getAttribute('aria-label') || undefined;
        const placeholder = el.getAttribute('placeholder') || undefined;
        const href = el.getAttribute('href') || undefined;
        const type = el.getAttribute('type') || undefined;
        const name = el.getAttribute('name') || undefined;
        const id = el.getAttribute('id') || undefined;
        const target = buildTargetHint(el);

        result.interactiveElements.push({
          index,
          tagName,
          role,
          text,
          ariaLabel,
          placeholder,
          href,
          type,
          name,
          id,
          isVisible: true,
          target,
        });
        index++;
      }

      // Extract forms
      const forms = document.querySelectorAll('form');
      let formCount = 0;
      for (const form of forms) {
        if (formCount >= maxForms) break;

        const action = form.getAttribute('action') || undefined;
        const method = (form.getAttribute('method') || 'GET').toUpperCase();
        const fields: Array<{
          name?: string;
          type: string;
          label?: string;
          placeholder?: string;
          required: boolean;
        }> = [];

        const formFields = form.querySelectorAll('input, select, textarea');
        for (const field of formFields) {
          const fieldName = field.getAttribute('name') || undefined;
          const fieldType = field.getAttribute('type') || field.tagName.toLowerCase();
          const label = findLabel(field);
          const placeholder = field.getAttribute('placeholder') || undefined;
          const required = field.hasAttribute('required');

          fields.push({
            name: fieldName,
            type: fieldType,
            label,
            placeholder,
            required,
          });
        }

        result.forms.push({ action, method, fields });
        formCount++;
      }

      // Extract headings
      const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      let headingCount = 0;
      for (const h of headings) {
        if (headingCount >= maxHeadings) break;
        const level = parseInt(h.tagName[1], 10);
        const text = h.textContent?.trim().slice(0, 200) || '';
        if (text) {
          result.headings.push({ level, text });
          headingCount++;
        }
      }

      // Extract navigation
      const navs = document.querySelectorAll('nav, [role="navigation"]');
      for (const nav of navs) {
        const links: Array<{ text: string; href?: string }> = [];
        const anchors = nav.querySelectorAll('a');
        for (const a of anchors) {
          if (links.length >= maxNavLinks) break;
          const text = a.textContent?.trim() || '';
          const href = a.getAttribute('href') || undefined;
          if (text) {
            links.push({ text, href });
          }
        }
        if (links.length > 0) {
          result.navigation.push({ links });
        }
      }

      return result;
    },
    {
      maxElements: MAX_INTERACTIVE_ELEMENTS,
      maxForms: MAX_FORMS,
      maxHeadings: MAX_HEADINGS,
      maxNavLinks: MAX_NAV_LINKS,
    }
  );

  session.actions.push({
    timestamp: Date.now(),
    action: 'get_dom_snapshot',
    details: {
      url,
      format: 'json',
      interactiveCount: snapshot.interactiveElements.length,
      formCount: snapshot.forms.length,
      headingCount: snapshot.headings.length,
      navCount: snapshot.navigation.length,
    },
  });

  return {
    url,
    title: snapshot.title,
    interactiveElements: snapshot.interactiveElements as InteractiveElement[],
    forms: snapshot.forms,
    headings: snapshot.headings,
    navigation: snapshot.navigation,
  };
}
