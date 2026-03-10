/**
 * Registry client for ShowRun pack registry.
 *
 * Communicates with the registry REST API to authenticate, publish, search,
 * and install task packs. Uses the global token store for persistence and
 * automatically refreshes access tokens before they expire.
 */

import { join } from 'path';
import { readFileSync } from 'fs';
import { TaskPackLoader } from '../loader.js';
import { readJsonFile, ensureDir, writeTaskPackManifest, writeFlowJson } from '../packUtils.js';
import { loadTokens, saveTokens, clearTokens } from './tokenStore.js';
import type {
  IRegistryClient,
  DeviceCodeResponse,
  DevicePollResult,
  DeviceTokenResponse,
  RegistryRefreshResponse,
  UserProfile,
  PublishParams,
  PublishResult,
  PackSummary,
  PackDetail,
  PaginatedResponse,
  SearchQuery,
  ReportParams,
  StoredAuth,
} from './types.js';
import type { TaskPackManifest, InputSchema, CollectibleDefinition } from '../types.js';
import type { DslStep } from '../dsl/types.js';

// ── Error class ───────────────────────────────────────────────────────────

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

// ── JWT helpers ───────────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function tokenExpiresWithin(token: string, seconds: number): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return true; // assume expired
  const expiresAt = payload.exp * 1000;
  return Date.now() + seconds * 1000 >= expiresAt;
}

// ── Scoped path helper ────────────────────────────────────────────────────

/**
 * Build the API path segment for a scoped pack reference (`@username/slug`).
 * Returns `@encodedUser/encodedSlug` suitable for URL path interpolation.
 */
function packApiPath(ref: string): string {
  const m = ref.match(/^@([^/]+)\/(.+)$/);
  if (!m) {
    throw new RegistryError(
      `Invalid pack ref "${ref}". Expected @username/slug`,
      400,
    );
  }
  return `@${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`;
}

// ── RegistryClient ────────────────────────────────────────────────────────

export class RegistryClient implements IRegistryClient {
  private readonly registryUrl: string;

  constructor(registryUrl?: string) {
    const url = registryUrl || process.env.SHOWRUN_REGISTRY_URL || 'https://registry.showrun.co';
    // Strip trailing slash
    this.registryUrl = url.replace(/\/+$/, '');
  }

  // ── Auth (OAuth Device Flow — RFC 8628) ────────────────────────────────

  async startDeviceLogin(): Promise<DeviceCodeResponse> {
    return this.request<DeviceCodeResponse>(
      'POST',
      '/api/auth/device',
      {},
      false,
    );
  }

