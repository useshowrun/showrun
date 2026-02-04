import type { DslStep, Target, TargetOrAnyOf, SkipCondition } from './types.js';

/**
 * Validation errors
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validates a Target object
 */
function validateTarget(target: unknown): target is Target {
  if (!target || typeof target !== 'object') {
    throw new ValidationError('Target must be an object');
  }

  const t = target as Record<string, unknown>;

  if (typeof t.kind !== 'string') {
    throw new ValidationError('Target must have a string "kind"');
  }

  switch (t.kind) {
    case 'css':
      if (typeof t.selector !== 'string' || !t.selector) {
        throw new ValidationError('CSS target must have a non-empty string "selector"');
      }
      break;

    case 'text':
      if (typeof t.text !== 'string' || !t.text) {
        throw new ValidationError('Text target must have a non-empty string "text"');
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        throw new ValidationError('Text target "exact" must be a boolean');
      }
      break;

    case 'role':
      const validRoles = [
        'button', 'checkbox', 'combobox', 'dialog', 'gridcell', 'link', 'listbox',
        'menuitem', 'option', 'radio', 'searchbox', 'slider', 'switch', 'tab',
        'tabpanel', 'textbox', 'treeitem', 'article', 'banner', 'complementary',
        'contentinfo', 'form', 'main', 'navigation', 'region', 'search', 'alert',
        'log', 'marquee', 'status', 'timer'
      ];
      if (!validRoles.includes(t.role as string)) {
        throw new ValidationError(`Role target must have a valid role: ${validRoles.join(', ')}`);
      }
      if (t.name !== undefined && typeof t.name !== 'string') {
        throw new ValidationError('Role target "name" must be a string');
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        throw new ValidationError('Role target "exact" must be a boolean');
      }
      break;

    case 'label':
      if (typeof t.text !== 'string' || !t.text) {
        throw new ValidationError('Label target must have a non-empty string "text"');
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        throw new ValidationError('Label target "exact" must be a boolean');
      }
      break;

    case 'placeholder':
      if (typeof t.text !== 'string' || !t.text) {
        throw new ValidationError('Placeholder target must have a non-empty string "text"');
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        throw new ValidationError('Placeholder target "exact" must be a boolean');
      }
      break;

    case 'altText':
      if (typeof t.text !== 'string' || !t.text) {
        throw new ValidationError('AltText target must have a non-empty string "text"');
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        throw new ValidationError('AltText target "exact" must be a boolean');
      }
      break;

    case 'testId':
      if (typeof t.id !== 'string' || !t.id) {
        throw new ValidationError('TestId target must have a non-empty string "id"');
      }
      break;

    default:
      throw new ValidationError(`Unknown target kind: ${t.kind}`);
  }

  return true;
}

/**
 * Validates TargetOrAnyOf (single target or anyOf array)
 */
function validateTargetOrAnyOf(targetOrAnyOf: unknown): void {
  if (!targetOrAnyOf) {
    return; // Optional, so empty is OK
  }

  if (typeof targetOrAnyOf === 'object' && 'anyOf' in targetOrAnyOf) {
    const anyOf = (targetOrAnyOf as { anyOf: unknown }).anyOf;
    if (!Array.isArray(anyOf) || anyOf.length === 0) {
      throw new ValidationError('Target "anyOf" must be a non-empty array');
    }
    for (const target of anyOf) {
      validateTarget(target);
    }
  } else {
    validateTarget(targetOrAnyOf);
  }
}

/**
 * Validates a SkipCondition
 */
