/**
 * Templating for DSL steps using Nunjucks renderString only.
 * Supports {{inputs.key}} / {{vars.key}} and built-in filters (e.g. {{inputs.x | urlencode}}).
 * Uses a minimal Environment with no loaders. Custom filters are limited to safe, pure functions.
 */

import nunjucks from 'nunjucks';
import { authenticator } from 'otplib';
import type { VariableContext } from './types.js';

/** Minimal env: null loader (renderString only), allow undefined for optional inputs. */
const env = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,  // Allow undefined values to render as empty string
});

/**
 * TOTP filter: generates a 6-digit TOTP code from a base32 secret.
 * Usage: {{secret.TOTP_KEY | totp}}
 *
 * This is a pure function (RFC 6238) - no code execution risk.
 */
env.addFilter('totp', (secret: string): string => {
  if (!secret || typeof secret !== 'string') {
    throw new Error('totp filter requires a non-empty string (base32 secret)');
  }
  try {
    return authenticator.generate(secret.trim().replace(/\s/g, ''));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`TOTP generation failed: ${msg}`);
  }
});

/**
 * Resolves a template string using variable context (Nunjucks renderString).
 * Built-in filters available, e.g. {{ inputs.page | urlencode }}.
 * Supports: {{inputs.x}}, {{vars.x}}, {{secret.x}}
 */
export function resolveTemplate(template: string, context: VariableContext): string {
  try {
    return env.renderString(template, {
      inputs: context.inputs,
      vars: context.vars,
      secret: context.secrets || {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Template resolution failed: ${msg}`);
  }
}

/**
 * Recursively resolves templates in an object (strings use Nunjucks renderString).
 */
export function resolveTemplates<T>(obj: T, context: VariableContext): T {
  if (typeof obj === 'string') {
    return resolveTemplate(obj, context) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveTemplates(item, context)) as T;
  }

  if (obj && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveTemplates(value, context);
    }
    return resolved as T;
  }

  return obj;
}

/**
 * Checks if a string contains template syntax ({{ ... }}).
 */
export function hasTemplate(str: string): boolean {
  return typeof str === 'string' && str.includes('{{');
}
