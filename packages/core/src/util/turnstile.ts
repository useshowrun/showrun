/**
 * Cloudflare Turnstile detection and solving utilities.
 *
 * Turnstile is Cloudflare's CAPTCHA alternative. This module provides
 * image-based detection of the Turnstile widget checkbox position,
 * useful when shadow-DOM inspection is blocked.
 *
 * Strategy:
 * 1. Screenshot the page
 * 2. Detect the widget by its characteristic light/dark gray background
 * 3. Find the checkbox at a fixed offset from the widget's left edge
 * 4. Click the detected position
 */

import type { Page } from 'playwright';

export interface TurnstileDetectionResult {
  found: boolean;
  /** Checkbox center X coordinate (page pixels) */
  x?: number;
  /** Checkbox center Y coordinate (page pixels) */
  y?: number;
  /** Detected widget bounds */
  widget?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Detected theme: 'light' or 'dark' */
  theme?: 'light' | 'dark';
  /** Error message if detection failed */
  error?: string;
}

export interface TurnstileSolveResult {
  success: boolean;
  /** Whether Turnstile was detected */
  detected: boolean;
  /** Checkbox position that was clicked */
  clickedAt?: { x: number; y: number };
  /** Error message if solving failed */
  error?: string;
}

interface WidgetBand {
  startY: number;
  endY: number;
  rows: Array<{ y: number; count: number; minX: number; maxX: number }>;
}

/**
 * Check if RGB values match light theme widget background.
 * Light theme: ~RGB(245-252, 245-252, 245-252)
 */
function isLightThemePixel(r: number, g: number, b: number): boolean {
  return (
    r >= 245 && r <= 252 &&
    g >= 245 && g <= 252 &&
    b >= 245 && b <= 252 &&
    Math.abs(r - g) < 5 &&
    Math.abs(g - b) < 5
  );
}

/**
 * Check if RGB values match dark theme widget background.
 * Dark theme: ~RGB(45-55, 45-55, 45-55)
 */
function isDarkThemePixel(r: number, g: number, b: number): boolean {
  return (
    r >= 45 && r <= 55 &&
    g >= 45 && g <= 55 &&
    b >= 45 && b <= 55 &&
    Math.abs(r - g) < 5 &&
    Math.abs(g - b) < 5
  );
}

/**
 * Detect Turnstile widget from raw pixel data.
 */
function detectFromPixels(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  scale: number,
): TurnstileDetectionResult {
  // Step 1: Find rows with widget background pixels (try light theme first)
  for (const theme of ['light', 'dark'] as const) {
    const isWidgetPixel = theme === 'light' ? isLightThemePixel : isDarkThemePixel;

    const rowData: Array<{ y: number; count: number; minX: number; maxX: number }> = [];

    for (let y = 0; y < height; y++) {
      let count = 0;
      let minX = width;
      let maxX = 0;

      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        if (isWidgetPixel(r, g, b)) {
          count++;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }

      if (count > 100 * scale) {
        rowData.push({ y, count, minX, maxX });
      }
    }

    if (rowData.length === 0) continue;

    // Step 2: Find contiguous bands
    const bands: WidgetBand[] = [];
    let currentBand: WidgetBand | null = null;

    for (const row of rowData) {
      if (!currentBand) {
        currentBand = { startY: row.y, endY: row.y, rows: [row] };
      } else if (row.y - currentBand.endY <= 2) {
        currentBand.endY = row.y;
        currentBand.rows.push(row);
      } else {
        bands.push(currentBand);
        currentBand = { startY: row.y, endY: row.y, rows: [row] };
      }
    }
    if (currentBand) bands.push(currentBand);

    // Step 3: Filter to bands matching Turnstile dimensions
    // Height: 40-100px (scaled), Width: 200-400px (scaled)
    const widgetBands = bands.filter((b) => {
      const h = b.endY - b.startY;
      const minX = Math.min(...b.rows.map((r) => r.minX));
      const maxX = Math.max(...b.rows.map((r) => r.maxX));
      const w = maxX - minX;
      return h >= 40 * scale && h <= 100 * scale && w >= 200 * scale && w <= 400 * scale;
    });

    if (widgetBands.length === 0) continue;

    // Use the first matching band
    const widgetBand = widgetBands[0];
    const allMinX = Math.min(...widgetBand.rows.map((r) => r.minX));
    const allMaxX = Math.max(...widgetBand.rows.map((r) => r.maxX));

    const widget = {
      x: allMinX,
      y: widgetBand.startY,
      width: allMaxX - allMinX,
      height: widgetBand.endY - widgetBand.startY,
    };

    // Step 4: Checkbox is ~40px from left edge, centered vertically
    const checkboxOffsetX = 40 * scale;
    const checkboxCenterX = widget.x + checkboxOffsetX;
    const checkboxCenterY = widget.y + Math.round(widget.height / 2);

    return {
      found: true,
      x: checkboxCenterX,
      y: checkboxCenterY,
      widget,
      theme,
    };
  }

  return { found: false, error: 'No Turnstile widget detected' };
}

