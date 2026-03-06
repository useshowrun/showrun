import { describe, it, expect, vi } from 'vitest';
import { createReplayTransport } from '../transport/index.js';
import { PlaywrightTransport } from '../transport/playwrightTransport.js';
import { ImpitTransport } from '../transport/impitTransport.js';
import type { ReplayRequest } from '../transport/types.js';

// --- Factory ---

describe('createReplayTransport', () => {
  const mockPage = {} as any;
  const mockContext = {} as any;

  it('returns ImpitTransport by default (no config)', () => {
    const transport = createReplayTransport(undefined, mockPage, mockContext);
    expect(transport).toBeInstanceOf(ImpitTransport);
    expect(transport.name).toBe('impit');
  });

  it('returns PlaywrightTransport when explicitly configured', () => {
    const transport = createReplayTransport({ transport: 'playwright' }, mockPage, mockContext);
    expect(transport).toBeInstanceOf(PlaywrightTransport);
  });

  it('returns ImpitTransport when configured', () => {
    const transport = createReplayTransport({ transport: 'impit' }, mockPage, mockContext);
    expect(transport).toBeInstanceOf(ImpitTransport);
    expect(transport.name).toBe('impit');
  });

  it('passes impit options through', () => {
    const transport = createReplayTransport(
      { transport: 'impit', impit: { browser: 'chrome', timeout: 5000 } },
      mockPage,
      mockContext,
    );
    expect(transport).toBeInstanceOf(ImpitTransport);
  });
});

// --- PlaywrightTransport ---

describe('PlaywrightTransport', () => {
  it('calls page.request.fetch with correct arguments', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      body: () => Promise.resolve(Buffer.from('{"ok":true}')),
    });
    const mockPage = { request: { fetch: mockFetch } } as any;

    const transport = new PlaywrightTransport(mockPage);
    const request: ReplayRequest = {
      url: 'https://api.example.com/data',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"query":"test"}',
    };

    const result = await transport.execute(request);

    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      data: '{"query":"test"}',
    });
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/json');
    expect(result.body).toBe('{"ok":true}');
  });

  it('throws when page.request is unavailable', async () => {
    const transport = new PlaywrightTransport({} as any);
    await expect(transport.execute({ url: 'https://x.com', method: 'GET', headers: {} }))
      .rejects.toThrow('Browser context does not support API request');
  });
});

// --- ImpitTransport ---

describe('ImpitTransport', () => {
  it('extracts cookies from browser context and injects as header', async () => {
    const mockCookies = vi.fn().mockResolvedValue([
      { name: 'session', value: 'abc123', domain: 'api.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'csrf', value: 'xyz', domain: 'api.example.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
    ]);
    const mockContext = { cookies: mockCookies } as any;

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: (name: string) => name === 'content-type' ? 'application/json' : null },
      text: () => Promise.resolve('{"data":"ok"}'),
    });

    const transport = new ImpitTransport(mockContext, { browser: 'firefox' });
    // Inject mock impit instance directly
    (transport as any).impitInstance = { fetch: mockFetch };

    const request: ReplayRequest = {
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: { 'accept': 'application/json', 'content-length': '0' },
    };

    const result = await transport.execute(request);

    // Verify cookies were extracted for the request URL
    expect(mockCookies).toHaveBeenCalledWith('https://api.example.com/data');

    // Verify cookie header was injected
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].headers['cookie']).toBe('session=abc123; csrf=xyz');

    // Verify content-length was stripped (impit manages it)
    expect(fetchCall[1].headers['content-length']).toBeUndefined();

    // Verify accept header passed through
    expect(fetchCall[1].headers['accept']).toBe('application/json');

    expect(result.status).toBe(200);
    expect(result.body).toBe('{"data":"ok"}');
  });

  it('throws clear error when impit import fails', async () => {
    const mockContext = { cookies: vi.fn().mockResolvedValue([]) } as any;
    const transport = new ImpitTransport(mockContext);

    // Force the dynamic import to fail by injecting a failing initPromise
    (transport as any).impitInstance = null;
    (transport as any).initPromise = Promise.reject(
      new Error('Replay transport "impit" is configured but the "impit" package is not installed. Install it with: pnpm add impit')
    );

    await expect(transport.execute({ url: 'https://x.com', method: 'GET', headers: {} }))
      .rejects.toThrow(/impit.*not installed/);
  });

  it('dispose clears the instance', () => {
    const mockContext = {} as any;
    const transport = new ImpitTransport(mockContext);
    (transport as any).impitInstance = { fetch: vi.fn() };
    (transport as any).initPromise = Promise.resolve();

    transport.dispose();

    expect((transport as any).impitInstance).toBeNull();
    expect((transport as any).initPromise).toBeNull();
  });
});
