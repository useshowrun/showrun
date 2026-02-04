import type {
  NavigateStep,
  ExtractTitleStep,
  ExtractTextStep,
  ExtractAttributeStep,
  SleepStep,
  WaitForStep,
  ClickStep,
  FillStep,
  AssertStep,
  SetVarStep,
  SelectOptionStep,
  PressKeyStep,
  UploadFileStep,
  FrameStep,
  NewTabStep,
  SwitchTabStep,
  Target,
  TargetOrAnyOf,
  PlaywrightRole,
  SkipCondition,
} from './types.js';

/**
 * Builder functions for creating DSL steps.
 * These return plain objects that are JSON-serializable.
 */

/**
 * Helper builders for creating Target objects
 */
export function targetCss(selector: string): Target {
  return { kind: 'css', selector };
}

export function targetText(text: string, exact?: boolean): Target {
  return { kind: 'text', text, exact };
}

export function targetRole(role: PlaywrightRole, name?: string, exact?: boolean): Target {
  return { kind: 'role', role, name, exact };
}

export function targetLabel(text: string, exact?: boolean): Target {
  return { kind: 'label', text, exact };
}

export function targetPlaceholder(text: string, exact?: boolean): Target {
  return { kind: 'placeholder', text, exact };
}

export function targetAltText(text: string, exact?: boolean): Target {
  return { kind: 'altText', text, exact };
}

export function targetTestId(id: string): Target {
  return { kind: 'testId', id };
}

export function targetAnyOf(...targets: Target[]): { anyOf: Target[] } {
  return { anyOf: targets };
}

/**
 * Helper builders for creating SkipCondition objects
 */
export const conditions = {
  /**
   * Skip if URL includes the given string
   */
  urlIncludes(value: string): SkipCondition {
    return { url_includes: value };
  },

  /**
   * Skip if URL matches the given regex pattern
   */
  urlMatches(pattern: string): SkipCondition {
    return { url_matches: pattern };
  },

  /**
   * Skip if element is visible
   */
  elementVisible(target: TargetOrAnyOf): SkipCondition {
    return { element_visible: target };
  },

  /**
   * Skip if element exists in DOM
   */
  elementExists(target: TargetOrAnyOf): SkipCondition {
    return { element_exists: target };
  },

  /**
   * Skip if variable equals the given value
   */
  varEquals(name: string, value: unknown): SkipCondition {
    return { var_equals: { name, value } };
  },

  /**
   * Skip if variable is truthy
   */
  varTruthy(name: string): SkipCondition {
    return { var_truthy: name };
  },

  /**
   * Skip if variable is falsy
   */
  varFalsy(name: string): SkipCondition {
    return { var_falsy: name };
  },

  /**
   * Skip if ALL conditions are true (AND)
   */
  all(...conditions: SkipCondition[]): SkipCondition {
    return { all: conditions };
  },

  /**
   * Skip if ANY condition is true (OR)
   */
  any(...conditions: SkipCondition[]): SkipCondition {
    return { any: conditions };
  },
};

/**
 * Creates a navigate step
 */
export function navigate(
  id: string,
  params: {
    url: string;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
  }
): NavigateStep {
  return {
    id,
    type: 'navigate',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      url: params.url,
      waitUntil: params.waitUntil ?? 'networkidle',
    },
  };
}

/**
 * Creates an extract_title step
 */
export function extractTitle(
  id: string,
  params: {
    out: string;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
  }
): ExtractTitleStep {
  return {
    id,
    type: 'extract_title',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      out: params.out,
    },
  };
}

/**
 * Creates an extract_text step
 */
