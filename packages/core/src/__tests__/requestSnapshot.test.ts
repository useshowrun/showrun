import { describe, it, expect } from 'vitest';
import {
  isSnapshotStale,
  validateResponse,
  applyOverrides,
  extractTopLevelKeys,
  detectSensitiveHeaders,
  type RequestSnapshot,
} from '../requestSnapshot.js';

function makeSnapshot(overrides?: Partial<RequestSnapshot>): RequestSnapshot {
  return {
    stepId: 'test_step',
    capturedAt: Date.now(),
    ttl: null,
    request: {
      method: 'GET',
      url: 'https://api.example.com/data',
      headers: { 'content-type': 'application/json' },
      body: null,
    },
    responseValidation: {
      expectedStatus: 200,
      expectedContentType: 'application/json',
      expectedKeys: ['results', 'total'],
    },
    sensitiveHeaders: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSnapshotStale
// ---------------------------------------------------------------------------

describe('isSnapshotStale', () => {
  it('returns false when ttl is null (indefinite)', () => {
    const snap = makeSnapshot({ ttl: null });
    expect(isSnapshotStale(snap)).toBe(false);
  });

  it('returns false when ttl has not expired', () => {
    const snap = makeSnapshot({ capturedAt: Date.now(), ttl: 60_000 });
    expect(isSnapshotStale(snap)).toBe(false);
  });

  it('returns true when ttl has expired', () => {
    const snap = makeSnapshot({
      capturedAt: Date.now() - 120_000,
      ttl: 60_000,
    });
    expect(isSnapshotStale(snap)).toBe(true);
  });

  it('returns true when capturedAt is far in the past', () => {
    const snap = makeSnapshot({
      capturedAt: 0,
      ttl: 1000,
    });
    expect(isSnapshotStale(snap)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateResponse
// ---------------------------------------------------------------------------

describe('validateResponse', () => {
  it('passes for matching response', () => {
    const snap = makeSnapshot();
    const response = {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ results: [1, 2], total: 2 }),
    };
    expect(validateResponse(snap, response)).toEqual({ valid: true });
  });

  it('fails on mismatched status', () => {
    const snap = makeSnapshot();
    const response = {
      status: 403,
      contentType: 'application/json',
      body: '{}',
    };
    const result = validateResponse(snap, response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Expected status 200');
  });

  it('fails on mismatched content type', () => {
    const snap = makeSnapshot();
    const response = {
      status: 200,
      contentType: 'text/html',
      body: '<html></html>',
    };
    const result = validateResponse(snap, response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('content-type');
  });

  it('fails on missing expected keys', () => {
    const snap = makeSnapshot();
    const response = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [] }),
    };
    const result = validateResponse(snap, response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('total');
  });

  it('passes when expectedKeys is empty', () => {
    const snap = makeSnapshot({
      responseValidation: {
        expectedStatus: 200,
        expectedContentType: 'application/json',
        expectedKeys: [],
      },
    });
    const response = {
      status: 200,
      contentType: 'application/json',
      body: '{"anything": true}',
    };
    expect(validateResponse(snap, response)).toEqual({ valid: true });
  });

  it('passes when contentType is undefined (no check)', () => {
    const snap = makeSnapshot();
    const response = {
      status: 200,
      contentType: undefined,
      body: JSON.stringify({ results: [], total: 0 }),
    };
    expect(validateResponse(snap, response)).toEqual({ valid: true });
  });

  it('fails when JSON parsing fails but expectedKeys are set', () => {
    const snap = makeSnapshot();
    const response = {
      status: 200,
      contentType: 'application/json',
      body: 'not json',
    };
    const result = validateResponse(snap, response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// applyOverrides
// ---------------------------------------------------------------------------

describe('applyOverrides', () => {
  it('returns original request when no overrides', () => {
    const snap = makeSnapshot();
    const result = applyOverrides(snap, {}, {});
    expect(result.url).toBe('https://api.example.com/data');
    expect(result.method).toBe('GET');
    expect(result.body).toBeNull();
  });

  it('applies setQuery overrides with template resolution', () => {
    const snap = makeSnapshot({
      overrides: {
        setQuery: { batch: '{{inputs.batch}}' },
      },
    });
    const result = applyOverrides(snap, { batch: 'W24' }, {});
    expect(result.url).toContain('batch=W24');
  });

  it('applies setHeaders overrides', () => {
    const snap = makeSnapshot({
      overrides: {
        setHeaders: { 'x-custom': '{{vars.token}}' },
      },
    });
    const result = applyOverrides(snap, {}, { token: 'abc123' });
    expect(result.headers['x-custom']).toBe('abc123');
  });

  it('applies urlReplace overrides', () => {
    const snap = makeSnapshot({
      request: {
        method: 'GET',
        url: 'https://api.example.com/v1/items',
        headers: {},
        body: null,
      },
      overrides: {
        urlReplace: [{ find: 'v1', replace: 'v2' }],
      },
    });
    const result = applyOverrides(snap, {}, {});
    expect(result.url).toBe('https://api.example.com/v2/items');
  });

  it('applies bodyReplace overrides with template', () => {
    const snap = makeSnapshot({
      request: {
        method: 'POST',
        url: 'https://api.example.com/search',
        headers: { 'content-type': 'application/json' },
        body: '{"query":"W24"}',
      },
      overrides: {
        bodyReplace: [{ find: 'W24', replace: '{{inputs.batch}}' }],
      },
    });
    const result = applyOverrides(snap, { batch: 'S25' }, {});
    expect(result.body).toBe('{"query":"S25"}');
  });

  it('applies multiple overrides in order', () => {
    const snap = makeSnapshot({
      request: {
        method: 'POST',
        url: 'https://api.example.com/search?page=1',
        headers: { 'content-type': 'application/json' },
        body: '{"batch":"W24"}',
      },
      overrides: {
        setQuery: { page: '{{inputs.page}}' },
        bodyReplace: [{ find: 'W24', replace: '{{inputs.batch}}' }],
      },
    });
    const result = applyOverrides(snap, { batch: 'S25', page: '2' }, {});
    expect(result.url).toContain('page=2');
    expect(result.body).toBe('{"batch":"S25"}');
  });

  it('applies direct url override (after urlReplace)', () => {
    const snap = makeSnapshot({
      request: {
        method: 'GET',
        url: 'https://api.example.com/v1/items',
        headers: {},
        body: null,
      },
      overrides: {
        url: 'https://api.example.com/{{vars.version}}/items',
      },
    });
    const result = applyOverrides(snap, {}, { version: 'v3' });
    expect(result.url).toBe('https://api.example.com/v3/items');
  });

  it('applies direct body override (after bodyReplace)', () => {
    const snap = makeSnapshot({
      request: {
        method: 'POST',
        url: 'https://api.example.com/search',
        headers: { 'content-type': 'application/json' },
        body: '{"old":"data"}',
      },
      overrides: {
        body: '{"query":"{{inputs.query}}"}',
      },
    });
    const result = applyOverrides(snap, { query: 'test' }, {});
    expect(result.body).toBe('{"query":"test"}');
  });

  it('direct url override takes precedence over urlReplace', () => {
    const snap = makeSnapshot({
      request: {
        method: 'GET',
        url: 'https://api.example.com/v1/items',
        headers: {},
        body: null,
      },
      overrides: {
        urlReplace: [{ find: 'v1', replace: 'v2' }],
        url: 'https://override.example.com/items',
      },
    });
    const result = applyOverrides(snap, {}, {});
    expect(result.url).toBe('https://override.example.com/items');
  });

  it('resolves Nunjucks filters like | urlencode in templates', () => {
    const snap = makeSnapshot({
      request: {
        method: 'POST',
        url: 'https://api.example.com/search',
        headers: { 'content-type': 'application/json' },
        body: '{"query":"placeholder"}',
      },
      overrides: {
        body: '{"batch":"{{inputs.batch | urlencode}}"}',
      },
    });
    const result = applyOverrides(snap, { batch: 'Winter 2025' }, {});
    expect(result.body).toBe('{"batch":"Winter%202025"}');
  });

  it('resolves secrets in templates', () => {
    const snap = makeSnapshot({
      overrides: {
        setHeaders: { 'x-api-key': '{{secret.API_KEY}}' },
      },
    });
    const result = applyOverrides(snap, {}, {}, { API_KEY: 'my-secret-key' });
    expect(result.headers['x-api-key']).toBe('my-secret-key');
  });
});

// ---------------------------------------------------------------------------
// extractTopLevelKeys
// ---------------------------------------------------------------------------

describe('extractTopLevelKeys', () => {
  it('extracts keys from JSON object', () => {
    const keys = extractTopLevelKeys('{"a":1,"b":2,"c":3}');
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('returns empty for JSON array', () => {
    expect(extractTopLevelKeys('[1,2,3]')).toEqual([]);
  });

  it('returns empty for invalid JSON', () => {
    expect(extractTopLevelKeys('not json')).toEqual([]);
  });

  it('returns empty for null/undefined', () => {
    expect(extractTopLevelKeys(null)).toEqual([]);
    expect(extractTopLevelKeys(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectSensitiveHeaders
// ---------------------------------------------------------------------------

describe('detectSensitiveHeaders', () => {
  it('detects authorization header', () => {
    const result = detectSensitiveHeaders({
      Authorization: 'Bearer token',
      'content-type': 'application/json',
    });
    expect(result).toContain('Authorization');
    expect(result).not.toContain('content-type');
  });

  it('detects cookie header (case-insensitive)', () => {
    const result = detectSensitiveHeaders({
      cookie: 'session=abc',
    });
    expect(result).toContain('cookie');
  });

  it('returns empty for no sensitive headers', () => {
    const result = detectSensitiveHeaders({
      'content-type': 'text/html',
      accept: '*/*',
    });
    expect(result).toEqual([]);
  });
});
