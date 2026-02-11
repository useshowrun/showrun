import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isFlowHttpCompatible, replayFromSnapshot } from '../httpReplay.js';
import type { DslStep, NetworkReplayStep, NetworkFindStep, NavigateStep, SetVarStep, ExtractTextStep, SleepStep, NetworkExtractStep } from '../dsl/types.js';
import type { SnapshotFile, RequestSnapshot } from '../requestSnapshot.js';

function makeSnapshotFile(stepIds: string[]): SnapshotFile {
  const snapshots: Record<string, RequestSnapshot> = {};
  for (const id of stepIds) {
    snapshots[id] = {
      stepId: id,
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
        expectedKeys: [],
      },
      sensitiveHeaders: [],
    };
  }
  return { version: 1, snapshots };
}

// ---------------------------------------------------------------------------
// isFlowHttpCompatible
// ---------------------------------------------------------------------------

describe('isFlowHttpCompatible', () => {
  it('returns true when all network_replay steps have snapshots and no DOM extraction', () => {
    const steps: DslStep[] = [
      { id: 'nav1', type: 'navigate', params: { url: 'https://example.com' } } as NavigateStep,
      { id: 'find1', type: 'network_find', params: { where: { urlIncludes: '/api/' }, saveAs: 'reqId' } } as NetworkFindStep,
      {
        id: 'replay1', type: 'network_replay',
        params: { requestId: '{{vars.reqId}}', auth: 'browser_context', out: 'data', response: { as: 'json' } },
      } as NetworkReplayStep,
      { id: 'var1', type: 'set_var', params: { name: 'x', value: 'y' } } as SetVarStep,
    ];
    const snapshots = makeSnapshotFile(['replay1']);
    expect(isFlowHttpCompatible(steps, snapshots)).toBe(true);
  });

  it('returns false when snapshots is null', () => {
    const steps: DslStep[] = [
      {
        id: 'replay1', type: 'network_replay',
        params: { requestId: '{{vars.reqId}}', auth: 'browser_context', out: 'data', response: { as: 'json' } },
      } as NetworkReplayStep,
    ];
    expect(isFlowHttpCompatible(steps, null)).toBe(false);
  });

  it('returns false when a replay step has no snapshot', () => {
    const steps: DslStep[] = [
      {
        id: 'replay1', type: 'network_replay',
        params: { requestId: '{{vars.reqId}}', auth: 'browser_context', out: 'data', response: { as: 'json' } },
      } as NetworkReplayStep,
      {
        id: 'replay2', type: 'network_replay',
        params: { requestId: '{{vars.reqId2}}', auth: 'browser_context', out: 'data2', response: { as: 'json' } },
      } as NetworkReplayStep,
    ];
    const snapshots = makeSnapshotFile(['replay1']); // Missing replay2
    expect(isFlowHttpCompatible(steps, snapshots)).toBe(false);
  });

  it('returns false when flow contains extract_text step', () => {
    const steps: DslStep[] = [
      {
        id: 'replay1', type: 'network_replay',
        params: { requestId: '{{vars.reqId}}', auth: 'browser_context', out: 'data', response: { as: 'json' } },
      } as NetworkReplayStep,
      {
        id: 'extract1', type: 'extract_text',
        params: { target: { kind: 'css', selector: '.title' }, out: 'title' },
      } as ExtractTextStep,
    ];
    const snapshots = makeSnapshotFile(['replay1']);
    expect(isFlowHttpCompatible(steps, snapshots)).toBe(false);
  });

  it('returns false when flow has no network_replay steps', () => {
    const steps: DslStep[] = [
      { id: 'nav1', type: 'navigate', params: { url: 'https://example.com' } } as NavigateStep,
      { id: 'var1', type: 'set_var', params: { name: 'x', value: 'y' } } as SetVarStep,
    ];
    const snapshots = makeSnapshotFile([]);
    expect(isFlowHttpCompatible(steps, snapshots)).toBe(false);
  });

  it('returns false when a snapshot is stale (TTL expired)', () => {
    const snapshots = makeSnapshotFile(['replay1']);
    snapshots.snapshots['replay1'].capturedAt = Date.now() - 120_000;
    snapshots.snapshots['replay1'].ttl = 60_000;

    const steps: DslStep[] = [
      {
        id: 'replay1', type: 'network_replay',
        params: { requestId: '{{vars.reqId}}', auth: 'browser_context', out: 'data', response: { as: 'json' } },
      } as NetworkReplayStep,
    ];
    expect(isFlowHttpCompatible(steps, snapshots)).toBe(false);
  });

  it('allows sleep, set_var, and network_extract in HTTP mode', () => {
    const steps: DslStep[] = [
      {
        id: 'replay1', type: 'network_replay',
        params: { requestId: '{{vars.reqId}}', auth: 'browser_context', out: 'data', response: { as: 'json' } },
      } as NetworkReplayStep,
      { id: 'sleep1', type: 'sleep', params: { durationMs: 100 } } as SleepStep,
      { id: 'var1', type: 'set_var', params: { name: 'x', value: 'y' } } as SetVarStep,
      {
        id: 'extract1', type: 'network_extract',
        params: { fromVar: 'data', as: 'json', path: 'results', out: 'items' },
      } as NetworkExtractStep,
    ];
    const snapshots = makeSnapshotFile(['replay1']);
    expect(isFlowHttpCompatible(steps, snapshots)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// replayFromSnapshot
// ---------------------------------------------------------------------------

describe('replayFromSnapshot', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('makes a GET request from snapshot data', async () => {
    const mockResponse = {
      status: 200,
      text: async () => '{"results":[]}',
      headers: new Headers({ 'content-type': 'application/json' }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const snapshot: RequestSnapshot = {
      stepId: 'test',
      capturedAt: Date.now(),
      ttl: null,
      request: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: { accept: 'application/json' },
        body: null,
      },
      responseValidation: {
        expectedStatus: 200,
        expectedContentType: 'application/json',
        expectedKeys: [],
      },
      sensitiveHeaders: [],
    };

    const result = await replayFromSnapshot(snapshot, {}, {});

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/items',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"results":[]}');
  });

  it('makes a POST request with body', async () => {
    const mockResponse = {
      status: 200,
      text: async () => '{"ok":true}',
      headers: new Headers({ 'content-type': 'application/json' }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const snapshot: RequestSnapshot = {
      stepId: 'test',
      capturedAt: Date.now(),
      ttl: null,
      request: {
        method: 'POST',
        url: 'https://api.example.com/search',
        headers: { 'content-type': 'application/json' },
        body: '{"query":"test"}',
      },
      responseValidation: {
        expectedStatus: 200,
        expectedContentType: 'application/json',
        expectedKeys: [],
      },
      sensitiveHeaders: [],
    };

    await replayFromSnapshot(snapshot, {}, {});

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/search',
      expect.objectContaining({
        method: 'POST',
        body: '{"query":"test"}',
      }),
    );
  });

  it('applies overrides from inputs before request', async () => {
    const mockResponse = {
      status: 200,
      text: async () => '{"data":[]}',
      headers: new Headers({ 'content-type': 'application/json' }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const snapshot: RequestSnapshot = {
      stepId: 'test',
      capturedAt: Date.now(),
      ttl: null,
      request: {
        method: 'POST',
        url: 'https://api.example.com/search',
        headers: { 'content-type': 'application/json' },
        body: '{"batch":"W24"}',
      },
      overrides: {
        bodyReplace: [{ find: 'W24', replace: '{{inputs.batch}}' }],
      },
      responseValidation: {
        expectedStatus: 200,
        expectedContentType: 'application/json',
        expectedKeys: [],
      },
      sensitiveHeaders: [],
    };

    await replayFromSnapshot(snapshot, { batch: 'S25' }, {});

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/search',
      expect.objectContaining({
        body: '{"batch":"S25"}',
      }),
    );
  });

  it('does not send body for GET requests', async () => {
    const mockResponse = {
      status: 200,
      text: async () => '{}',
      headers: new Headers({}),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const snapshot: RequestSnapshot = {
      stepId: 'test',
      capturedAt: Date.now(),
      ttl: null,
      request: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: {},
        body: 'should-be-ignored',
      },
      responseValidation: {
        expectedStatus: 200,
        expectedContentType: '',
        expectedKeys: [],
      },
      sensitiveHeaders: [],
    };

    await replayFromSnapshot(snapshot, {}, {});

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(fetchCall.body).toBeUndefined();
  });

  it('preserves sensitive headers in the request (needed for auth)', async () => {
    const mockResponse = {
      status: 200,
      text: async () => '{}',
      headers: new Headers({}),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const snapshot: RequestSnapshot = {
      stepId: 'test',
      capturedAt: Date.now(),
      ttl: null,
      request: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: {
          accept: 'application/json',
          cookie: 'session=abc123',
          Authorization: 'Bearer token',
        },
        body: null,
      },
      responseValidation: {
        expectedStatus: 200,
        expectedContentType: '',
        expectedKeys: [],
      },
      sensitiveHeaders: ['cookie', 'Authorization'],
    };

    await replayFromSnapshot(snapshot, {}, {});

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(fetchCall.headers).toHaveProperty('accept', 'application/json');
    expect(fetchCall.headers).toHaveProperty('cookie', 'session=abc123');
    expect(fetchCall.headers).toHaveProperty('Authorization', 'Bearer token');
  });

  it('throws timeout error when fetch takes too long', async () => {
    // Mock a fetch that never resolves
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const snapshot: RequestSnapshot = {
      stepId: 'test',
      capturedAt: Date.now(),
      ttl: null,
      request: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: {},
        body: null,
      },
      responseValidation: {
        expectedStatus: 200,
        expectedContentType: '',
        expectedKeys: [],
      },
      sensitiveHeaders: [],
    };

    await expect(
      replayFromSnapshot(snapshot, {}, {}, { timeoutMs: 50 }),
    ).rejects.toThrow('HTTP replay timed out');
  });
});
