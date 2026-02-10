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
 * If errors array is provided, push the message; otherwise throw.
 */
function addError(errors: string[] | undefined, message: string): void {
  if (errors) {
    errors.push(message);
  } else {
    throw new ValidationError(message);
  }
}

/**
 * Validates a Target object
 */
function validateTarget(target: unknown, errors?: string[], prefix?: string): boolean {
  const pfx = prefix ? `${prefix}: ` : '';

  if (!target || typeof target !== 'object') {
    addError(errors, `${pfx}Target must be an object`);
    return false;
  }

  const t = target as Record<string, unknown>;

  if (typeof t.kind !== 'string') {
    addError(errors, `${pfx}Target must have a string "kind"`);
    return false;
  }

  switch (t.kind) {
    case 'css':
      if (typeof t.selector !== 'string' || !t.selector) {
        addError(errors, `${pfx}CSS target must have a non-empty string "selector"`);
      }
      break;

    case 'text':
      if (typeof t.text !== 'string' || !t.text) {
        addError(errors, `${pfx}Text target must have a non-empty string "text"`);
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        addError(errors, `${pfx}Text target "exact" must be a boolean`);
      }
      break;

    case 'role': {
      const validRoles = [
        'button', 'checkbox', 'combobox', 'dialog', 'gridcell', 'link', 'listbox',
        'menuitem', 'option', 'radio', 'searchbox', 'slider', 'switch', 'tab',
        'tabpanel', 'textbox', 'treeitem', 'article', 'banner', 'complementary',
        'contentinfo', 'form', 'main', 'navigation', 'region', 'search', 'alert',
        'log', 'marquee', 'status', 'timer'
      ];
      if (!validRoles.includes(t.role as string)) {
        addError(errors, `${pfx}Role target must have a valid role: ${validRoles.join(', ')}`);
      }
      if (t.name !== undefined && typeof t.name !== 'string') {
        addError(errors, `${pfx}Role target "name" must be a string`);
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        addError(errors, `${pfx}Role target "exact" must be a boolean`);
      }
      break;
    }

    case 'label':
      if (typeof t.text !== 'string' || !t.text) {
        addError(errors, `${pfx}Label target must have a non-empty string "text"`);
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        addError(errors, `${pfx}Label target "exact" must be a boolean`);
      }
      break;

    case 'placeholder':
      if (typeof t.text !== 'string' || !t.text) {
        addError(errors, `${pfx}Placeholder target must have a non-empty string "text"`);
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        addError(errors, `${pfx}Placeholder target "exact" must be a boolean`);
      }
      break;

    case 'altText':
      if (typeof t.text !== 'string' || !t.text) {
        addError(errors, `${pfx}AltText target must have a non-empty string "text"`);
      }
      if (t.exact !== undefined && typeof t.exact !== 'boolean') {
        addError(errors, `${pfx}AltText target "exact" must be a boolean`);
      }
      break;

    case 'testId':
      if (typeof t.id !== 'string' || !t.id) {
        addError(errors, `${pfx}TestId target must have a non-empty string "id"`);
      }
      break;

    default:
      addError(errors, `${pfx}Unknown target kind: ${t.kind}`);
  }

  return true;
}

/**
 * Validates TargetOrAnyOf (single target or anyOf array)
 */
function validateTargetOrAnyOf(targetOrAnyOf: unknown, errors?: string[], prefix?: string): void {
  if (!targetOrAnyOf) {
    return; // Optional, so empty is OK
  }

  const pfx = prefix ? `${prefix}: ` : '';

  if (typeof targetOrAnyOf === 'object' && 'anyOf' in targetOrAnyOf) {
    const anyOf = (targetOrAnyOf as { anyOf: unknown }).anyOf;
    if (!Array.isArray(anyOf) || anyOf.length === 0) {
      addError(errors, `${pfx}Target "anyOf" must be a non-empty array`);
      return;
    }
    for (const target of anyOf) {
      validateTarget(target, errors, prefix);
    }
  } else {
    validateTarget(targetOrAnyOf, errors, prefix);
  }
}

/**
 * Validates a SkipCondition
 */
