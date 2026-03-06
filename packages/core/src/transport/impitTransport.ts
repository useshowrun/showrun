/**
 * Replay transport using impit for browser-grade TLS fingerprinting.
 * Bypasses bot detection (Cloudflare, etc.) by impersonating browser
 * TLS/HTTP2 fingerprints via a controlled Rust native addon.
 *
 * Cookies are bridged from the Playwright BrowserContext to impit
 * on each request, so authenticated sessions work transparently.
 */

import type { BrowserContext } from 'playwright';
import type { Impit } from 'impit';
import type { ReplayTransport, ReplayRequest, ReplayResponse, ReplayTransportConfig } from './types.js';

/** Headers that impit handles internally or that conflict with its request processing */
const IMPIT_MANAGED_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
]);

export class ImpitTransport implements ReplayTransport {
  readonly name = 'impit' as const;
  private impitInstance: Impit | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private browserContext: BrowserContext,
    private options?: ReplayTransportConfig['impit'],
  ) {}

  private async ensureImpit(): Promise<Impit> {
    if (this.impitInstance) return this.impitInstance;

    // Prevent concurrent initialization
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          // Dynamic import — impit is an optional dependency.
          const { Impit: ImpitClass } = await import('impit');
          this.impitInstance = new ImpitClass({
            browser: this.options?.browser ?? 'firefox',
            timeout: this.options?.timeout ?? 30_000,
          });
        } catch {
          throw new Error(
            'Replay transport "impit" is configured but the "impit" package is not installed. ' +
            'Install it with: pnpm add impit'
          );
        }
      })();
    }

    await this.initPromise;
    return this.impitInstance!;
  }

  async execute(request: ReplayRequest): Promise<ReplayResponse> {
    const impit = await this.ensureImpit();
    if (!impit) throw new Error('Failed to initialize impit');

    // Cookie bridging: extract cookies from browser context for the request URL
    const cookies = await this.browserContext.cookies(request.url);
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Build headers, stripping ones impit manages internally
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (!IMPIT_MANAGED_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    if (cookieHeader) {
      headers['cookie'] = cookieHeader;
    }

    const init: Record<string, unknown> = { method: request.method, headers };
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    const response = await impit.fetch(request.url, init);
    const bodyText = await response.text();
    const contentType = response.headers.get('content-type') ?? undefined;

    return {
      status: response.status,
      contentType,
      body: bodyText,
      bodySize: Buffer.byteLength(bodyText, 'utf8'),
    };
  }

  dispose(): void {
    this.impitInstance = null;
    this.initPromise = null;
  }
}
