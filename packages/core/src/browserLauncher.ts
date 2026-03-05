/**
 * Unified browser launcher
 *
 * Provides a unified interface for launching browsers with different engines
 * (Chromium, Camoufox) and persistence modes.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'fs';
import { join } from 'path';
import type { BrowserEngine, BrowserSettings, BrowserPersistence } from './types.js';
import type { ResolvedProxy } from './proxy/types.js';
import { resolveBrowserDataDir } from './browserPersistence.js';

/**
 * Browser session returned by launchBrowser
 */
export interface BrowserSession {
  /**
   * Browser context (for both Chromium and Camoufox)
   */
  context: BrowserContext;
  /**
   * Main page in the context
   */
  page: Page;
  /**
   * Browser instance (null for Camoufox which returns context directly)
   */
  browser: Browser | null;
  /**
   * Engine used for this session
   */
  engine: BrowserEngine;
  /**
   * Persistence mode
   */
  persistence: BrowserPersistence;
  /**
   * User data directory path (if persistence is enabled)
   */
  userDataDir?: string;
  /**
   * Resolved proxy used for this session (if any)
   */
  proxy?: ResolvedProxy;
  /**
   * Close the browser session
   */
  close(): Promise<void>;
}

/**
 * Configuration for launching a browser
 */
export interface LaunchBrowserConfig {
  /**
   * Browser settings from task pack
   */
  browserSettings?: BrowserSettings;
  /**
   * Run in headless mode (default: true)
   */
  headless?: boolean;
  /**
   * Session ID for session persistence
   */
  sessionId?: string;
  /**
   * Pack directory path for profile persistence
   */
  packPath?: string;
  /**
   * Direct user data directory override.
   * When set, bypasses persistence resolution (sessionId/packPath).
   */
  userDataDir?: string;
  /**
   * Resolved proxy to route traffic through.
   * Passed directly to Playwright/Camoufox launch options.
   */
  proxy?: ResolvedProxy;
  /**
   * Chrome DevTools Protocol URL to connect to an existing browser.
   * When set, connects via CDP instead of launching a new browser.
   * Chromium-only (Camoufox/Firefox does not support CDP).
   */
  cdpUrl?: string;
}

/**
 * Launches a browser with the specified configuration
 *
 * @param config - Browser launch configuration
 * @returns Browser session with context, page, and close function
 */
export async function launchBrowser(config: LaunchBrowserConfig): Promise<BrowserSession> {
  // CDP connection: connect to an existing Chrome browser instead of launching
  if (config.cdpUrl) {
    return connectCDP(config.cdpUrl);
  }

  const {
    browserSettings = {},
    headless = true,
    sessionId,
    packPath,
  } = config;

  const engine = browserSettings.engine ?? 'camoufox';
  let persistence: BrowserPersistence = browserSettings.persistence ?? 'none';

  // Use explicit userDataDir if provided, otherwise resolve from persistence settings
  let userDataDir: string | undefined;
  if (config.userDataDir) {
    userDataDir = config.userDataDir;
    persistence = 'profile'; // Treat explicit dir as profile persistence
  } else {
    // Auto-upgrade to profile persistence when packPath has an existing .browser-profile/
    if (persistence === 'none' && packPath && existsSync(join(packPath, '.browser-profile'))) {
      persistence = 'profile';
    }
    userDataDir = resolveBrowserDataDir({
      persistence,
      sessionId,
      packPath,
    });
  }

  if (engine === 'camoufox') {
    return launchCamoufox({
      headless,
      userDataDir,
      persistence,
      proxy: config.proxy,
    });
  }

  // Default: Chromium
  return launchChromium({
    headless,
    userDataDir,
    persistence,
    proxy: config.proxy,
  });
}

/**
 * Connects to an existing Chrome browser via Chrome DevTools Protocol.
 * The external agent owns the browser — close() is a no-op (only disconnects the CDP session).
 * Uses the last page in the list (most recently opened) and brings it to front.
 */
async function connectCDP(cdpUrl: string): Promise<BrowserSession> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = context.pages();
  const page = pages.length > 0 ? pages[pages.length - 1] : await context.newPage();

  // Bring the selected page to front so the flow runs in the visible tab
  await page.bringToFront();

  return {
    context,
    page,
    browser,
    engine: 'chromium',
    persistence: 'none',
    async close() {
      // No-op: the external agent owns the browser.
      // The CDP WebSocket disconnects automatically when the process exits.
    },
  };
}

/**
 * Launches Chromium browser
 */
