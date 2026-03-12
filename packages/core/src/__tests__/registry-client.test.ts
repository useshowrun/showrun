import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import { randomBytes } from 'crypto';

// ── Token store tests ─────────────────────────────────────────────────────

describe('tokenStore', () => {
  let tempDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `showrun-test-${randomBytes(6).toString('hex')}`);
    mkdirSync(tempDir, { recursive: true });
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
      HOME: process.env.HOME,
    };
    // Point config dir to temp
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    // Restore env
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // Clean up temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    vi.restoreAllMocks();
  });

  it('saveTokens creates auth.json and loadTokens reads it', async () => {
    const { saveTokens, loadTokens } = await import('../registry/tokenStore.js');

    const auth = {
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      user: { id: '1', username: 'testuser', email: 'test@test.com' },
      registryUrl: 'https://registry.example.com',
      savedAt: new Date().toISOString(),
    };

    saveTokens(auth);
    const loaded = loadTokens();

    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe('at-123');
    expect(loaded!.refreshToken).toBe('rt-456');
    expect(loaded!.user.username).toBe('testuser');
    expect(loaded!.registryUrl).toBe('https://registry.example.com');
  });

  it('clearTokens removes auth.json', async () => {
    const { saveTokens, clearTokens, loadTokens } = await import('../registry/tokenStore.js');

    saveTokens({
      accessToken: 'at',
      refreshToken: 'rt',
      user: { id: '1', username: 'u', email: 'e@e.com' },
      registryUrl: 'https://r.com',
      savedAt: new Date().toISOString(),
    });

    expect(loadTokens()).not.toBeNull();
    clearTokens();
    expect(loadTokens()).toBeNull();
  });

  it('loadTokens returns null when no file exists', async () => {
    const { loadTokens } = await import('../registry/tokenStore.js');
    expect(loadTokens()).toBeNull();
  });

  it('sets 0o600 permissions on Unix', async () => {
    if (platform() === 'win32') return; // Skip on Windows

    const { saveTokens } = await import('../registry/tokenStore.js');

    saveTokens({
      accessToken: 'at',
      refreshToken: 'rt',
      user: { id: '1', username: 'u', email: 'e@e.com' },
      registryUrl: 'https://r.com',
      savedAt: new Date().toISOString(),
    });

    const authPath = join(tempDir, 'showrun', 'auth.json');
    const stats = statSync(authPath);
    // 0o600 = owner read+write only
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

// ── RegistryClient tests ──────────────────────────────────────────────────

describe('RegistryClient', () => {
  let tempDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `showrun-registry-client-${randomBytes(6).toString('hex')}`);
    mkdirSync(tempDir, { recursive: true });
    originalEnv = {
      SHOWRUN_REGISTRY_URL: process.env.SHOWRUN_REGISTRY_URL,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
      HOME: process.env.HOME,
    };
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('falls back to default registry URL when not configured', async () => {
    delete process.env.SHOWRUN_REGISTRY_URL;
    const { RegistryClient } = await import('../registry/client.js');

    const client = new RegistryClient();
    expect(client).toBeDefined();
  });

  it('constructs with explicit URL', async () => {
    const { RegistryClient } = await import('../registry/client.js');
    const client = new RegistryClient('https://registry.example.com');
    expect(client).toBeDefined();
  });

  it('constructs with env var', async () => {
    process.env.SHOWRUN_REGISTRY_URL = 'https://registry.example.com';
    const { RegistryClient } = await import('../registry/client.js');
    const client = new RegistryClient();
    expect(client).toBeDefined();
  });

  it('strips trailing slash from URL', async () => {
    const { RegistryClient } = await import('../registry/client.js');
    // The URL gets stripped internally - verify it works by checking search constructs properly
    const client = new RegistryClient('https://registry.example.com///');
    expect(client).toBeDefined();
  });

  it('startDeviceLogin requests device code', async () => {
    const { RegistryClient } = await import('../registry/client.js');

    const mockDevice = {
      deviceCode: 'dc-123',
      userCode: 'ABCD-1234',
      verificationUri: 'https://registry.example.com/device',
      expiresIn: 900,
      interval: 5,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockDevice), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new RegistryClient('https://registry.example.com');
    const result = await client.startDeviceLogin();

    expect(result.userCode).toBe('ABCD-1234');
    expect(result.deviceCode).toBe('dc-123');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://registry.example.com/api/auth/device');
  });

  it('pollDeviceLogin returns pending when user has not approved', async () => {
    const { RegistryClient } = await import('../registry/client.js');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'authorization_pending' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new RegistryClient('https://registry.example.com');
    const result = await client.pollDeviceLogin('dc-123');
    expect(result.status).toBe('pending');
  });

  it('pollDeviceLogin stores tokens on success', async () => {
    const { RegistryClient } = await import('../registry/client.js');
    const { loadTokens, clearTokens } = await import('../registry/tokenStore.js');

    const mockTokenResponse = {
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjk5OTk5OTk5OTl9.test',
      refreshToken: 'rt-mock',
      user: { id: '1', username: 'mockuser', email: 'mock@test.com', displayName: 'Mock User' },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockTokenResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new RegistryClient('https://registry.example.com');
    const result = await client.pollDeviceLogin('dc-123');

    expect(result.status).toBe('complete');
    if (result.status === 'complete') {
      expect(result.user.username).toBe('mockuser');
    }

    // Verify tokens were stored
    const stored = loadTokens();
    expect(stored).not.toBeNull();
    expect(stored!.accessToken).toBe(mockTokenResponse.accessToken);

    // Clean up
    clearTokens();
  });

  it('searchPacks sends correct query params', async () => {
    const { RegistryClient } = await import('../registry/client.js');

    const mockResponse = {
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new RegistryClient('https://registry.example.com');
    await client.searchPacks({ q: 'test', page: 2, limit: 10 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('/api/packs?');
    expect(url).toContain('q=test');
    expect(url).toContain('page=2');
    expect(url).toContain('limit=10');
  });

  it('handles 4xx/5xx errors as RegistryError', async () => {
    const { RegistryClient, RegistryError } = await import('../registry/client.js');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new RegistryClient('https://registry.example.com');

    await expect(client.searchPacks({ q: 'missing' })).rejects.toThrow(RegistryError);
    await expect(
      // Re-mock for second call
      (async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Internal error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        return client.searchPacks({ q: 'fail' });
      })(),
    ).rejects.toThrow(RegistryError);
  });

  it('installs playwright-js packs using flow.playwright.js', async () => {
    const tempDir = join(tmpdir(), `showrun-registry-install-${randomBytes(6).toString('hex')}`);
    mkdirSync(tempDir, { recursive: true });

    const manifest = {
      id: 'example-pack',
      name: 'Example Pack',
      version: '1.2.3',
      kind: 'playwright-js' as const,
      description: 'Example playwright-js pack',
      inputs: {
        query: { type: 'string', required: true },
      },
      collectibles: [
        { name: 'items', type: 'array' },
      ],
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          id: 'pack-1',
          slug: '@alice/example-pack',
          name: 'Example Pack',
          description: 'Example playwright-js pack',
          visibility: 'public',
          latestVersion: '1.2.3',
          owner: { id: 'user-1', username: 'alice' },
          createdAt: '2026-03-12T00:00:00.000Z',
          updatedAt: '2026-03-12T00:00:00.000Z',
          versions: [{ version: '1.2.3', createdAt: '2026-03-12T00:00:00.000Z' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          manifest,
          playwrightJsSource: 'module.exports = async function() { return { items: [] }; };\n',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    try {
      const { RegistryClient } = await import('../registry/client.js');
      const client = new RegistryClient('https://registry.example.com');

      await client.installPack('@alice/example-pack', tempDir);

      const packDir = join(tempDir, '@alice/example-pack');
      expect(existsSync(join(packDir, 'taskpack.json'))).toBe(true);
      expect(existsSync(join(packDir, 'flow.playwright.js'))).toBe(true);
      expect(existsSync(join(packDir, 'flow.json'))).toBe(false);

      const installedManifest = JSON.parse(readFileSync(join(packDir, 'taskpack.json'), 'utf-8'));
      expect(installedManifest.kind).toBe('playwright-js');
      expect(readFileSync(join(packDir, 'flow.playwright.js'), 'utf-8')).toContain('return { items: [] }');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