  async pollDeviceLogin(deviceCode: string): Promise<DevicePollResult> {
    const url = `${this.registryUrl}/api/auth/device/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    });

    if (res.status === 428 || res.status === 400) {
      // authorization_pending or slow_down — user hasn't approved yet
      const body = await res.json().catch(() => ({}));
      const error = (body as { error?: string }).error;
      if (error === 'expired') {
        return { status: 'expired' };
      }
      return { status: 'pending' };
    }

    if (!res.ok) {
      let errBody: unknown;
      try { errBody = await res.json(); } catch { errBody = ''; }
      const message =
        (errBody && typeof errBody === 'object' && 'message' in errBody
          ? String((errBody as { message: string }).message)
          : null) || `Device token request failed (${res.status})`;
      throw new RegistryError(message, res.status, errBody);
    }

    const data = (await res.json()) as DeviceTokenResponse;

    // Store tokens
    saveTokens({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
      registryUrl: this.registryUrl,
      savedAt: new Date().toISOString(),
    });

    return {
      status: 'complete',
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
    };
  }

  async logout(): Promise<void> {
    clearTokens();
  }

  async whoami(): Promise<UserProfile> {
    return this.request<UserProfile>('GET', '/api/auth/me', undefined, true);
  }

  isAuthenticated(): boolean {
    const tokens = loadTokens();
    return tokens !== null && tokens.registryUrl === this.registryUrl;
  }

  // ── Packs ─────────────────────────────────────────────────────────────

  async publishPack(params: PublishParams): Promise<PublishResult> {
    const { packPath, slug: userSlug, visibility = 'public', changelog } = params;
    const warnings: string[] = [];

    // Load local pack
    const manifest = TaskPackLoader.loadManifest(packPath);

    // Load flow data based on pack kind
    let flowData: unknown;
    if (manifest.kind === 'playwright-js') {
      // playwright-js packs use flow.playwright.js (raw source code)
      const flowPath = join(packPath, 'flow.playwright.js');
      const source = readFileSync(flowPath, 'utf-8');
      flowData = {
        source,
        inputs: manifest.inputs || {},
        collectibles: manifest.collectibles || [],
      };
    } else {
      // json-dsl packs use flow.json
      const flowPath = join(packPath, 'flow.json');
      flowData = readJsonFile<{
        inputs?: InputSchema;
        collectibles?: CollectibleDefinition[];
        flow: DslStep[];
      }>(flowPath);
    }

    const slug = userSlug || manifest.id;

    // Try to get existing pack; create if 404.
    // Publish uses the short slug — server infers the @username scope from the
    // auth token. The deprecated slug-only paths still work for this purpose.
    let created = false;
    try {
      await this.request('GET', `/api/packs/${encodeURIComponent(slug)}`, undefined, true);
    } catch (err) {
      if (err instanceof RegistryError && err.status === 404) {
        await this.request(
          'POST',
          '/api/packs',
          {
            slug,
            name: manifest.name,
            description: manifest.description || '',
            visibility,
          },
          true,
        );
        created = true;
      } else {
        throw err;
      }
    }

    // Publish version
    const versionData = await this.request<{ version: string | { version?: string } }>(
      'POST',
      `/api/packs/${encodeURIComponent(slug)}/versions`,
      {
        version: manifest.version,
        manifest: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          kind: manifest.kind,
        },
        flow: flowData,
        changelog,
      },
      true,
    );

    // The API may return version as a string or as an object with a nested version field
    const rawVersion = versionData.version;
    const version =
      typeof rawVersion === 'string'
        ? rawVersion
        : (rawVersion && typeof rawVersion === 'object' && 'version' in rawVersion
            ? String(rawVersion.version)
            : manifest.version);

    return {
      slug,
      version,
      created,
      warnings,
    };
  }

  async searchPacks(query: SearchQuery): Promise<PaginatedResponse<PackSummary>> {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));

    const qs = params.toString();
    const path = `/api/packs${qs ? `?${qs}` : ''}`;
    return this.request<PaginatedResponse<PackSummary>>('GET', path, undefined, false);
  }

  async installPack(ref: string, destDir: string, version?: string): Promise<void> {
    const scopedPath = packApiPath(ref);

    // Get pack detail
    const detail = await this.request<PackDetail>('GET', `/api/packs/${scopedPath}`, undefined, false);

    // Determine version to install
    const targetVersion = version || detail.latestVersion;
    if (!targetVersion) {
      throw new RegistryError(`Pack "${ref}" has no published versions`, 404);
    }

    // Get version data (manifest + flow)
    const versionData = await this.request<{
      manifest: TaskPackManifest;
      flow: { inputs?: InputSchema; collectibles?: CollectibleDefinition[]; flow: DslStep[] };
    }>('GET', `/api/packs/${scopedPath}/versions/${targetVersion}`, undefined, false);

    // Write to local directory — creates nested @username/slug/ structure
    const packDir = join(destDir, ref);
    ensureDir(packDir);

    writeTaskPackManifest(packDir, versionData.manifest);
    writeFlowJson(packDir, versionData.flow);
  }

  // ── Reports ──────────────────────────────────────────────────────────

  async reportPack(params: ReportParams): Promise<void> {
    await this.request(
      'POST',
      `/api/packs/${packApiPath(params.slug)}/report`,
      {
        reason: params.reason,
        ...(params.description && { description: params.description }),
      },
      true,
    );
  }

  // ── Internal request helper ───────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    authenticated = false,
  ): Promise<T> {
    const url = `${this.registryUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authenticated) {
      const accessToken = await this.getValidAccessToken();
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let errBody: unknown;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text().catch(() => '');
      }
      const message =
        (errBody && typeof errBody === 'object' && 'message' in errBody
          ? String((errBody as { message: string }).message)
          : null) || `Registry request failed: ${method} ${path} (${res.status})`;
      throw new RegistryError(message, res.status, errBody);
    }

    return (await res.json()) as T;
  }

  /**
   * Get a valid access token, refreshing if it's about to expire (within 60s).
   * If refresh fails, clears tokens and throws.
   */
  private async getValidAccessToken(): Promise<string> {
    const auth = loadTokens();
    if (!auth) {
      throw new RegistryError(
        'Not logged in. Run `showrun registry login` first.',
        401,
      );
    }

    // Check if token is still valid (with 60s buffer)
    if (!tokenExpiresWithin(auth.accessToken, 60)) {
      return auth.accessToken;
    }

    // Token expired or about to expire — refresh
    try {
      const data = await this.refreshAccessToken(auth);
      // Update stored tokens with new access token
      saveTokens({
        ...auth,
        accessToken: data.accessToken,
        savedAt: new Date().toISOString(),
      });
      return data.accessToken;
    } catch {
      // Refresh failed — clear tokens, user needs to log in again
      clearTokens();
      throw new RegistryError(
        'Session expired. Run `showrun registry login` to authenticate again.',
        401,
      );
    }
  }

  private async refreshAccessToken(auth: StoredAuth): Promise<RegistryRefreshResponse> {
    const url = `${this.registryUrl}/api/auth/refresh`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });

    if (!res.ok) {
      throw new RegistryError('Token refresh failed', res.status);
    }

    return (await res.json()) as RegistryRefreshResponse;
  }
}
