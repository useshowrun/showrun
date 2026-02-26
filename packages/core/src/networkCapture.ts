/**
 * Network capture for Playwright page sessions.
 * Hooks request/response, maintains a rolling buffer with size limits.
 * Full request headers kept in-memory for replay only; redacted everywhere else.
 */

import { gunzipSync } from 'zlib';
import type { Page } from 'playwright';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

const POST_DATA_TRUNCATE = 64 * 1024; // 64KB
const RESPONSE_BODY_MAX_STORE_BYTES = 5 * 1024 * 1024; // 5MB - full body stored when under this (for replay, extract, responseContains)
const NETWORK_BUFFER_MAX_ENTRIES = 300;
const NETWORK_BUFFER_MAX_BYTES = 50 * 1024 * 1024; // 50MB - rolling buffer cap so we can keep more large responses

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    out[k] = SENSITIVE_HEADER_NAMES.has(lower) ? '[REDACTED]' : v;
  }
  return out;
}

function isTextOrJsonContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return (
    lower.includes('application/json') ||
    lower.includes('+json') ||
    lower.includes('text/')
  );
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function isGzip(body: Buffer): boolean {
  return body.length >= 2 && body[0] === GZIP_MAGIC[0] && body[1] === GZIP_MAGIC[1];
}

/** Decompress gzip if needed; returns body unchanged if not gzip */
function maybeDecompress(body: Buffer): Buffer {
  if (isGzip(body)) {
    try {
      return gunzipSync(body);
    } catch {
      return body;
    }
  }
  return body;
}

/** True if buffer looks like JSON (starts with { or [), for responses with missing Content-Type */
function looksLikeJson(body: Buffer): boolean {
  const len = body.length;
  if (len === 0) return false;
  let i = 0;
  while (i < len && (body[i] === 0x20 || body[i] === 0x0a || body[i] === 0x0d || body[i] === 0x09)) i++;
  if (i >= len) return false;
  const first = body[i];
  return first === 0x7b || first === 0x5b; // { or [
}

export interface NetworkEntryInternal {
  id: string;
  ts: number;
  method: string;
  url: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  /** Full request headers in-memory for replay only; never expose */
  requestHeadersFull: Record<string, string>;
  postData?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  contentType?: string;
  responseBodyText?: string;
  responseBodyBase64?: string;
  /** Approximate bytes used by this entry (for memory cap) */
  bytesEstimate: number;
}

/** Redacted entry for list/get/API/MCP - no full headers, no large bodies */
export interface NetworkEntrySummary {
  id: string;
  ts: number;
  method: string;
  url: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  contentType?: string;
  /** First 2KB of response body if text; never full body in summary */
  responseBodySnippet?: string;
  responseBodyAvailable?: boolean;
}

export interface NetworkFindWhere {
  urlIncludes?: string;
  urlRegex?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  status?: number;
  contentTypeIncludes?: string;
  /** Response body (text) must contain this string. Only entries with captured response body text are considered. */
  responseContains?: string;
}

export interface NetworkReplayOverrides {
  url?: string;
  setQuery?: Record<string, string | number>;
  setHeaders?: Record<string, string>;
  body?: string;
  /** Regex find/replace on the captured request URL (applied before overrides.url). Replace string can use $1, $2 for capture groups. Accepts single object or array. */
  urlReplace?: { find: string; replace: string } | Array<{ find: string; replace: string }>;
  /** Regex find/replace on the captured request body (applied before overrides.body). Replace string can use $1, $2 for capture groups. Accepts single object or array. */
  bodyReplace?: { find: string; replace: string } | Array<{ find: string; replace: string }>;
}

/**
 * Serializable network entry for caching (without Playwright-specific internals)
 */
export interface NetworkEntrySerializable {
  id: string;
  ts: number;
  method: string;
  url: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  requestHeadersFull: Record<string, string>;
  postData?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  contentType?: string;
  responseBodyText?: string;
  responseBodyBase64?: string;
}

