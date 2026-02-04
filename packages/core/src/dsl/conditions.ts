/**
 * Condition evaluator for skip_if conditions
 *
 * Evaluates skip conditions to determine if a step should be skipped.
 */

import type { Page } from 'playwright';
import type { SkipCondition, TargetOrAnyOf, Target } from './types.js';
import { resolveTarget } from './target.js';

/**
 * Timeout for element checks (1 second - fast fail)
 */
const ELEMENT_CHECK_TIMEOUT_MS = 1000;

/**
 * Context for condition evaluation
 */
export interface ConditionContext {
  /**
   * Playwright page
   */
  page: Page;
  /**
   * Current variable values
   */
  vars: Record<string, unknown>;
}

/**
 * Evaluates a skip condition
 *
 * @param ctx - Condition context with page and vars
 * @param condition - The condition to evaluate
 * @returns true if the condition is met (step should be skipped), false otherwise
 */
export async function evaluateCondition(
  ctx: ConditionContext,
  condition: SkipCondition
): Promise<boolean> {
  // URL conditions
  if ('url_includes' in condition) {
    const currentUrl = ctx.page.url();
    return currentUrl.includes(condition.url_includes);
  }

  if ('url_matches' in condition) {
    const currentUrl = ctx.page.url();
    try {
      const regex = new RegExp(condition.url_matches);
      return regex.test(currentUrl);
    } catch {
      console.warn(`[conditions] Invalid regex in url_matches: ${condition.url_matches}`);
      return false;
    }
  }

  // Element conditions
  if ('element_visible' in condition) {
    return await isElementVisible(ctx.page, condition.element_visible);
  }

  if ('element_exists' in condition) {
    return await elementExists(ctx.page, condition.element_exists);
  }

  // Variable conditions
  if ('var_equals' in condition) {
    const { name, value } = condition.var_equals;
    const actualValue = ctx.vars[name];
    return actualValue === value;
  }

  if ('var_truthy' in condition) {
    const value = ctx.vars[condition.var_truthy];
    return Boolean(value);
  }

  if ('var_falsy' in condition) {
    const value = ctx.vars[condition.var_falsy];
    return !value;
  }

  // Compound conditions
  if ('all' in condition) {
    for (const subCondition of condition.all) {
      const result = await evaluateCondition(ctx, subCondition);
      if (!result) return false;
    }
    return true;
  }

  if ('any' in condition) {
    for (const subCondition of condition.any) {
      const result = await evaluateCondition(ctx, subCondition);
      if (result) return true;
    }
    return false;
  }

  // Unknown condition type
  console.warn('[conditions] Unknown condition type:', condition);
  return false;
}

/**
 * Resolves a TargetOrAnyOf to a Playwright Locator
 * Handles both single targets and anyOf arrays
 */
function resolveTargetOrAnyOf(page: Page, target: TargetOrAnyOf) {
  if ('anyOf' in target) {
    // For anyOf, try the first one (we just need to check existence/visibility)
    // The condition is met if ANY of the targets match
    return target.anyOf.map((t) => resolveTarget(page, t));
  }
  return [resolveTarget(page, target as Target)];
}

/**
 * Checks if an element is visible on the page
 */
async function isElementVisible(page: Page, target: TargetOrAnyOf): Promise<boolean> {
  try {
    const locators = resolveTargetOrAnyOf(page, target);
    // Check if any locator is visible
    for (const locator of locators) {
      try {
        const isVisible = await locator.first().isVisible({ timeout: ELEMENT_CHECK_TIMEOUT_MS });
        if (isVisible) return true;
      } catch {
        // Continue to next locator
      }
    }
    return false;
  } catch {
    // Element not found or timeout - not visible
    return false;
  }
}

/**
 * Checks if an element exists in the DOM (visible or not)
 */
async function elementExists(page: Page, target: TargetOrAnyOf): Promise<boolean> {
  try {
    const locators = resolveTargetOrAnyOf(page, target);
    // Check if any locator has matches
    for (const locator of locators) {
      try {
        const count = await locator.count();
        if (count > 0) return true;
      } catch {
        // Continue to next locator
      }
    }
    return false;
  } catch {
    // Error resolving target - doesn't exist
    return false;
  }
}

/**
 * Converts a condition to a human-readable string for logging
 */
export function conditionToString(condition: SkipCondition): string {
  if ('url_includes' in condition) {
    return `url_includes("${condition.url_includes}")`;
  }
  if ('url_matches' in condition) {
    return `url_matches("${condition.url_matches}")`;
  }
  if ('element_visible' in condition) {
    return `element_visible(${JSON.stringify(condition.element_visible)})`;
  }
  if ('element_exists' in condition) {
    return `element_exists(${JSON.stringify(condition.element_exists)})`;
  }
  if ('var_equals' in condition) {
    return `var_equals(${condition.var_equals.name}, ${JSON.stringify(condition.var_equals.value)})`;
  }
  if ('var_truthy' in condition) {
    return `var_truthy("${condition.var_truthy}")`;
  }
  if ('var_falsy' in condition) {
    return `var_falsy("${condition.var_falsy}")`;
  }
  if ('all' in condition) {
    return `all(${condition.all.map(conditionToString).join(', ')})`;
  }
  if ('any' in condition) {
    return `any(${condition.any.map(conditionToString).join(', ')})`;
  }
  return JSON.stringify(condition);
}