/**
 * Detect Cloudflare Turnstile checkbox position on the page.
 *
 * Uses image-based detection since Turnstile uses shadow-DOM
 * which blocks direct element inspection.
 *
 * @param page - Playwright Page object
 * @param options - Detection options
 * @returns Detection result with checkbox coordinates
 *
 * @example
 * ```typescript
 * const result = await detectCloudflareTurnstile(page);
 * if (result.found) {
 *   await page.mouse.click(result.x, result.y);
 * }
 * ```
 */
export async function detectCloudflareTurnstile(
  page: Page,
  options: { scale?: number } = {},
): Promise<TurnstileDetectionResult> {
  const scale = options.scale ?? 1;

  try {
    // Take a screenshot and get raw pixel data
    const screenshot = await page.screenshot({ type: 'png' });

    // We need to decode the PNG to get raw pixel data
    // Use dynamic import for sharp to avoid hard dependency
    let sharpModule: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sharpModule = require('sharp');
    } catch {
      return {
        found: false,
        error: 'sharp module not available for image processing',
      };
    }

    const sharp = sharpModule;
    const { data, info } = await sharp(screenshot)
      .raw()
      .toBuffer({ resolveWithObject: true }) as { data: Buffer; info: { width: number; height: number; channels: number } };

    return detectFromPixels(
      new Uint8Array(data),
      info.width,
      info.height,
      info.channels,
      scale,
    );
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Detect and solve Cloudflare Turnstile by clicking the checkbox.
 *
 * This function:
 * 1. Detects the Turnstile widget using image analysis
 * 2. Clicks the checkbox
 * 3. Waits briefly for the verification to process
 *
 * @param page - Playwright Page object
 * @param options - Solve options
 * @returns Solve result indicating success/failure
 *
 * @example
 * ```typescript
 * const result = await solveCloudflareTurnstile(page);
 * if (result.success) {
 *   console.log('Turnstile solved!');
 * } else {
 *   console.log('Failed:', result.error);
 * }
 * ```
 */
export async function solveCloudflareTurnstile(
  page: Page,
  options: {
    /** Scale factor for HiDPI displays (default: 1) */
    scale?: number;
    /** Time to wait after clicking (default: 2000ms) */
    waitAfterClick?: number;
    /** Number of retry attempts (default: 3) */
    retries?: number;
    /** Delay between retries (default: 1000ms) */
    retryDelay?: number;
  } = {},
): Promise<TurnstileSolveResult> {
  const {
    scale = 1,
    waitAfterClick = 2000,
    retries = 3,
    retryDelay = 1000,
  } = options;

  for (let attempt = 0; attempt < retries; attempt++) {
    // Detect the Turnstile widget
    const detection = await detectCloudflareTurnstile(page, { scale });

    if (!detection.found) {
      // Maybe the page hasn't loaded yet, wait and retry
      if (attempt < retries - 1) {
        await page.waitForTimeout(retryDelay);
        continue;
      }
      return {
        success: false,
        detected: false,
        error: detection.error || 'Turnstile widget not found',
      };
    }

    // Click the checkbox
    try {
      await page.mouse.click(detection.x!, detection.y!);

      // Wait for verification
      await page.waitForTimeout(waitAfterClick);

      return {
        success: true,
        detected: true,
        clickedAt: { x: detection.x!, y: detection.y! },
      };
    } catch (error) {
      if (attempt < retries - 1) {
        await page.waitForTimeout(retryDelay);
        continue;
      }
      return {
        success: false,
        detected: true,
        clickedAt: { x: detection.x!, y: detection.y! },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    success: false,
    detected: false,
    error: 'Max retries exceeded',
  };
}

/**
 * Utility object exposed to playwright-js flows via context.util
 */
export const turnstileUtil = {
  detectCloudflareTurnstile,
  solveCloudflareTurnstile,
};