function validateSkipCondition(condition: unknown): void {
  if (!condition || typeof condition !== 'object') {
    throw new ValidationError('skip_if condition must be an object');
  }

  const c = condition as Record<string, unknown>;
  const keys = Object.keys(c);

  if (keys.length !== 1) {
    throw new ValidationError('skip_if condition must have exactly one key');
  }

  const key = keys[0];

  switch (key) {
    case 'url_includes':
      if (typeof c.url_includes !== 'string' || !c.url_includes) {
        throw new ValidationError('skip_if "url_includes" must be a non-empty string');
      }
      break;

    case 'url_matches':
      if (typeof c.url_matches !== 'string' || !c.url_matches) {
        throw new ValidationError('skip_if "url_matches" must be a non-empty string');
      }
      // Validate it's a valid regex
      try {
        new RegExp(c.url_matches);
      } catch {
        throw new ValidationError('skip_if "url_matches" must be a valid regex');
      }
      break;

    case 'element_visible':
      validateTargetOrAnyOf(c.element_visible);
      break;

    case 'element_exists':
      validateTargetOrAnyOf(c.element_exists);
      break;

    case 'var_equals':
      if (!c.var_equals || typeof c.var_equals !== 'object') {
        throw new ValidationError('skip_if "var_equals" must be an object');
      }
      const varEquals = c.var_equals as Record<string, unknown>;
      if (typeof varEquals.name !== 'string' || !varEquals.name) {
        throw new ValidationError('skip_if "var_equals.name" must be a non-empty string');
      }
      if (varEquals.value === undefined) {
        throw new ValidationError('skip_if "var_equals.value" is required');
      }
      break;

    case 'var_truthy':
      if (typeof c.var_truthy !== 'string' || !c.var_truthy) {
        throw new ValidationError('skip_if "var_truthy" must be a non-empty string');
      }
      break;

    case 'var_falsy':
      if (typeof c.var_falsy !== 'string' || !c.var_falsy) {
        throw new ValidationError('skip_if "var_falsy" must be a non-empty string');
      }
      break;

    case 'all':
      if (!Array.isArray(c.all) || c.all.length === 0) {
        throw new ValidationError('skip_if "all" must be a non-empty array');
      }
      for (const subCondition of c.all) {
        validateSkipCondition(subCondition);
      }
      break;

    case 'any':
      if (!Array.isArray(c.any) || c.any.length === 0) {
        throw new ValidationError('skip_if "any" must be a non-empty array');
      }
      for (const subCondition of c.any) {
        validateSkipCondition(subCondition);
      }
      break;

    default:
      throw new ValidationError(
        `Unknown skip_if condition type: ${key}. Valid types: url_includes, url_matches, element_visible, element_exists, var_equals, var_truthy, var_falsy, all, any`
      );
  }
}

/**
 * Validates a single step
 */
