/**
 * HTTP-only execution engine for request snapshots.
 *
 * When every `network_replay` step in a flow has a valid snapshot and no
 * DOM extraction steps exist, the flow can be executed purely via HTTP
 * requests — no browser needed.
 */

import type { DslStep } from './dsl/types.js';
import {
  type RequestSnapshot,
  type SnapshotFile,
  isSnapshotStale,
  validateResponse,
  applyOverrides,
  type ValidationResult,
} from './requestSnapshot.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for HTTP replay requests (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpReplayResult {
  status: number;
  contentType?: string;
  body: string;
  bodySize: number;
}

// ---------------------------------------------------------------------------
// HTTP-only compatibility check
// ---------------------------------------------------------------------------

/** Step types that require DOM access for data extraction (force browser mode). */
const DOM_EXTRACTION_STEPS = new Set(['extract_text', 'extract_title', 'extract_attribute']);

/**
 * Check whether a flow can run in HTTP-only mode.
 *
 * Requirements:
 * 1. Every `network_replay` step has a corresponding, non-stale snapshot.
 * 2. No DOM extraction steps exist in the flow.
 */
export function isFlowHttpCompatible(
  steps: DslStep[],
  snapshots: SnapshotFile | null,
): boolean {
  if (!snapshots) return false;

  // Check for DOM extraction steps
  for (const step of steps) {
    if (DOM_EXTRACTION_STEPS.has(step.type)) {
      return false;
    }
  }

  // Check that every network_replay step has a valid snapshot
  const replaySteps = steps.filter((s) => s.type === 'network_replay');
  if (replaySteps.length === 0) return false; // No point in HTTP mode without replay steps

  for (const step of replaySteps) {
    const snapshot = snapshots.snapshots[step.id];
    if (!snapshot) return false;
    if (isSnapshotStale(snapshot)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// HTTP replay
// ---------------------------------------------------------------------------

/**
 * Make a direct HTTP request using snapshot data + applied overrides.
 * Uses Node's native `fetch()` with an AbortController timeout.
 */
export async function replayFromSnapshot(
  snapshot: RequestSnapshot,
  inputs: Record<string, unknown>,
  vars: Record<string, unknown>,
  options?: { secrets?: Record<string, string>; timeoutMs?: number },
): Promise<HttpReplayResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { url, method, headers, body } = applyOverrides(snapshot, inputs, vars, options?.secrets);

  // Remove content-length — the snapshot captures the original request's
  // content-length, but overrides may change the body size. Node's fetch()
  // sets the correct content-length automatically from the actual body.
  delete headers['content-length'];
  delete headers['Content-Length'];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  };

  if (body && method !== 'GET' && method !== 'HEAD') {
    fetchOptions.body = body;
  }

  try {
    const response = await fetch(url, fetchOptions);
    const responseBody = await response.text();
    const contentType = response.headers.get('content-type') ?? undefined;

    return {
      status: response.status,
      contentType,
      body: responseBody,
      bodySize: Buffer.byteLength(responseBody, 'utf8'),
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`HTTP replay timed out after ${timeoutMs}ms for ${method} ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replay a snapshot and validate the response.
 * Returns the result along with validation info.
 */
export async function replayAndValidate(
  snapshot: RequestSnapshot,
  inputs: Record<string, unknown>,
  vars: Record<string, unknown>,
  options?: { secrets?: Record<string, string>; timeoutMs?: number },
): Promise<{ result: HttpReplayResult; validation: ValidationResult }> {
  const result = await replayFromSnapshot(snapshot, inputs, vars, options);
  const validation = validateResponse(snapshot, result);
  return { result, validation };
}