async function launchChromium(config: {
  headless: boolean;
  userDataDir?: string;
  persistence: BrowserPersistence;
  proxy?: ResolvedProxy;
}): Promise<BrowserSession> {
  const { headless, userDataDir, persistence, proxy } = config;

  const proxyOption = proxy
    ? { server: proxy.server, username: proxy.username, password: proxy.password }
    : undefined;

  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  if (userDataDir) {
    // Use persistent context when user data dir is specified
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      proxy: proxyOption,
    });
    browser = null as unknown as Browser; // Persistent context doesn't expose browser
    page = context.pages()[0] || await context.newPage();
  } else {
    // Ephemeral browser
    browser = await chromium.launch({ headless, proxy: proxyOption });
    context = await browser.newContext();
    page = await context.newPage();
  }

  return {
    context,
    page,
    browser,
    engine: 'chromium',
    persistence,
    userDataDir,
    proxy,
    async close() {
      if (browser) {
        await browser.close().catch(() => {});
      } else {
        await context.close().catch(() => {});
      }
    },
  };
}

/**
 * Ensures the Camoufox browser binary is downloaded.
 * Auto-fetches on first use so `npx showrun dashboard` works as a one-liner.
 */
async function ensureCamoufoxBrowser(): Promise<void> {
  try {
    const pkgman = await import('camoufox-js/dist/pkgman.js');
    const installDir = pkgman.INSTALL_DIR.toString();

    // Check if browser is installed with a valid version file
    if (existsSync(installDir)) {
      try {
        pkgman.installedVerStr();
        return; // Already installed
      } catch {
        // version.json missing or corrupt — re-fetch
      }
    }

    console.log('[ShowRun] Camoufox browser not found. Downloading automatically...');
    const fetcher = new pkgman.CamoufoxFetcher();
    await fetcher.install();
  } catch (error) {
    throw new Error(
      'Failed to auto-download Camoufox browser. Try "npx camoufox-js fetch" manually. ' +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Launches Camoufox browser (Firefox-based anti-detection)
 *
 * Note: When user_data_dir is provided, Camoufox returns a BrowserContext directly
 * (not a Browser). This is different from the ephemeral case where it returns Browser.
 */
async function launchCamoufox(config: {
  headless: boolean;
  userDataDir?: string;
  persistence: BrowserPersistence;
  proxy?: ResolvedProxy;
}): Promise<BrowserSession> {
  const { headless, userDataDir, persistence, proxy } = config;

  // Desktop-only screen constraints to prevent mobile fingerprints
  const screen = { minWidth: 1024, minHeight: 768 };

  // Ensure the camoufox browser binary is downloaded before launching
  await ensureCamoufoxBrowser();

  // Dynamic import to avoid loading Camoufox when not needed
  let Camoufox: (options: { headless?: boolean; user_data_dir?: string; humanize?: number | boolean; screen?: { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number }; proxy?: { server: string; username: string; password: string }; geoip?: boolean }) => Promise<Browser | BrowserContext>;
  try {
    const camoufoxModule = await import('camoufox-js');
    Camoufox = camoufoxModule.Camoufox;
  } catch (error) {
    throw new Error(
      'Camoufox is not available. Run "npx camoufox-js fetch" to download the browser. ' +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const proxyOption = proxy
    ? { server: proxy.server, username: proxy.username, password: proxy.password }
    : undefined;

  if (userDataDir) {
    // With user_data_dir, Camoufox returns BrowserContext directly (persistent context)
    // humanize: adds human-like cursor movement delays (up to 2 seconds)
    const context = await Camoufox({
      headless,
      humanize: 2.0,
      screen,
      user_data_dir: userDataDir,
      ...(proxyOption && { proxy: proxyOption, geoip: true }),
    }) as unknown as BrowserContext;

    const page = context.pages()[0] || await context.newPage();

    return {
      context,
      page,
      browser: null,  // No browser instance with persistent context
      engine: 'camoufox',
      persistence,
      userDataDir,
      proxy,
      async close() {
        await context.close().catch(() => {});
      },
    };
  }

  // Without user_data_dir, Camoufox returns Browser (ephemeral)
  // humanize: adds human-like cursor movement delays (up to 2 seconds)
  const browser = await Camoufox({
    headless,
    humanize: 2.0,
    screen,
    ...(proxyOption && { proxy: proxyOption, geoip: true }),
  }) as Browser;

  const context = await browser.newContext();
  const page = await context.newPage();

  return {
    context,
    page,
    browser,
    engine: 'camoufox',
    persistence,
    userDataDir,
    proxy,
    async close() {
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Checks if a browser engine is available
 */
export async function isBrowserEngineAvailable(engine: BrowserEngine): Promise<boolean> {
  if (engine === 'chromium') {
    // Chromium is always available via Playwright
    return true;
  }

  if (engine === 'camoufox') {
    try {
      await import('camoufox-js');
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
