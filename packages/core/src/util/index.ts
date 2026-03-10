/**
 * Utility functions exposed to playwright-js flows via context.util
 *
 * These utilities help with common automation challenges like
 * CAPTCHA solving, waiting for specific conditions, etc.
 */

import type { Page } from 'playwright';
import {
  detectCloudflareTurnstile,
  solveCloudflareTurnstile,
  type TurnstileDetectionResult,
  type TurnstileSolveResult,
} from './turnstile.js';

/**
 * Utility object available in playwright-js flows as `util`
 */
export interface PlaywrightJsUtil {
  /**
   * Detect Cloudflare Turnstile checkbox position on the page.
   *
   * Uses image-based detection since Turnstile uses shadow-DOM
   * which blocks direct element inspection.
   *
   * @example
   * ```javascript
   * const result = await util.detectCloudflareTurnstile();
   * if (result.found) {
   *   console.log(`Turnstile at (${result.x}, ${result.y})`);
   * }
   * ```
   */
  detectCloudflareTurnstile: (options?: {
    scale?: number;
  }) => Promise<TurnstileDetectionResult>;

  /**
   * Detect and solve Cloudflare Turnstile by clicking the checkbox.
   *
   * This function detects the widget, clicks the checkbox, and waits
   * for verification. Automatically retries if detection fails.
   *
   * @example
   * ```javascript
   * const result = await util.solveCloudflareTurnstile();
   * if (result.success) {
   *   console.log('Turnstile solved!');
   * } else {
   *   console.log('Failed:', result.error);
   * }
   * ```
   */
  solveCloudflareTurnstile: (options?: {
    /** Scale factor for HiDPI displays (default: 1) */
    scale?: number;
    /** Time to wait after clicking (default: 2000ms) */
    waitAfterClick?: number;
    /** Number of retry attempts (default: 3) */
    retries?: number;
    /** Delay between retries (default: 1000ms) */
    retryDelay?: number;
  }) => Promise<TurnstileSolveResult>;
}

/**
 * Create the util object for a playwright-js execution context.
 *
 * @param page - Playwright Page object to bind utilities to
 * @returns Utility object with bound methods
 */
export function createPlaywrightJsUtil(page: Page): PlaywrightJsUtil {
  return {
    detectCloudflareTurnstile: (options) => detectCloudflareTurnstile(page, options),
    solveCloudflareTurnstile: (options) => solveCloudflareTurnstile(page, options),
  };
}

export type { TurnstileDetectionResult, TurnstileSolveResult };
