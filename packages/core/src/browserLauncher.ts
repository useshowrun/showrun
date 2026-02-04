/**
 * Unified browser launcher
 *
 * Provides a unified interface for launching browsers with different engines
 * (Chromium, Camoufox) and persistence modes.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { BrowserEngine, BrowserSettings, BrowserPersistence } from './types.js';
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
}

/**
 * Launches a browser with the specified configuration
 *
 * @param config - Browser launch configuration
 * @returns Browser session with context, page, and close function
 */
export async function launchBrowser(config: LaunchBrowserConfig): Promise<BrowserSession> {
  const {
    browserSettings = {},
    headless = true,
    sessionId,
    packPath,
  } = config;

  const engine = browserSettings.engine ?? 'chromium';
  const persistence = browserSettings.persistence ?? 'none';

  // Resolve user data directory based on persistence mode
  const userDataDir = resolveBrowserDataDir({
    persistence,
    sessionId,
    packPath,
  });

  if (engine === 'camoufox') {
    return launchCamoufox({
      headless,
      userDataDir,
      persistence,
    });
  }

  // Default: Chromium
  return launchChromium({
    headless,
    userDataDir,
    persistence,
  });
}

/**
 * Launches Chromium browser
 */
async function launchChromium(config: {
  headless: boolean;
  userDataDir?: string;
  persistence: BrowserPersistence;
}): Promise<BrowserSession> {
  const { headless, userDataDir, persistence } = config;

  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  if (userDataDir) {
    // Use persistent context when user data dir is specified
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
    });
    browser = null as unknown as Browser; // Persistent context doesn't expose browser
    page = context.pages()[0] || await context.newPage();
  } else {
    // Ephemeral browser
    browser = await chromium.launch({ headless });
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
 * Launches Camoufox browser (Firefox-based anti-detection)
 */
async function launchCamoufox(config: {
  headless: boolean;
  userDataDir?: string;
  persistence: BrowserPersistence;
}): Promise<BrowserSession> {
  const { headless, userDataDir, persistence } = config;

  // Dynamic import to avoid loading Camoufox when not needed
  let Camoufox: (options: { headless?: boolean; user_data_dir?: string }) => Promise<BrowserContext>;
  try {
    const camoufoxModule = await import('camoufox-js');
    Camoufox = camoufoxModule.Camoufox;
  } catch (error) {
    throw new Error(
      'Camoufox is not available. Run "npx camoufox-js fetch" to download the browser. ' +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Camoufox returns a BrowserContext directly
  const context = await Camoufox({
    headless,
    ...(userDataDir ? { user_data_dir: userDataDir } : {}),
  });

  const existingPages = context.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();

  return {
    context,
    page,
    browser: null,
    engine: 'camoufox',
    persistence,
    userDataDir,
    async close() {
      await context.close().catch(() => {});
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
