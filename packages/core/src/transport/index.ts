/**
 * Replay transport factory and re-exports.
 * Creates the appropriate transport based on taskpack configuration.
 */

import type { Page, BrowserContext } from 'playwright';
import type { ReplayTransport, ReplayTransportConfig } from './types.js';
import { PlaywrightTransport } from './playwrightTransport.js';
import { ImpitTransport } from './impitTransport.js';

/**
 * Create a replay transport based on configuration.
 * Default: PlaywrightTransport (page.request.fetch).
 */
export function createReplayTransport(
  config: ReplayTransportConfig | undefined,
  page: Page,
  browserContext: BrowserContext,
): ReplayTransport {
  const transportName = config?.transport ?? 'playwright';

  switch (transportName) {
    case 'impit':
      return new ImpitTransport(browserContext, config?.impit);
    case 'playwright':
      return new PlaywrightTransport(page);
    default: {
      const _exhaustive: never = transportName;
      throw new Error(`Unknown replay transport: ${_exhaustive}`);
    }
  }
}

export * from './types.js';
export { PlaywrightTransport } from './playwrightTransport.js';
export { ImpitTransport } from './impitTransport.js';