export interface NetworkCaptureApi {
  list(limit?: number, filter?: 'all' | 'api' | 'xhr'): NetworkEntrySummary[];
  get(requestId: string): NetworkEntrySummary | null;
  find(where: NetworkFindWhere, pick: 'first' | 'last'): NetworkEntrySummary | null;
  replay(
    requestId: string,
    overrides?: NetworkReplayOverrides
  ): Promise<{ status: number; contentType?: string; body: string; bodySize: number }>;
  clear(): void;
  /** Get request ID from buffer by index (for find) */
  getRequestIdByIndex(where: NetworkFindWhere, pick: 'first' | 'last'): string | null;
  /** Export a network entry by ID for caching/serialization */
  exportEntry(requestId: string): NetworkEntrySerializable | null;
  /** Import a previously exported network entry into the buffer */
  importEntry(entry: NetworkEntrySerializable): void;
  /** Get the captured response body for a request ID (no replay/re-fetch) */
  getResponseBody(requestId: string): { status: number; contentType?: string; body: string; bodySize: number } | null;
}

let idCounter = 0;

function nextId(): string {
  return `req-${++idCounter}-${Date.now()}`;
}

function truncatePostData(raw: string | undefined | null): string | undefined {
  if (raw == null || raw === '') return undefined;
  if (raw.length > POST_DATA_TRUNCATE) {
    return raw.slice(0, POST_DATA_TRUNCATE) + '...[truncated]';
  }
  return raw;
}

/**
 * Attach network capture to a Playwright page and return the capture API.
 * Full request headers are kept in-memory only for replay; list/get return redacted summaries.
 */
