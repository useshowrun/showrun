/**
 * Target resolution utilities
 * Converts Target types to Playwright Locators
 */

import type { Locator, Page, Frame } from 'playwright';
import type { Target, TargetOrAnyOf } from './types.js';

/**
 * Type that can resolve locators (Page, Frame, or Locator)
 */
export type LocatorSource = Page | Frame | Locator;

/**
 * Check if the source is a Page (has goto method)
 */
function isPage(source: LocatorSource): source is Page {
  return 'goto' in source && typeof source.goto === 'function';
}

/**
 * Check if the source is a Frame (has url method but not goto)
 */
function isFrame(source: LocatorSource): source is Frame {
  return 'url' in source && typeof source.url === 'function' && !('goto' in source);
}

/**
 * Resolves a single Target to a Playwright Locator
 */
export function resolveTarget(
  source: LocatorSource,
  target: Target
): Locator {
  // Check if it's a Page or Frame (both have similar locator methods)
  if (isPage(source) || isFrame(source)) {
    switch (target.kind) {
      case 'css':
        return source.locator(target.selector);
      case 'text':
        return source.getByText(target.text, { exact: target.exact ?? false });
      case 'role':
        return source.getByRole(target.role, {
          name: target.name,
          exact: target.exact ?? false,
        });
      case 'label':
        return source.getByLabel(target.text, { exact: target.exact ?? false });
      case 'placeholder':
        return source.getByPlaceholder(target.text, { exact: target.exact ?? false });
      case 'altText':
        return source.getByAltText(target.text, { exact: target.exact ?? false });
      case 'testId':
        return source.getByTestId(target.id);
      default:
        const _exhaustive: never = target;
        throw new Error(`Unknown target kind: ${(_exhaustive as Target).kind}`);
    }
  } else {
    // It's a Locator
    const locator = source as Locator;
    switch (target.kind) {
      case 'css':
        return locator.locator(target.selector);
      case 'text':
        return locator.getByText(target.text, { exact: target.exact ?? false });
      case 'role':
        return locator.getByRole(target.role, {
          name: target.name,
          exact: target.exact ?? false,
        });
      case 'label':
        return locator.getByLabel(target.text, { exact: target.exact ?? false });
      case 'placeholder':
        return locator.getByPlaceholder(target.text, { exact: target.exact ?? false });
      case 'altText':
        return locator.getByAltText(target.text, { exact: target.exact ?? false });
      case 'testId':
        return locator.getByTestId(target.id);
      default:
        const _exhaustive: never = target;
        throw new Error(`Unknown target kind: ${(_exhaustive as Target).kind}`);
    }
  }
}

/**
 * Resolves TargetOrAnyOf with fallback support
 * Tries each target in order until one yields at least one element
 */
export async function resolveTargetWithFallback(
  source: LocatorSource,
  targetOrAnyOf: TargetOrAnyOf,
  scope?: Target
): Promise<{ locator: Locator; matchedTarget: Target; matchedCount: number }> {
  // Resolve scope first if provided
  const baseLocator = scope ? resolveTarget(source, scope) : source;

  // Handle single target
  if (!('anyOf' in targetOrAnyOf)) {
    const locator = resolveTarget(baseLocator, targetOrAnyOf);
    const count = await locator.count();
    return { locator, matchedTarget: targetOrAnyOf, matchedCount: count };
  }

  // Handle anyOf fallback
  const targets = targetOrAnyOf.anyOf;
  let lastError: Error | null = null;

  for (const target of targets) {
    try {
      const locator = resolveTarget(baseLocator, target);
      const count = await locator.count();
      if (count > 0) {
        return { locator, matchedTarget: target, matchedCount: count };
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Continue to next target
    }
  }

  // None matched
  throw new Error(
    `No target matched. Tried ${targets.length} target(s). ${lastError ? `Last error: ${lastError.message}` : ''}`
  );
}

/**
 * Converts legacy selector string to Target for backward compatibility
 */
export function selectorToTarget(selector: string): Target {
  return { kind: 'css', selector };
}