function validateSkipCondition(condition: unknown, errors?: string[], prefix?: string): void {
  const pfx = prefix ? `${prefix}: ` : '';

  if (!condition || typeof condition !== 'object') {
    addError(errors, `${pfx}skip_if condition must be an object`);
    return;
  }

  const c = condition as Record<string, unknown>;
  const keys = Object.keys(c);

  if (keys.length !== 1) {
    addError(errors, `${pfx}skip_if condition must have exactly one key`);
    return;
  }

  const key = keys[0];

  switch (key) {
    case 'url_includes':
      if (typeof c.url_includes !== 'string' || !c.url_includes) {
        addError(errors, `${pfx}skip_if "url_includes" must be a non-empty string`);
      }
      break;

    case 'url_matches':
      if (typeof c.url_matches !== 'string' || !c.url_matches) {
        addError(errors, `${pfx}skip_if "url_matches" must be a non-empty string`);
      } else {
        // Validate it's a valid regex
        try {
          new RegExp(c.url_matches);
        } catch {
          addError(errors, `${pfx}skip_if "url_matches" must be a valid regex`);
        }
      }
      break;

    case 'element_visible':
      validateTargetOrAnyOf(c.element_visible, errors, prefix);
      break;

    case 'element_exists':
      validateTargetOrAnyOf(c.element_exists, errors, prefix);
      break;

    case 'var_equals': {
      if (!c.var_equals || typeof c.var_equals !== 'object') {
        addError(errors, `${pfx}skip_if "var_equals" must be an object`);
      } else {
        const varEquals = c.var_equals as Record<string, unknown>;
        if (typeof varEquals.name !== 'string' || !varEquals.name) {
          addError(errors, `${pfx}skip_if "var_equals.name" must be a non-empty string`);
        }
        if (varEquals.value === undefined) {
          addError(errors, `${pfx}skip_if "var_equals.value" is required`);
        }
      }
      break;
    }

    case 'var_truthy':
      if (typeof c.var_truthy !== 'string' || !c.var_truthy) {
        addError(errors, `${pfx}skip_if "var_truthy" must be a non-empty string`);
      }
      break;

    case 'var_falsy':
      if (typeof c.var_falsy !== 'string' || !c.var_falsy) {
        addError(errors, `${pfx}skip_if "var_falsy" must be a non-empty string`);
      }
      break;

    case 'all':
      if (!Array.isArray(c.all) || c.all.length === 0) {
        addError(errors, `${pfx}skip_if "all" must be a non-empty array`);
      } else {
        for (const subCondition of c.all) {
          validateSkipCondition(subCondition, errors, prefix);
        }
      }
      break;

    case 'any':
      if (!Array.isArray(c.any) || c.any.length === 0) {
        addError(errors, `${pfx}skip_if "any" must be a non-empty array`);
      } else {
        for (const subCondition of c.any) {
          validateSkipCondition(subCondition, errors, prefix);
        }
      }
      break;

    default:
      addError(errors,
        `${pfx}Unknown skip_if condition type: ${key}. Valid types: url_includes, url_matches, element_visible, element_exists, var_equals, var_truthy, var_falsy, all, any`
      );
  }
}

/**
 * Allowed params per step type — used to reject unknown/hallucinated keys.
 */
const ALLOWED_PARAMS: Record<string, string[]> = {
  navigate: ['url', 'waitUntil'],
  extract_title: ['out'],
  extract_text: ['selector', 'target', 'out', 'first', 'trim', 'default', 'hint', 'scope', 'near'],
  sleep: ['durationMs'],
  wait_for: ['selector', 'target', 'url', 'loadState', 'visible', 'timeoutMs', 'hint', 'scope', 'near'],
  click: ['selector', 'target', 'first', 'waitForVisible', 'hint', 'scope', 'near'],
  fill: ['selector', 'target', 'value', 'first', 'clear', 'hint', 'scope', 'near'],
  extract_attribute: ['selector', 'target', 'attribute', 'out', 'first', 'default', 'hint', 'scope', 'near'],
  assert: ['selector', 'target', 'visible', 'textIncludes', 'urlIncludes', 'message', 'hint', 'scope', 'near'],
  set_var: ['name', 'value'],
  network_find: ['where', 'pick', 'saveAs', 'waitForMs', 'pollIntervalMs'],
  network_replay: ['requestId', 'overrides', 'auth', 'out', 'saveAs', 'response'],
  network_extract: ['fromVar', 'as', 'path', 'jsonPath', 'transform', 'out'],
  select_option: ['selector', 'target', 'value', 'first', 'hint', 'scope', 'near'],
  press_key: ['key', 'selector', 'target', 'times', 'delayMs', 'hint', 'scope', 'near'],
  upload_file: ['selector', 'target', 'files', 'first', 'hint', 'scope', 'near'],
  frame: ['frame', 'action'],
  new_tab: ['url', 'saveTabIndexAs'],
  switch_tab: ['tab', 'closeCurrentTab'],
};