export function attachNetworkCapture(page: Page): NetworkCaptureApi {
  const buffer: NetworkEntryInternal[] = [];
  const mapById = new Map<string, NetworkEntryInternal>();
  let totalBytesEstimate = 0;
  const requestToEntry = new Map<object, NetworkEntryInternal>();

  function dropOldest(): void {
    while (
      (buffer.length >= NETWORK_BUFFER_MAX_ENTRIES || totalBytesEstimate > NETWORK_BUFFER_MAX_BYTES) &&
      buffer.length > 0
    ) {
      const removed = buffer.shift()!;
      mapById.delete(removed.id);
      totalBytesEstimate -= removed.bytesEstimate;
    }
  }

  function entryToSummary(entry: NetworkEntryInternal): NetworkEntrySummary {
    const snippet =
      entry.responseBodyText != null
        ? entry.responseBodyText.slice(0, 2048)
        : entry.responseBodyBase64
          ? '[binary]'
          : undefined;
    return {
      id: entry.id,
      ts: entry.ts,
      method: entry.method,
      url: entry.url,
      resourceType: entry.resourceType,
      requestHeaders: redactHeaders(entry.requestHeadersFull),
      postData: entry.postData,
      status: entry.status,
      responseHeaders: entry.responseHeaders,
      contentType: entry.contentType,
      responseBodySnippet: snippet,
      responseBodyAvailable:
        entry.responseBodyText != null || entry.responseBodyBase64 != null,
    };
  }

  function matchesWhere(entry: NetworkEntryInternal, where: NetworkFindWhere): boolean {
    if (where.urlIncludes != null && !entry.url.toLowerCase().includes(where.urlIncludes.toLowerCase())) return false;
    if (where.urlRegex != null) {
      try {
        const re = new RegExp(where.urlRegex);
        if (!re.test(entry.url)) return false;
      } catch {
        return false;
      }
    }
    if (where.method != null && entry.method !== where.method) return false;
    if (where.status != null && entry.status !== where.status) return false;
    if (
      where.contentTypeIncludes != null &&
      (!entry.contentType || !entry.contentType.toLowerCase().includes(where.contentTypeIncludes.toLowerCase()))
    )
      return false;
    if (where.responseContains != null) {
      let bodyText: string | null = entry.responseBodyText ?? null;
      if (bodyText == null && entry.responseBodyBase64 != null) {
        try {
          const buf = Buffer.from(entry.responseBodyBase64, 'base64');
          const decompressed = maybeDecompress(buf);
          bodyText = decompressed.toString('utf8');
        } catch {
          bodyText = null;
        }
      }
      if (bodyText == null) return false;
      if (!bodyText.toLowerCase().includes(where.responseContains.toLowerCase())) return false;
    }
    return true;
  }

  page.on('request', (request) => {
    const id = nextId();
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();
    const headers = request.headers();
    const headersFull: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      headersFull[k] = v;
    }
    const postData = truncatePostData(request.postData() ?? undefined);

    const entry: NetworkEntryInternal = {
      id,
      ts: Date.now(),
      method,
      url,
      resourceType,
      requestHeaders: redactHeaders(headersFull),
      requestHeadersFull: headersFull,
      postData,
      bytesEstimate: 0,
    };
    entry.bytesEstimate =
      url.length +
      JSON.stringify(entry.requestHeaders).length +
      (postData?.length ?? 0) +
      200;
    requestToEntry.set(request as object, entry);
    mapById.set(id, entry);
    buffer.push(entry);
    totalBytesEstimate += entry.bytesEstimate;
    dropOldest();
  });

  page.on('response', async (response) => {
    const req = response.request();
    const entry = requestToEntry.get(req as object);
    if (!entry) return;

    entry.status = response.status();
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers())) {
      respHeaders[k] = v;
    }
    entry.responseHeaders = redactHeaders(respHeaders);
    const ct = respHeaders['content-type'] ?? respHeaders['Content-Type'];
    entry.contentType = ct;

    try {
      let body = await response.body();
      body = maybeDecompress(body);
      const size = body.length;
      const canStoreAsText = isTextOrJsonContentType(ct) || looksLikeJson(body);
      if (size <= RESPONSE_BODY_MAX_STORE_BYTES && canStoreAsText) {
        const text = body.toString('utf8');
        entry.responseBodyText = text;
        const added = Buffer.byteLength(text, 'utf8');
        entry.bytesEstimate += added;
        totalBytesEstimate += added;
      } else if (size <= RESPONSE_BODY_MAX_STORE_BYTES && body.length > 0) {
        entry.responseBodyBase64 = body.toString('base64');
        const added = Math.ceil((body.length * 4) / 3);
        entry.bytesEstimate += added;
        totalBytesEstimate += added;
      }
    } catch {
      // ignore body read errors
    }
    requestToEntry.delete(req as object);
    dropOldest();
  });

  const api: NetworkCaptureApi = {
    list(limit = 50, filter = 'all') {
      let list = buffer.slice(-limit);
      if (filter === 'api' || filter === 'xhr') {
        list = list.filter(
          (e) =>
            e.resourceType === 'xhr' ||
            e.resourceType === 'fetch' ||
            /\/api\//.test(e.url.toLowerCase()) ||
            /graphql/i.test(e.url)
        );
      }
      return list.map(entryToSummary);
    },

    get(requestId: string) {
      const entry = mapById.get(requestId);
      return entry ? entryToSummary(entry) : null;
    },

    find(where: NetworkFindWhere, pick: 'first' | 'last') {
      const id = api.getRequestIdByIndex(where, pick);
      return id ? api.get(id)! : null;
    },

    getRequestIdByIndex(where: NetworkFindWhere, pick: 'first' | 'last'): string | null {
      const matches: NetworkEntryInternal[] = [];
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (matchesWhere(buffer[i], where)) matches.push(buffer[i]);
      }
      if (pick === 'last') {
        // last = most recent = first in our reversed list
        return matches.length > 0 ? matches[0].id : null;
      }
      // first = oldest match
      return matches.length > 0 ? matches[matches.length - 1].id : null;
    },

    async replay(
      requestId: string,
      overrides?: NetworkReplayOverrides
    ): Promise<{ status: number; contentType?: string; body: string; bodySize: number }> {
      const entry = mapById.get(requestId);
      if (!entry) {
        throw new Error(`Request not found: ${requestId}`);
      }

      if (overrides?.setHeaders) {
        for (const k of Object.keys(overrides.setHeaders)) {
          if (SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) {
            throw new Error(`Cannot set sensitive header: ${k}`);
          }
        }
      }

      // Playwright: page.request is APIRequestContext sharing cookies with the browser context
      const requestContext = (page as { request?: { fetch: (url: string, options?: object) => Promise<{ status: () => number; headers: () => Record<string, string>; body: () => Promise<Buffer> }> } }).request;
      if (!requestContext || typeof requestContext.fetch !== 'function') {
        throw new Error(
          'Browser context does not support API request (replay). Playwright version may be too old.'
        );
      }

      let url = entry.url;
      if (overrides?.urlReplace) {
        // Normalize to array (accepts single object or array)
        const urlReplaces = Array.isArray(overrides.urlReplace) ? overrides.urlReplace : [overrides.urlReplace];
        for (const ur of urlReplaces) {
          try {
            const re = new RegExp(ur.find, 'g');
            url = url.replace(re, ur.replace);
          } catch (e) {
            throw new Error(`overrides.urlReplace.find is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      if (overrides?.url != null) url = overrides.url;

      let body: string | undefined = entry.postData ?? undefined;
      if (body != null && overrides?.bodyReplace) {
        // Normalize to array (accepts single object or array)
        const bodyReplaces = Array.isArray(overrides.bodyReplace) ? overrides.bodyReplace : [overrides.bodyReplace];
        for (const br of bodyReplaces) {
          try {
            const re = new RegExp(br.find, 'g');
            body = body.replace(re, br.replace);
          } catch (e) {
            throw new Error(`overrides.bodyReplace.find is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      if (overrides?.body != null) body = overrides.body;

      const method = entry.method;
      const headers: Record<string, string> = { ...entry.requestHeadersFull };
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
        bodySize <= RESPONSE_BODY_MAX_STORE_BYTES && isTextOrJsonContentType(contentType)
          ? respBody.toString('utf8')
          : respBody.toString('utf8').slice(0, 2048) + (bodySize > 2048 ? '...[truncated]' : '');

      return {
        status: response.status(),
        contentType,
        body: bodyText,
        bodySize,
      };
    },

    clear() {
      buffer.length = 0;
      mapById.clear();
      totalBytesEstimate = 0;
    },

    exportEntry(requestId: string): NetworkEntrySerializable | null {
      const entry = mapById.get(requestId);
      if (!entry) return null;
      return {
        id: entry.id,
        ts: entry.ts,
        method: entry.method,
        url: entry.url,
        resourceType: entry.resourceType,
        requestHeaders: entry.requestHeaders,
        requestHeadersFull: entry.requestHeadersFull,
        postData: entry.postData,
        status: entry.status,
        responseHeaders: entry.responseHeaders,
        contentType: entry.contentType,
        responseBodyText: entry.responseBodyText,
        responseBodyBase64: entry.responseBodyBase64,
      };
    },

    getResponseBody(requestId: string): { status: number; contentType?: string; body: string; bodySize: number } | null {
      const entry = mapById.get(requestId);
      if (!entry) return null;

      let body: string | null = null;
      if (entry.responseBodyText != null) {
        body = entry.responseBodyText;
      } else if (entry.responseBodyBase64 != null) {
        try {
          const buf = Buffer.from(entry.responseBodyBase64, 'base64');
          const decompressed = maybeDecompress(buf);
          body = decompressed.toString('utf8');
        } catch {
          return null;
        }
      }

      if (body == null) return null;

      return {
        status: entry.status ?? 0,
        contentType: entry.contentType,
        body,
        bodySize: Buffer.byteLength(body, 'utf8'),
      };
    },

    importEntry(entry: NetworkEntrySerializable): void {
      // Skip if entry already exists
      if (mapById.has(entry.id)) return;

      const internal: NetworkEntryInternal = {
        id: entry.id,
        ts: entry.ts,
        method: entry.method,
        url: entry.url,
        resourceType: entry.resourceType,
        requestHeaders: entry.requestHeaders,
        requestHeadersFull: entry.requestHeadersFull,
        postData: entry.postData,
        status: entry.status,
        responseHeaders: entry.responseHeaders,
        contentType: entry.contentType,
        responseBodyText: entry.responseBodyText,
        responseBodyBase64: entry.responseBodyBase64,
        bytesEstimate: 0,
      };

      // Calculate bytes estimate
      internal.bytesEstimate =
        entry.url.length +
        JSON.stringify(entry.requestHeaders).length +
        (entry.postData?.length ?? 0) +
        (entry.responseBodyText ? Buffer.byteLength(entry.responseBodyText, 'utf8') : 0) +
        (entry.responseBodyBase64 ? Math.ceil((entry.responseBodyBase64.length * 3) / 4) : 0) +
        200;

      mapById.set(entry.id, internal);
      buffer.push(internal);
      totalBytesEstimate += internal.bytesEstimate;
      dropOldest();
    },
  };

  return api;
}