function validateStep(step: unknown): step is DslStep {
  if (!step || typeof step !== 'object') {
    throw new ValidationError('Step must be an object');
  }

  const s = step as Record<string, unknown>;

  // Check required fields
  if (typeof s.id !== 'string' || !s.id) {
    throw new ValidationError('Step must have a non-empty string "id"');
  }

  if (typeof s.type !== 'string' || !s.type) {
    throw new ValidationError('Step must have a non-empty string "type"');
  }

  // Validate optional common fields
  if (s.label !== undefined && typeof s.label !== 'string') {
    throw new ValidationError('Step "label" must be a string');
  }
  if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== 'number' || s.timeoutMs < 0)) {
    throw new ValidationError('Step "timeoutMs" must be a non-negative number');
  }
  if (s.optional !== undefined && typeof s.optional !== 'boolean') {
    throw new ValidationError('Step "optional" must be a boolean');
  }
  if (s.onError !== undefined) {
    if (s.onError !== 'stop' && s.onError !== 'continue') {
      throw new ValidationError('Step "onError" must be "stop" or "continue"');
    }
  }
  if (s.once !== undefined) {
    if (s.once !== 'session' && s.once !== 'profile') {
      throw new ValidationError('Step "once" must be "session" or "profile"');
    }
  }
  if (s.skip_if !== undefined) {
    validateSkipCondition(s.skip_if);
  }

  if (!s.params || typeof s.params !== 'object') {
    throw new ValidationError('Step must have a "params" object');
  }

  const params = s.params as Record<string, unknown>;

  // Validate step type and params
  switch (s.type) {
    case 'navigate':
      if (typeof params.url !== 'string' || !params.url) {
        throw new ValidationError('Navigate step must have a non-empty string "url" in params');
      }
      if (params.waitUntil !== undefined) {
        const validWaitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'];
        if (!validWaitUntil.includes(params.waitUntil as string)) {
          throw new ValidationError(
            `Navigate step "waitUntil" must be one of: ${validWaitUntil.join(', ')}`
          );
        }
      }
      break;

    case 'extract_title':
      if (typeof params.out !== 'string' || !params.out) {
        throw new ValidationError('ExtractTitle step must have a non-empty string "out" in params');
      }
      break;

    case 'extract_text':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        throw new ValidationError('ExtractText step must have either "selector" or "target" in params');
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('ExtractText step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (typeof params.out !== 'string' || !params.out) {
        throw new ValidationError('ExtractText step must have a non-empty string "out" in params');
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        throw new ValidationError('ExtractText step "first" must be a boolean');
      }
      if (params.trim !== undefined && typeof params.trim !== 'boolean') {
        throw new ValidationError('ExtractText step "trim" must be a boolean');
      }
      if (params.default !== undefined && typeof params.default !== 'string') {
        throw new ValidationError('ExtractText step "default" must be a string');
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('ExtractText step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          throw new ValidationError('ExtractText step "near" must be an object with kind: "text"');
        }
        if (typeof near.text !== 'string') {
          throw new ValidationError('ExtractText step "near.text" must be a string');
        }
        if (near.exact !== undefined && typeof near.exact !== 'boolean') {
          throw new ValidationError('ExtractText step "near.exact" must be a boolean');
        }
      }
      break;

    case 'sleep':
      if (typeof params.durationMs !== 'number' || params.durationMs < 0) {
        throw new ValidationError(
          'Sleep step must have a non-negative number "durationMs" in params'
        );
      }
      break;

    case 'wait_for':
      if (!params.selector && !params.target && !params.url && !params.loadState) {
        throw new ValidationError(
          'WaitFor step must have one of: selector, target, url, or loadState'
        );
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('WaitFor step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('WaitFor step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          throw new ValidationError('WaitFor step "near" must be an object with kind: "text"');
        }
        if (typeof near.text !== 'string') {
          throw new ValidationError('WaitFor step "near.text" must be a string');
        }
        if (near.exact !== undefined && typeof near.exact !== 'boolean') {
          throw new ValidationError('WaitFor step "near.exact" must be a boolean');
        }
      }
      if (params.visible !== undefined && typeof params.visible !== 'boolean') {
        throw new ValidationError('WaitFor step "visible" must be a boolean');
      }
      if (params.url !== undefined && params.url !== null) {
        if (typeof params.url === 'string') {
          // Valid string URL
        } else if (typeof params.url === 'object') {
          const urlObj = params.url as Record<string, unknown>;
          if (typeof urlObj.pattern !== 'string') {
            throw new ValidationError('WaitFor step "url" object must have a string "pattern"');
          }
          if (urlObj.exact !== undefined && typeof urlObj.exact !== 'boolean') {
            throw new ValidationError('WaitFor step "url" object "exact" must be a boolean');
          }
        } else {
          throw new ValidationError('WaitFor step "url" must be a string or object with pattern');
        }
      }
      if (params.loadState !== undefined) {
        const validLoadStates = ['load', 'domcontentloaded', 'networkidle'];
        if (!validLoadStates.includes(params.loadState as string)) {
          throw new ValidationError(
            `WaitFor step "loadState" must be one of: ${validLoadStates.join(', ')}`
          );
        }
      }
      if (params.timeoutMs !== undefined && (typeof params.timeoutMs !== 'number' || params.timeoutMs < 0)) {
        throw new ValidationError('WaitFor step "timeoutMs" must be a non-negative number');
      }
      break;

    case 'click':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        throw new ValidationError('Click step must have either "selector" or "target" in params');
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('Click step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        throw new ValidationError('Click step "first" must be a boolean');
      }
      if (params.waitForVisible !== undefined && typeof params.waitForVisible !== 'boolean') {
        throw new ValidationError('Click step "waitForVisible" must be a boolean');
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('Click step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          throw new ValidationError('Click step "near" must be an object with kind: "text"');
        }
        if (typeof near.text !== 'string') {
          throw new ValidationError('Click step "near.text" must be a string');
        }
        if (near.exact !== undefined && typeof near.exact !== 'boolean') {
          throw new ValidationError('Click step "near.exact" must be a boolean');
        }
      }
      break;

    case 'fill':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        throw new ValidationError('Fill step must have either "selector" or "target" in params');
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('Fill step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (typeof params.value !== 'string') {
        throw new ValidationError('Fill step must have a string "value" in params');
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        throw new ValidationError('Fill step "first" must be a boolean');
      }
      if (params.clear !== undefined && typeof params.clear !== 'boolean') {
        throw new ValidationError('Fill step "clear" must be a boolean');
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('Fill step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          throw new ValidationError('Fill step "near" must be an object with kind: "text"');
        }
        if (typeof near.text !== 'string') {
          throw new ValidationError('Fill step "near.text" must be a string');
        }
        if (near.exact !== undefined && typeof near.exact !== 'boolean') {
          throw new ValidationError('Fill step "near.exact" must be a boolean');
        }
      }
      break;

    case 'extract_attribute':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        throw new ValidationError('ExtractAttribute step must have either "selector" or "target" in params');
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('ExtractAttribute step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (typeof params.attribute !== 'string' || !params.attribute) {
        throw new ValidationError(
          'ExtractAttribute step must have a non-empty string "attribute" in params'
        );
      }
      if (typeof params.out !== 'string' || !params.out) {
        throw new ValidationError('ExtractAttribute step must have a non-empty string "out" in params');
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        throw new ValidationError('ExtractAttribute step "first" must be a boolean');
      }
      if (params.default !== undefined && typeof params.default !== 'string') {
        throw new ValidationError('ExtractAttribute step "default" must be a string');
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('ExtractAttribute step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          throw new ValidationError('ExtractAttribute step "near" must be an object with kind: "text"');
        }
        if (typeof near.text !== 'string') {
          throw new ValidationError('ExtractAttribute step "near.text" must be a string');
        }
        if (near.exact !== undefined && typeof near.exact !== 'boolean') {
          throw new ValidationError('ExtractAttribute step "near.exact" must be a boolean');
        }
      }
      break;

    case 'assert':
      if (!params.selector && !params.target && !params.urlIncludes) {
        throw new ValidationError('Assert step must have at least one of: selector, target, or urlIncludes');
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('Assert step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (params.visible !== undefined && typeof params.visible !== 'boolean') {
        throw new ValidationError('Assert step "visible" must be a boolean');
      }
      if (params.textIncludes !== undefined && typeof params.textIncludes !== 'string') {
        throw new ValidationError('Assert step "textIncludes" must be a string');
      }
      if (params.urlIncludes !== undefined && typeof params.urlIncludes !== 'string') {
        throw new ValidationError('Assert step "urlIncludes" must be a string');
      }
      if (params.message !== undefined && typeof params.message !== 'string') {
        throw new ValidationError('Assert step "message" must be a string');
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('Assert step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          throw new ValidationError('Assert step "near" must be an object with kind: "text"');
        }
        if (typeof near.text !== 'string') {
          throw new ValidationError('Assert step "near.text" must be a string');
        }
        if (near.exact !== undefined && typeof near.exact !== 'boolean') {
          throw new ValidationError('Assert step "near.exact" must be a boolean');
        }
      }
      break;

    case 'set_var':
      if (typeof params.name !== 'string' || !params.name) {
        throw new ValidationError('SetVar step must have a non-empty string "name" in params');
      }
      const valueType = typeof params.value;
      if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
        throw new ValidationError('SetVar step "value" must be a string, number, or boolean');
      }
      break;

    case 'network_find':
      if (!params.where || typeof params.where !== 'object') {
        throw new ValidationError('NetworkFind step must have a "where" object in params');
      }
      const where = params.where as Record<string, unknown>;
      if (where.urlIncludes !== undefined && typeof where.urlIncludes !== 'string') {
        throw new ValidationError('NetworkFind step "where.urlIncludes" must be a string');
      }
      if (where.urlRegex !== undefined) {
        if (typeof where.urlRegex !== 'string') {
          throw new ValidationError('NetworkFind step "where.urlRegex" must be a string');
        }
        try {
          new RegExp(where.urlRegex);
        } catch {
          throw new ValidationError('NetworkFind step "where.urlRegex" is not a valid regex');
        }
      }
      if (where.method !== undefined) {
        const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
        if (!validMethods.includes(where.method as string)) {
          throw new ValidationError(`NetworkFind step "where.method" must be one of: ${validMethods.join(', ')}`);
        }
      }
      if (where.status !== undefined && (typeof where.status !== 'number' || where.status < 0)) {
        throw new ValidationError('NetworkFind step "where.status" must be a non-negative number');
      }
      if (where.contentTypeIncludes !== undefined && typeof where.contentTypeIncludes !== 'string') {
        throw new ValidationError('NetworkFind step "where.contentTypeIncludes" must be a string');
      }
      if (where.responseContains !== undefined) {
        if (typeof where.responseContains !== 'string') {
          throw new ValidationError('NetworkFind step "where.responseContains" must be a string');
        }
        if (where.responseContains.length > 2000) {
          throw new ValidationError('NetworkFind step "where.responseContains" must be at most 2000 characters');
        }
      }
      if (params.pick !== undefined && params.pick !== 'first' && params.pick !== 'last') {
        throw new ValidationError('NetworkFind step "pick" must be "first" or "last"');
      }
      if (typeof params.saveAs !== 'string' || !params.saveAs) {
        throw new ValidationError('NetworkFind step must have a non-empty string "saveAs" in params');
      }
      if (params.saveAs.length > 500) {
        throw new ValidationError('NetworkFind step "saveAs" must be at most 500 characters');
      }
      if (params.waitForMs !== undefined && (typeof params.waitForMs !== 'number' || params.waitForMs < 0)) {
        throw new ValidationError('NetworkFind step "waitForMs" must be a non-negative number');
      }
      if (params.pollIntervalMs !== undefined && (typeof params.pollIntervalMs !== 'number' || params.pollIntervalMs < 100)) {
        throw new ValidationError('NetworkFind step "pollIntervalMs" must be at least 100');
      }
      break;

    case 'network_replay':
      if (typeof params.requestId !== 'string' || !params.requestId) {
        throw new ValidationError('NetworkReplay step must have a non-empty string "requestId" in params');
      }
      if (params.requestId.length > 2000) {
        throw new ValidationError('NetworkReplay step "requestId" must be at most 2000 characters');
      }
      const SENSITIVE_HEADERS = new Set([
        'authorization',
        'cookie',
        'set-cookie',
        'x-api-key',
        'proxy-authorization',
      ]);
      if (params.overrides && typeof params.overrides === 'object') {
        const overrides = params.overrides as Record<string, unknown>;
        if (overrides.setHeaders && typeof overrides.setHeaders === 'object') {
          for (const key of Object.keys(overrides.setHeaders as Record<string, unknown>)) {
            if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
              throw new ValidationError(`NetworkReplay step "overrides.setHeaders" cannot set sensitive header: ${key}`);
            }
          }
        }
        if (overrides.urlReplace !== undefined) {
          if (typeof overrides.urlReplace !== 'object' || overrides.urlReplace === null) {
            throw new ValidationError('NetworkReplay step "overrides.urlReplace" must be { find: string, replace: string }');
          }
          const ur = overrides.urlReplace as Record<string, unknown>;
          if (typeof ur.find !== 'string' || typeof ur.replace !== 'string') {
            throw new ValidationError('NetworkReplay step "overrides.urlReplace" must have string "find" and "replace"');
          }
          try {
            new RegExp(ur.find);
          } catch {
            throw new ValidationError('NetworkReplay step "overrides.urlReplace.find" is not a valid regex');
          }
        }
        if (overrides.bodyReplace !== undefined) {
          if (typeof overrides.bodyReplace !== 'object' || overrides.bodyReplace === null) {
            throw new ValidationError('NetworkReplay step "overrides.bodyReplace" must be { find: string, replace: string }');
          }
          const br = overrides.bodyReplace as Record<string, unknown>;
          if (typeof br.find !== 'string' || typeof br.replace !== 'string') {
            throw new ValidationError('NetworkReplay step "overrides.bodyReplace" must have string "find" and "replace"');
          }
          try {
            new RegExp(br.find);
          } catch {
            throw new ValidationError('NetworkReplay step "overrides.bodyReplace.find" is not a valid regex');
          }
        }
      }
      if (params.auth !== 'browser_context') {
        throw new ValidationError('NetworkReplay step "auth" must be "browser_context"');
      }
      if (typeof params.out !== 'string' || !params.out) {
        throw new ValidationError('NetworkReplay step must have a non-empty string "out" in params');
      }
      if (!params.response || typeof params.response !== 'object') {
        throw new ValidationError('NetworkReplay step must have a "response" object in params');
      }
      const resp = params.response as Record<string, unknown>;
      if (resp.as !== 'json' && resp.as !== 'text') {
        throw new ValidationError('NetworkReplay step "response.as" must be "json" or "text"');
      }
      if (resp.jsonPath !== undefined && typeof resp.jsonPath !== 'string') {
        throw new ValidationError('NetworkReplay step "response.jsonPath" must be a string');
      }
      break;

    case 'network_extract':
      if (typeof params.fromVar !== 'string' || !params.fromVar) {
        throw new ValidationError('NetworkExtract step must have a non-empty string "fromVar" in params');
      }
      if (params.as !== 'json' && params.as !== 'text') {
        throw new ValidationError('NetworkExtract step "as" must be "json" or "text"');
      }
      if (params.jsonPath !== undefined && typeof params.jsonPath !== 'string') {
        throw new ValidationError('NetworkExtract step "jsonPath" must be a string');
      }
      if (params.transform !== undefined) {
        if (typeof params.transform !== 'object' || params.transform === null || Array.isArray(params.transform)) {
          throw new ValidationError('NetworkExtract step "transform" must be an object mapping field names to jsonPath expressions');
        }
        for (const [key, val] of Object.entries(params.transform as Record<string, unknown>)) {
          if (typeof val !== 'string') {
            throw new ValidationError(`NetworkExtract step "transform.${key}" must be a string (jsonPath expression)`);
          }
        }
      }
      if (typeof params.out !== 'string' || !params.out) {
        throw new ValidationError('NetworkExtract step must have a non-empty string "out" in params');
      }
      break;

    case 'select_option':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        throw new ValidationError('SelectOption step must have either "selector" or "target" in params');
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('SelectOption step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (params.value === undefined || params.value === null) {
        throw new ValidationError('SelectOption step must have a "value" in params');
      }
      // Validate value format
      const validateSelectValue = (v: unknown): void => {
        if (typeof v === 'string') return;
        if (typeof v === 'object' && v !== null) {
          if ('label' in v && typeof (v as { label: unknown }).label === 'string') return;
          if ('index' in v && typeof (v as { index: unknown }).index === 'number') return;
        }
        throw new ValidationError('SelectOption step "value" must be string, { label: string }, or { index: number }');
      };
      if (Array.isArray(params.value)) {
        for (const v of params.value) {
          validateSelectValue(v);
        }
      } else {
        validateSelectValue(params.value);
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        throw new ValidationError('SelectOption step "first" must be a boolean');
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('SelectOption step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      break;

    case 'press_key':
      if (typeof params.key !== 'string' || !params.key) {
        throw new ValidationError('PressKey step must have a non-empty string "key" in params');
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('PressKey step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (params.times !== undefined && (typeof params.times !== 'number' || params.times < 1)) {
        throw new ValidationError('PressKey step "times" must be a positive number');
      }
      if (params.delayMs !== undefined && (typeof params.delayMs !== 'number' || params.delayMs < 0)) {
        throw new ValidationError('PressKey step "delayMs" must be a non-negative number');
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('PressKey step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      break;

    case 'upload_file':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        throw new ValidationError('UploadFile step must have either "selector" or "target" in params');
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        throw new ValidationError('UploadFile step "selector" must be a string');
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target);
      }
      if (params.files === undefined || params.files === null) {
        throw new ValidationError('UploadFile step must have "files" in params');
      }
      if (typeof params.files !== 'string' && !Array.isArray(params.files)) {
        throw new ValidationError('UploadFile step "files" must be a string or array of strings');
      }
      if (Array.isArray(params.files)) {
        for (const f of params.files) {
          if (typeof f !== 'string') {
            throw new ValidationError('UploadFile step "files" array must contain only strings');
          }
        }
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        throw new ValidationError('UploadFile step "first" must be a boolean');
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        throw new ValidationError('UploadFile step "hint" must be a string');
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope);
      }
      break;

    case 'frame':
      if (params.frame === undefined || params.frame === null) {
        throw new ValidationError('Frame step must have "frame" in params');
      }
      if (typeof params.frame !== 'string' && typeof params.frame !== 'object') {
        throw new ValidationError('Frame step "frame" must be a string, { name: string }, or { url: string }');
      }
      if (typeof params.frame === 'object') {
        if (!('name' in params.frame) && !('url' in params.frame)) {
          throw new ValidationError('Frame step "frame" object must have "name" or "url"');
        }
      }
      if (params.action !== 'enter' && params.action !== 'exit') {
        throw new ValidationError('Frame step "action" must be "enter" or "exit"');
      }
      break;

    case 'new_tab':
      if (params.url !== undefined && typeof params.url !== 'string') {
        throw new ValidationError('NewTab step "url" must be a string');
      }
      if (params.saveTabIndexAs !== undefined && typeof params.saveTabIndexAs !== 'string') {
        throw new ValidationError('NewTab step "saveTabIndexAs" must be a string');
      }
      break;

    case 'switch_tab':
      if (params.tab === undefined || params.tab === null) {
        throw new ValidationError('SwitchTab step must have "tab" in params');
      }
      if (typeof params.tab !== 'number' && params.tab !== 'last' && params.tab !== 'previous') {
        throw new ValidationError('SwitchTab step "tab" must be a number, "last", or "previous"');
      }
      if (typeof params.tab === 'number' && params.tab < 0) {
        throw new ValidationError('SwitchTab step "tab" index must be non-negative');
      }
      if (params.closeCurrentTab !== undefined && typeof params.closeCurrentTab !== 'boolean') {
        throw new ValidationError('SwitchTab step "closeCurrentTab" must be a boolean');
      }
      break;

    default:
      throw new ValidationError(
        `Unknown step type: ${s.type}. Supported types: navigate, extract_title, extract_text, extract_attribute, sleep, wait_for, click, fill, assert, set_var, network_find, network_replay, network_extract, select_option, press_key, upload_file, frame, new_tab, switch_tab`
      );
  }

  return true;
}

/**
 * Validates a flow (array of steps)
 */
export function validateFlow(steps: unknown[]): void {
  if (!Array.isArray(steps)) {
    throw new ValidationError('Flow must be an array of steps');
  }

  // Empty flow is allowed (e.g. user or AI deleted all steps)

  // Check for unique IDs
  const ids = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    validateStep(step);

    const stepId = (step as DslStep).id;
    if (ids.has(stepId)) {
      throw new ValidationError(`Duplicate step ID: ${stepId}`);
    }
    ids.add(stepId);
  }
}