/**
 * Validates a single step, pushing errors to the array.
 */
function validateStep(step: unknown, stepIndex: number, errors: string[]): void {
  if (!step || typeof step !== 'object') {
    errors.push(`Step ${stepIndex}: Step must be an object`);
    return;
  }

  const s = step as Record<string, unknown>;
  const stepId = typeof s.id === 'string' && s.id ? s.id : '?';
  const stepType = typeof s.type === 'string' && s.type ? s.type : '?';
  const prefix = `Step ${stepIndex} (id="${stepId}", type="${stepType}")`;

  // Check required fields
  if (typeof s.id !== 'string' || !s.id) {
    errors.push(`${prefix}: must have a non-empty string "id"`);
  }

  if (typeof s.type !== 'string' || !s.type) {
    errors.push(`${prefix}: must have a non-empty string "type"`);
  }

  // Validate optional common fields
  if (s.label !== undefined && typeof s.label !== 'string') {
    errors.push(`${prefix}: "label" must be a string`);
  }
  if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== 'number' || s.timeoutMs < 0)) {
    errors.push(`${prefix}: "timeoutMs" must be a non-negative number`);
  }
  if (s.optional !== undefined && typeof s.optional !== 'boolean') {
    errors.push(`${prefix}: "optional" must be a boolean`);
  }
  if (s.onError !== undefined) {
    if (s.onError !== 'stop' && s.onError !== 'continue') {
      errors.push(`${prefix}: "onError" must be "stop" or "continue"`);
    }
  }
  if (s.once !== undefined) {
    if (s.once !== 'session' && s.once !== 'profile') {
      errors.push(`${prefix}: "once" must be "session" or "profile"`);
    }
  }
  if (s.skip_if !== undefined) {
    validateSkipCondition(s.skip_if, errors, prefix);
  }

  if (!s.params || typeof s.params !== 'object') {
    errors.push(`${prefix}: must have a "params" object`);
    return; // Can't check params further
  }

  const params = s.params as Record<string, unknown>;

  // If type is unknown, we can't validate params
  if (typeof s.type !== 'string' || !s.type) {
    return;
  }

  // Validate step type and params
  switch (s.type) {
    case 'navigate':
      if (typeof params.url !== 'string' || !params.url) {
        errors.push(`${prefix}: Navigate step must have a non-empty string "url" in params`);
      }
      if (params.waitUntil !== undefined) {
        const validWaitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'];
        if (!validWaitUntil.includes(params.waitUntil as string)) {
          errors.push(`${prefix}: Navigate step "waitUntil" must be one of: ${validWaitUntil.join(', ')}`);
        }
      }
      break;

    case 'extract_title':
      if (typeof params.out !== 'string' || !params.out) {
        errors.push(`${prefix}: ExtractTitle step must have a non-empty string "out" in params`);
      }
      break;

    case 'extract_text':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        errors.push(`${prefix}: ExtractText step must have either "selector" or "target" in params`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: ExtractText step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (typeof params.out !== 'string' || !params.out) {
        errors.push(`${prefix}: ExtractText step must have a non-empty string "out" in params`);
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        errors.push(`${prefix}: ExtractText step "first" must be a boolean`);
      }
      if (params.trim !== undefined && typeof params.trim !== 'boolean') {
        errors.push(`${prefix}: ExtractText step "trim" must be a boolean`);
      }
      if (params.default !== undefined && typeof params.default !== 'string') {
        errors.push(`${prefix}: ExtractText step "default" must be a string`);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: ExtractText step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          errors.push(`${prefix}: ExtractText step "near" must be an object with kind: "text"`);
        } else {
          if (typeof near.text !== 'string') {
            errors.push(`${prefix}: ExtractText step "near.text" must be a string`);
          }
          if (near.exact !== undefined && typeof near.exact !== 'boolean') {
            errors.push(`${prefix}: ExtractText step "near.exact" must be a boolean`);
          }
        }
      }
      break;

    case 'sleep':
      if (typeof params.durationMs !== 'number' || params.durationMs < 0) {
        errors.push(`${prefix}: Sleep step must have a non-negative number "durationMs" in params`);
      }
      break;

    case 'wait_for':
      if (!params.selector && !params.target && !params.url && !params.loadState) {
        errors.push(`${prefix}: WaitFor step must have one of: selector, target, url, or loadState`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: WaitFor step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: WaitFor step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          errors.push(`${prefix}: WaitFor step "near" must be an object with kind: "text"`);
        } else {
          if (typeof near.text !== 'string') {
            errors.push(`${prefix}: WaitFor step "near.text" must be a string`);
          }
          if (near.exact !== undefined && typeof near.exact !== 'boolean') {
            errors.push(`${prefix}: WaitFor step "near.exact" must be a boolean`);
          }
        }
      }
      if (params.visible !== undefined && typeof params.visible !== 'boolean') {
        errors.push(`${prefix}: WaitFor step "visible" must be a boolean`);
      }
      if (params.url !== undefined && params.url !== null) {
        if (typeof params.url === 'string') {
          // Valid string URL
        } else if (typeof params.url === 'object') {
          const urlObj = params.url as Record<string, unknown>;
          if (typeof urlObj.pattern !== 'string') {
            errors.push(`${prefix}: WaitFor step "url" object must have a string "pattern"`);
          }
          if (urlObj.exact !== undefined && typeof urlObj.exact !== 'boolean') {
            errors.push(`${prefix}: WaitFor step "url" object "exact" must be a boolean`);
          }
        } else {
          errors.push(`${prefix}: WaitFor step "url" must be a string or object with pattern`);
        }
      }
      if (params.loadState !== undefined) {
        const validLoadStates = ['load', 'domcontentloaded', 'networkidle'];
        if (!validLoadStates.includes(params.loadState as string)) {
          errors.push(`${prefix}: WaitFor step "loadState" must be one of: ${validLoadStates.join(', ')}`);
        }
      }
      if (params.timeoutMs !== undefined && (typeof params.timeoutMs !== 'number' || params.timeoutMs < 0)) {
        errors.push(`${prefix}: WaitFor step "timeoutMs" must be a non-negative number`);
      }
      break;

    case 'click':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        errors.push(`${prefix}: Click step must have either "selector" or "target" in params`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: Click step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        errors.push(`${prefix}: Click step "first" must be a boolean`);
      }
      if (params.waitForVisible !== undefined && typeof params.waitForVisible !== 'boolean') {
        errors.push(`${prefix}: Click step "waitForVisible" must be a boolean`);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: Click step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          errors.push(`${prefix}: Click step "near" must be an object with kind: "text"`);
        } else {
          if (typeof near.text !== 'string') {
            errors.push(`${prefix}: Click step "near.text" must be a string`);
          }
          if (near.exact !== undefined && typeof near.exact !== 'boolean') {
            errors.push(`${prefix}: Click step "near.exact" must be a boolean`);
          }
        }
      }
      break;

    case 'fill':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        errors.push(`${prefix}: Fill step must have either "selector" or "target" in params`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: Fill step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (typeof params.value !== 'string') {
        errors.push(`${prefix}: Fill step must have a string "value" in params`);
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        errors.push(`${prefix}: Fill step "first" must be a boolean`);
      }
      if (params.clear !== undefined && typeof params.clear !== 'boolean') {
        errors.push(`${prefix}: Fill step "clear" must be a boolean`);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: Fill step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          errors.push(`${prefix}: Fill step "near" must be an object with kind: "text"`);
        } else {
          if (typeof near.text !== 'string') {
            errors.push(`${prefix}: Fill step "near.text" must be a string`);
          }
          if (near.exact !== undefined && typeof near.exact !== 'boolean') {
            errors.push(`${prefix}: Fill step "near.exact" must be a boolean`);
          }
        }
      }
      break;

    case 'extract_attribute':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        errors.push(`${prefix}: ExtractAttribute step must have either "selector" or "target" in params`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: ExtractAttribute step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (typeof params.attribute !== 'string' || !params.attribute) {
        errors.push(`${prefix}: ExtractAttribute step must have a non-empty string "attribute" in params`);
      }
      if (typeof params.out !== 'string' || !params.out) {
        errors.push(`${prefix}: ExtractAttribute step must have a non-empty string "out" in params`);
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        errors.push(`${prefix}: ExtractAttribute step "first" must be a boolean`);
      }
      if (params.default !== undefined && typeof params.default !== 'string') {
        errors.push(`${prefix}: ExtractAttribute step "default" must be a string`);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: ExtractAttribute step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          errors.push(`${prefix}: ExtractAttribute step "near" must be an object with kind: "text"`);
        } else {
          if (typeof near.text !== 'string') {
            errors.push(`${prefix}: ExtractAttribute step "near.text" must be a string`);
          }
          if (near.exact !== undefined && typeof near.exact !== 'boolean') {
            errors.push(`${prefix}: ExtractAttribute step "near.exact" must be a boolean`);
          }
        }
      }
      break;

    case 'assert':
      if (!params.selector && !params.target && !params.urlIncludes) {
        errors.push(`${prefix}: Assert step must have at least one of: selector, target, or urlIncludes`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: Assert step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (params.visible !== undefined && typeof params.visible !== 'boolean') {
        errors.push(`${prefix}: Assert step "visible" must be a boolean`);
      }
      if (params.textIncludes !== undefined && typeof params.textIncludes !== 'string') {
        errors.push(`${prefix}: Assert step "textIncludes" must be a string`);
      }
      if (params.urlIncludes !== undefined && typeof params.urlIncludes !== 'string') {
        errors.push(`${prefix}: Assert step "urlIncludes" must be a string`);
      }
      if (params.message !== undefined && typeof params.message !== 'string') {
        errors.push(`${prefix}: Assert step "message" must be a string`);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: Assert step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      if (params.near !== undefined && params.near !== null) {
        const near = params.near as Record<string, unknown>;
        if (typeof near !== 'object' || near.kind !== 'text') {
          errors.push(`${prefix}: Assert step "near" must be an object with kind: "text"`);
        } else {
          if (typeof near.text !== 'string') {
            errors.push(`${prefix}: Assert step "near.text" must be a string`);
          }
          if (near.exact !== undefined && typeof near.exact !== 'boolean') {
            errors.push(`${prefix}: Assert step "near.exact" must be a boolean`);
          }
        }
      }
      break;

    case 'set_var': {
      if (typeof params.name !== 'string' || !params.name) {
        errors.push(`${prefix}: SetVar step must have a non-empty string "name" in params`);
      }
      const valueType = typeof params.value;
      if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
        errors.push(`${prefix}: SetVar step "value" must be a string, number, or boolean`);
      }
      break;
    }

    case 'network_find': {
      if (!params.where || typeof params.where !== 'object') {
        errors.push(`${prefix}: NetworkFind step must have a "where" object in params`);
      } else {
        const where = params.where as Record<string, unknown>;
        // Check for unknown where fields
        const validWhereFields = new Set(['urlIncludes', 'urlRegex', 'method', 'status', 'contentTypeIncludes', 'responseContains']);
        for (const key of Object.keys(where)) {
          if (!validWhereFields.has(key)) {
            errors.push(`${prefix}: NetworkFind step "where.${key}" is not a valid field (unknown fields are silently ignored). Valid fields: ${[...validWhereFields].join(', ')}`);
          }
        }
        if (where.urlIncludes !== undefined && typeof where.urlIncludes !== 'string') {
          errors.push(`${prefix}: NetworkFind step "where.urlIncludes" must be a string`);
        }
        if (where.urlRegex !== undefined) {
          if (typeof where.urlRegex !== 'string') {
            errors.push(`${prefix}: NetworkFind step "where.urlRegex" must be a string`);
          } else {
            try {
              new RegExp(where.urlRegex);
            } catch {
              errors.push(`${prefix}: NetworkFind step "where.urlRegex" is not a valid regex`);
            }
          }
        }
        if (where.method !== undefined) {
          const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
          if (!validMethods.includes(where.method as string)) {
            errors.push(`${prefix}: NetworkFind step "where.method" must be one of: ${validMethods.join(', ')}`);
          }
        }
        if (where.status !== undefined && (typeof where.status !== 'number' || where.status < 0)) {
          errors.push(`${prefix}: NetworkFind step "where.status" must be a non-negative number`);
        }
        if (where.contentTypeIncludes !== undefined && typeof where.contentTypeIncludes !== 'string') {
          errors.push(`${prefix}: NetworkFind step "where.contentTypeIncludes" must be a string`);
        }
        if (where.responseContains !== undefined) {
          if (typeof where.responseContains !== 'string') {
            errors.push(`${prefix}: NetworkFind step "where.responseContains" must be a string`);
          } else if (where.responseContains.length > 2000) {
            errors.push(`${prefix}: NetworkFind step "where.responseContains" must be at most 2000 characters`);
          }
        }
      }
      if (params.pick !== undefined && params.pick !== 'first' && params.pick !== 'last') {
        errors.push(`${prefix}: NetworkFind step "pick" must be "first" or "last"`);
      }
      if (typeof params.saveAs !== 'string' || !params.saveAs) {
        errors.push(`${prefix}: NetworkFind step must have a non-empty string "saveAs" in params`);
      } else if (params.saveAs.length > 500) {
        errors.push(`${prefix}: NetworkFind step "saveAs" must be at most 500 characters`);
      }
      if (params.waitForMs !== undefined && (typeof params.waitForMs !== 'number' || params.waitForMs < 0)) {
        errors.push(`${prefix}: NetworkFind step "waitForMs" must be a non-negative number`);
      }
      if (params.pollIntervalMs !== undefined && (typeof params.pollIntervalMs !== 'number' || params.pollIntervalMs < 100)) {
        errors.push(`${prefix}: NetworkFind step "pollIntervalMs" must be at least 100`);
      }
      break;
    }

    case 'network_replay': {
      if (typeof params.requestId !== 'string' || !params.requestId) {
        errors.push(`${prefix}: NetworkReplay step must have a non-empty string "requestId" in params`);
      } else if (params.requestId.length > 2000) {
        errors.push(`${prefix}: NetworkReplay step "requestId" must be at most 2000 characters`);
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
              errors.push(`${prefix}: NetworkReplay step "overrides.setHeaders" cannot set sensitive header: ${key}`);
            }
          }
        }
        if (overrides.urlReplace !== undefined) {
          if (typeof overrides.urlReplace !== 'object' || overrides.urlReplace === null) {
            errors.push(`${prefix}: NetworkReplay step "overrides.urlReplace" must be { find: string, replace: string }`);
          } else {
            const ur = overrides.urlReplace as Record<string, unknown>;
            if (typeof ur.find !== 'string' || typeof ur.replace !== 'string') {
              errors.push(`${prefix}: NetworkReplay step "overrides.urlReplace" must have string "find" and "replace"`);
            } else {
              try {
                new RegExp(ur.find);
              } catch {
                errors.push(`${prefix}: NetworkReplay step "overrides.urlReplace.find" is not a valid regex`);
              }
            }
          }
        }
        if (overrides.bodyReplace !== undefined) {
          if (typeof overrides.bodyReplace !== 'object' || overrides.bodyReplace === null) {
            errors.push(`${prefix}: NetworkReplay step "overrides.bodyReplace" must be { find: string, replace: string }`);
          } else {
            const br = overrides.bodyReplace as Record<string, unknown>;
            if (typeof br.find !== 'string' || typeof br.replace !== 'string') {
              errors.push(`${prefix}: NetworkReplay step "overrides.bodyReplace" must have string "find" and "replace"`);
            } else {
              try {
                new RegExp(br.find);
              } catch {
                errors.push(`${prefix}: NetworkReplay step "overrides.bodyReplace.find" is not a valid regex`);
              }
            }
          }
        }
      }
      if (params.auth !== 'browser_context') {
        errors.push(`${prefix}: NetworkReplay step "auth" must be "browser_context"`);
      }
      if (typeof params.out !== 'string' || !params.out) {
        errors.push(`${prefix}: NetworkReplay step must have a non-empty string "out" in params`);
      }
      if (!params.response || typeof params.response !== 'object') {
        errors.push(`${prefix}: NetworkReplay step must have a "response" object in params`);
      } else {
        const resp = params.response as Record<string, unknown>;
        if (resp.as !== 'json' && resp.as !== 'text') {
          errors.push(`${prefix}: NetworkReplay step "response.as" must be "json" or "text"`);
        }
        if (resp.jsonPath !== undefined && typeof resp.jsonPath !== 'string') {
          errors.push(`${prefix}: NetworkReplay step "response.jsonPath" must be a string`);
        }
      }
      break;
    }

    case 'network_extract':
      if (typeof params.fromVar !== 'string' || !params.fromVar) {
        errors.push(`${prefix}: NetworkExtract step must have a non-empty string "fromVar" in params`);
      }
      if (params.as !== 'json' && params.as !== 'text') {
        errors.push(`${prefix}: NetworkExtract step "as" must be "json" or "text"`);
      }
      if (params.jsonPath !== undefined && typeof params.jsonPath !== 'string') {
        errors.push(`${prefix}: NetworkExtract step "jsonPath" must be a string`);
      }
      if (params.transform !== undefined) {
        if (typeof params.transform !== 'object' || params.transform === null || Array.isArray(params.transform)) {
          errors.push(`${prefix}: NetworkExtract step "transform" must be an object mapping field names to jsonPath expressions`);
        } else {
          for (const [key, val] of Object.entries(params.transform as Record<string, unknown>)) {
            if (typeof val !== 'string') {
              errors.push(`${prefix}: NetworkExtract step "transform.${key}" must be a string (jsonPath expression)`);
            }
          }
        }
      }
      if (typeof params.out !== 'string' || !params.out) {
        errors.push(`${prefix}: NetworkExtract step must have a non-empty string "out" in params`);
      }
      break;

    case 'select_option':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        errors.push(`${prefix}: SelectOption step must have either "selector" or "target" in params`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: SelectOption step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (params.value === undefined || params.value === null) {
        errors.push(`${prefix}: SelectOption step must have a "value" in params`);
      } else {
        // Validate value format
        const isValidSelectValue = (v: unknown): boolean => {
          if (typeof v === 'string') return true;
          if (typeof v === 'object' && v !== null) {
            if ('label' in v && typeof (v as { label: unknown }).label === 'string') return true;
            if ('index' in v && typeof (v as { index: unknown }).index === 'number') return true;
          }
          return false;
        };
        if (Array.isArray(params.value)) {
          for (const v of params.value) {
            if (!isValidSelectValue(v)) {
              errors.push(`${prefix}: SelectOption step "value" must be string, { label: string }, or { index: number }`);
              break;
            }
          }
        } else {
          if (!isValidSelectValue(params.value)) {
            errors.push(`${prefix}: SelectOption step "value" must be string, { label: string }, or { index: number }`);
          }
        }
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        errors.push(`${prefix}: SelectOption step "first" must be a boolean`);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: SelectOption step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      break;

    case 'press_key':
      if (typeof params.key !== 'string' || !params.key) {
        errors.push(`${prefix}: PressKey step must have a non-empty string "key" in params`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: PressKey step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (params.times !== undefined && (typeof params.times !== 'number' || params.times < 1)) {
        errors.push(`${prefix}: PressKey step "times" must be a positive number`);
      }
      if (params.delayMs !== undefined && (typeof params.delayMs !== 'number' || params.delayMs < 0)) {
        errors.push(`${prefix}: PressKey step "delayMs" must be a non-negative number`);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: PressKey step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      break;

    case 'upload_file':
      // Must have either selector (legacy) or target (new)
      if (!params.selector && !params.target) {
        errors.push(`${prefix}: UploadFile step must have either "selector" or "target" in params`);
      }
      if (params.selector !== undefined && typeof params.selector !== 'string') {
        errors.push(`${prefix}: UploadFile step "selector" must be a string`);
      }
      if (params.target !== undefined) {
        validateTargetOrAnyOf(params.target, errors, prefix);
      }
      if (params.files === undefined || params.files === null) {
        errors.push(`${prefix}: UploadFile step must have "files" in params`);
      } else if (typeof params.files !== 'string' && !Array.isArray(params.files)) {
        errors.push(`${prefix}: UploadFile step "files" must be a string or array of strings`);
      } else if (Array.isArray(params.files)) {
        for (const f of params.files) {
          if (typeof f !== 'string') {
            errors.push(`${prefix}: UploadFile step "files" array must contain only strings`);
            break;
          }
        }
      }
      if (params.first !== undefined && typeof params.first !== 'boolean') {
        errors.push(`${prefix}: UploadFile step "first" must be a boolean`);
      }
      if (params.hint !== undefined && typeof params.hint !== 'string') {
        errors.push(`${prefix}: UploadFile step "hint" must be a string`);
      }
      if (params.scope !== undefined) {
        validateTarget(params.scope, errors, prefix);
      }
      break;

    case 'frame':
      if (params.frame === undefined || params.frame === null) {
        errors.push(`${prefix}: Frame step must have "frame" in params`);
      } else if (typeof params.frame !== 'string' && typeof params.frame !== 'object') {
        errors.push(`${prefix}: Frame step "frame" must be a string, { name: string }, or { url: string }`);
      } else if (typeof params.frame === 'object') {
        if (!('name' in params.frame) && !('url' in params.frame)) {
          errors.push(`${prefix}: Frame step "frame" object must have "name" or "url"`);
        }
      }
      if (params.action !== 'enter' && params.action !== 'exit') {
        errors.push(`${prefix}: Frame step "action" must be "enter" or "exit"`);
      }
      break;

    case 'new_tab':
      if (params.url !== undefined && typeof params.url !== 'string') {
        errors.push(`${prefix}: NewTab step "url" must be a string`);
      }
      if (params.saveTabIndexAs !== undefined && typeof params.saveTabIndexAs !== 'string') {
        errors.push(`${prefix}: NewTab step "saveTabIndexAs" must be a string`);
      }
      break;

    case 'switch_tab':
      if (params.tab === undefined || params.tab === null) {
        errors.push(`${prefix}: SwitchTab step must have "tab" in params`);
      } else {
        if (typeof params.tab !== 'number' && params.tab !== 'last' && params.tab !== 'previous') {
          errors.push(`${prefix}: SwitchTab step "tab" must be a number, "last", or "previous"`);
        }
        if (typeof params.tab === 'number' && params.tab < 0) {
          errors.push(`${prefix}: SwitchTab step "tab" index must be non-negative`);
        }
      }
      if (params.closeCurrentTab !== undefined && typeof params.closeCurrentTab !== 'boolean') {
        errors.push(`${prefix}: SwitchTab step "closeCurrentTab" must be a boolean`);
      }
      break;

    default:
      errors.push(
        `${prefix}: Unknown step type: ${s.type}. Supported types: navigate, extract_title, extract_text, extract_attribute, sleep, wait_for, click, fill, assert, set_var, network_find, network_replay, network_extract, select_option, press_key, upload_file, frame, new_tab, switch_tab`
      );
  }

  // Check for unknown params
  const allowed = ALLOWED_PARAMS[s.type as string];
  if (allowed) {
    const unknown = Object.keys(params).filter(k => !allowed.includes(k));
    if (unknown.length > 0) {
      const evalLike = unknown.filter(k =>
        ['eval', 'expression', 'evaluate', 'exec', 'script', 'code', 'js', 'javascript', 'function'].includes(k.toLowerCase())
      );
      let hint = '';
      if (evalLike.length > 0) {
        hint = '. To extract/transform data from JSON responses, use the network_extract step with a JMESPath "path" expression instead of eval';
      }
      errors.push(
        `${prefix}: Unknown param(s) ${unknown.map(k => `"${k}"`).join(', ')} in "${s.type}" step. Allowed params: ${allowed.join(', ')}${hint}`
      );
    }
  }

  // Check for eval() in string param values
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === 'string' && /\beval\s*\(/.test(val)) {
      errors.push(
        `${prefix}: param "${key}" contains eval() which is not supported. To extract/transform data from JSON responses, use the network_extract step with a JMESPath "path" expression`
      );
    }
  }
}

/**
 * Validates a flow (array of steps).
 *
 * When `collectedErrors` is provided, all errors are pushed to the array
 * (used by validateJsonTaskPack to report every problem at once).
 * When omitted, throws on the first error (backwards-compatible for runtime/interpreter).
 */
export function validateFlow(steps: unknown[], collectedErrors?: string[]): void {
  if (!Array.isArray(steps)) {
    const msg = 'Flow must be an array of steps';
    if (collectedErrors) { collectedErrors.push(msg); return; }
    throw new ValidationError(msg);
  }

  // Empty flow is allowed (e.g. user or AI deleted all steps)

  // Check for unique IDs
  const ids = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const stepErrors: string[] = [];
    validateStep(steps[i], i, stepErrors);

    // Duplicate ID check
    const step = steps[i] as Record<string, unknown>;
    const stepId = typeof step?.id === 'string' ? step.id : undefined;
    if (stepId) {
      if (ids.has(stepId)) {
        stepErrors.push(`Step ${i} (id="${stepId}"): Duplicate step ID`);
      }
      ids.add(stepId);
    }

    if (stepErrors.length > 0) {
      if (collectedErrors) {
        collectedErrors.push(...stepErrors);
      } else {
        // Backwards compat: throw on first error
        throw new ValidationError(stepErrors[0]);
      }
    }
  }
}