export function extractText(
  id: string,
  params: {
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    out: string;
    first?: boolean;
    trim?: boolean;
    default?: string;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): ExtractTextStep {
  return {
    id,
    type: 'extract_text',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      selector: params.selector,
      target: params.target,
      out: params.out,
      first: params.first ?? true,
      trim: params.trim ?? true,
      default: params.default,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates a sleep step
 * @deprecated Prefer wait_for for deterministic waiting
 */
export function sleep(
  id: string,
  params: {
    durationMs: number;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
  }
): SleepStep {
  return {
    id,
    type: 'sleep',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      durationMs: params.durationMs,
    },
  };
}

/**
 * Creates a wait_for step
 */
export function waitFor(
  id: string,
  params: {
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    visible?: boolean;
    url?: string | { pattern: string; exact?: boolean };
    loadState?: 'load' | 'domcontentloaded' | 'networkidle';
    timeoutMs?: number;
    label?: string;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): WaitForStep {
  return {
    id,
    type: 'wait_for',
    label: params.label,
    timeoutMs: params.timeoutMs ?? params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      selector: params.selector,
      target: params.target,
      visible: params.visible ?? true,
      url: params.url,
      loadState: params.loadState,
      timeoutMs: params.timeoutMs ?? 30000,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates a click step
 */
export function click(
  id: string,
  params: {
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    first?: boolean;
    waitForVisible?: boolean;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): ClickStep {
  return {
    id,
    type: 'click',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      selector: params.selector,
      target: params.target,
      first: params.first ?? true,
      waitForVisible: params.waitForVisible ?? true,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates a fill step
 */
export function fill(
  id: string,
  params: {
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    value: string;
    first?: boolean;
    clear?: boolean;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): FillStep {
  return {
    id,
    type: 'fill',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      selector: params.selector,
      target: params.target,
      value: params.value,
      first: params.first ?? true,
      clear: params.clear ?? true,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates an extract_attribute step
 */
export function extractAttribute(
  id: string,
  params: {
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    attribute: string;
    out: string;
    first?: boolean;
    default?: string;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): ExtractAttributeStep {
  return {
    id,
    type: 'extract_attribute',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      selector: params.selector,
      target: params.target,
      attribute: params.attribute,
      out: params.out,
      first: params.first ?? true,
      default: params.default,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates an assert step
 */
export function assert(
  id: string,
  params: {
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    visible?: boolean;
    textIncludes?: string;
    urlIncludes?: string;
    message?: string;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): AssertStep {
  return {
    id,
    type: 'assert',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      selector: params.selector,
      target: params.target,
      visible: params.visible,
      textIncludes: params.textIncludes,
      urlIncludes: params.urlIncludes,
      message: params.message,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates a set_var step
 */
export function setVar(
  id: string,
  params: {
    name: string;
    value: string | number | boolean;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
  }
): SetVarStep {
  return {
    id,
    type: 'set_var',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      name: params.name,
      value: params.value,
    },
  };
}

/**
 * Creates a select_option step
 */
export function selectOption(
  id: string,
  params: {
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    value: string | { label: string } | { index: number } | Array<string | { label: string } | { index: number }>;
    first?: boolean;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): SelectOptionStep {
  return {
    id,
    type: 'select_option',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      selector: params.selector,
      target: params.target,
      value: params.value,
      first: params.first ?? true,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates a press_key step
 */
export function pressKey(
  id: string,
  params: {
    key: string;
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    times?: number;
    delayMs?: number;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): PressKeyStep {
  return {
    id,
    type: 'press_key',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      key: params.key,
      selector: params.selector,
      target: params.target,
      times: params.times ?? 1,
      delayMs: params.delayMs ?? 0,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates an upload_file step
 */
export function uploadFile(
  id: string,
  params: {
    selector?: string; // Legacy support
    target?: TargetOrAnyOf; // New human-stable selectors
    files: string | string[];
    first?: boolean;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
    hint?: string;
    scope?: Target;
    near?: { kind: 'text'; text: string; exact?: boolean };
  }
): UploadFileStep {
  return {
    id,
    type: 'upload_file',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      selector: params.selector,
      target: params.target,
      files: params.files,
      first: params.first ?? true,
      hint: params.hint,
      scope: params.scope,
      near: params.near,
    },
  };
}

/**
 * Creates a frame step
 */
export function frame(
  id: string,
  params: {
    frame: string | { name: string } | { url: string | RegExp };
    action: 'enter' | 'exit';
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
  }
): FrameStep {
  return {
    id,
    type: 'frame',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      frame: params.frame,
      action: params.action,
    },
  };
}

/**
 * Creates a new_tab step
 */
export function newTab(
  id: string,
  params: {
    url?: string;
    saveTabIndexAs?: string;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
  }
): NewTabStep {
  return {
    id,
    type: 'new_tab',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      url: params.url,
      saveTabIndexAs: params.saveTabIndexAs,
    },
  };
}

/**
 * Creates a switch_tab step
 */
export function switchTab(
  id: string,
  params: {
    tab: number | 'last' | 'previous';
    closeCurrentTab?: boolean;
    label?: string;
    timeoutMs?: number;
    optional?: boolean;
    onError?: 'stop' | 'continue';
  }
): SwitchTabStep {
  return {
    id,
    type: 'switch_tab',
    label: params.label,
    timeoutMs: params.timeoutMs,
    optional: params.optional,
    onError: params.onError,
    params: {
      tab: params.tab,
      closeCurrentTab: params.closeCurrentTab ?? false,
    },
  };
}
