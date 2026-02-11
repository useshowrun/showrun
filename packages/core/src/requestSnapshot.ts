/**
 * Request Snapshot types and utilities.
 *
 * Snapshots record the HTTP request/response details of `network_replay` steps
 * so they can be replayed at runtime via direct HTTP calls — no browser needed.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { resolveTemplate } from './dsl/templating.js';
import type { VariableContext } from './dsl/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestSnapshot {
  stepId: string;
  capturedAt: number;
  /** TTL in milliseconds. null = indefinite (never expires by default). */
  ttl: number | null;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
  };
  overrides?: {
    /** Direct URL override (replaces the snapshot's request URL entirely). */
    url?: string;
    /** Direct body override (replaces the snapshot's request body entirely). */
    body?: string;
    setQuery?: Record<string, string>;
    setHeaders?: Record<string, string>;
    urlReplace?: Array<{ find: string; replace: string }>;
    bodyReplace?: Array<{ find: string; replace: string }>;
  };
  responseValidation: {
    expectedStatus: number;
    expectedContentType: string;
    /** Top-level JSON keys expected in the response body. */
    expectedKeys: string[];
  };
  /** Header names that contain auth data (e.g. authorization, cookie). */
  sensitiveHeaders: string[];
}

export interface SnapshotFile {
  version: 1;
  snapshots: Record<string, RequestSnapshot>;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * Check if a snapshot is stale based on its TTL.
 * Returns false when `ttl` is null (indefinite).
 */
export function isSnapshotStale(snapshot: RequestSnapshot): boolean {
  if (snapshot.ttl === null) return false;
  return Date.now() - snapshot.capturedAt > snapshot.ttl;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate an HTTP response against a snapshot's expected shape.
 */
export function validateResponse(
  snapshot: RequestSnapshot,
  response: { status: number; contentType?: string; body: string },
): ValidationResult {
  const v = snapshot.responseValidation;

  if (response.status !== v.expectedStatus) {
    return {
      valid: false,
      reason: `Expected status ${v.expectedStatus}, got ${response.status}`,
    };
  }

  if (
    v.expectedContentType &&
    response.contentType &&
    !response.contentType.toLowerCase().startsWith(v.expectedContentType.toLowerCase())
  ) {
    return {
      valid: false,
      reason: `Expected content-type starting with "${v.expectedContentType}", got "${response.contentType}"`,
    };
  }

  if (v.expectedKeys.length > 0) {
    try {
      const parsed = JSON.parse(response.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const bodyKeys = Object.keys(parsed);
        const missing = v.expectedKeys.filter((k) => !bodyKeys.includes(k));
        if (missing.length > 0) {
          return {
            valid: false,
            reason: `Missing expected keys: ${missing.join(', ')}`,
          };
        }
      }
    } catch {
      // If we expected JSON keys but can't parse, that's a validation failure
      return {
        valid: false,
        reason: 'Response body is not valid JSON but expectedKeys were specified',
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Override application
// ---------------------------------------------------------------------------

/**
 * Resolve a template string using Nunjucks (same engine as the DSL interpreter).
 * Supports {{inputs.x}}, {{vars.x}}, {{secret.x}} and filters like `| urlencode`.
 */
function resolveTemplateValue(
  template: string,
  ctx: VariableContext,
): string {
  return resolveTemplate(template, ctx);
}

/**
 * Apply overrides from the snapshot to produce the final request parameters.
 * Template expressions ({{inputs.x}}, {{vars.y}}, {{secret.z}}) are resolved
 * using Nunjucks — the same engine as the DSL interpreter, including filters.
 */
export function applyOverrides(
  snapshot: RequestSnapshot,
  inputs: Record<string, unknown>,
  vars: Record<string, unknown>,
  secrets?: Record<string, string>,
): { url: string; method: string; headers: Record<string, string>; body: string | null } {
  const ov = snapshot.overrides;
  let url = snapshot.request.url;
  let body = snapshot.request.body;
  const method = snapshot.request.method;
  const headers = { ...snapshot.request.headers };

  if (!ov) {
    return { url, method, headers, body };
  }

  const ctx: VariableContext = { inputs, vars, secrets: secrets ?? {} };

  // urlReplace
  if (ov.urlReplace) {
    for (const r of ov.urlReplace) {
      const find = resolveTemplateValue(r.find, ctx);
      const replace = resolveTemplateValue(r.replace, ctx);
      try {
        url = url.replace(new RegExp(find, 'g'), replace);
      } catch {
        // If regex is invalid, try literal replace
        url = url.split(find).join(replace);
      }
    }
  }

  // setQuery
  if (ov.setQuery) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(ov.setQuery)) {
      const resolved = resolveTemplateValue(v, ctx);
      u.searchParams.set(k, resolved);
    }
    url = u.toString();
  }

  // setHeaders
  if (ov.setHeaders) {
    for (const [k, v] of Object.entries(ov.setHeaders)) {
      headers[k] = resolveTemplateValue(v, ctx);
    }
  }

  // Direct URL override (applied after urlReplace, matching networkCapture.ts)
  if (ov.url != null) {
    url = resolveTemplateValue(ov.url, ctx);
  }

  // bodyReplace
  if (body && ov.bodyReplace) {
    for (const r of ov.bodyReplace) {
      const find = resolveTemplateValue(r.find, ctx);
      const replace = resolveTemplateValue(r.replace, ctx);
      try {
        body = body.replace(new RegExp(find, 'g'), replace);
      } catch {
        body = body.split(find).join(replace);
      }
    }
  }

  // Direct body override (applied after bodyReplace, matching networkCapture.ts)
  if (ov.body != null) {
    body = resolveTemplateValue(ov.body, ctx);
  }

  return { url, method, headers, body };
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const SNAPSHOTS_FILENAME = 'snapshots.json';

/**
 * Load snapshots.json from a pack directory. Returns null if not found.
 */
export function loadSnapshots(packPath: string): SnapshotFile | null {
  const filePath = join(packPath, SNAPSHOTS_FILENAME);
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as SnapshotFile;
    if (data.version !== 1) {
      console.warn(`[requestSnapshot] Unsupported snapshot version: ${data.version}`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(
      `[requestSnapshot] Failed to load snapshots.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Write snapshots.json to a pack directory.
 */
export function writeSnapshots(packPath: string, snapshots: SnapshotFile): void {
  const filePath = join(packPath, SNAPSHOTS_FILENAME);
  writeFileSync(filePath, JSON.stringify(snapshots, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

const SENSITIVE_HEADER_NAMES = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];

/**
 * Extract top-level keys from a JSON string. Returns empty array on parse failure.
 */
export function extractTopLevelKeys(jsonText: string | undefined | null): string[] {
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Detect which headers in a record are sensitive (contain auth data).
 */
export function detectSensitiveHeaders(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter((h) => SENSITIVE_HEADER_NAMES.includes(h.toLowerCase()));
}
