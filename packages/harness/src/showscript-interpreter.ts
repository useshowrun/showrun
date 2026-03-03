/**
 * ShowScript AST Interpreter
 *
 * Walks the ShowScript AST and executes each node directly using Playwright,
 * without converting to JSON-DSL first.
 */

import type { Page, BrowserContext, Frame, Locator } from 'playwright';
import type {
  Program,
  FlowBlock,
  InputsBlock,
  OutputsBlock,
  Statement,
  Expression,
  StepCall,
  Argument,
  NamedArgument,
  PositionalArgument,
  TargetExpression,
  TargetPrimary,
  AnyTarget,
  TargetModifier,
  ExtractionExpression,
  FString,
  FStringInterpolation,
  Filter,
  Literal,
  RangeExpression,
  ObjectLiteral,
  ArrayLiteral,
  DurationLiteral,
  BinaryExpression,
  UnaryExpression,
  PropertyAccess,
  Identifier,
  IfStatement,
  WhileStatement,
  ForStatement,
  AssignStatement,
  StepStatement,
  YieldStatement,
  GroupExpression,
} from '@showrun/showscript';
import {
  resolveTarget,
  resolveTemplate,
} from '@showrun/core';
import type { LocatorSource } from '@showrun/core';
import type { NetworkCaptureApi } from '@showrun/core';

// ─── Execution Context ──────────────────────────────────────

export interface ShowScriptContext {
  page: Page;
  browserContext?: BrowserContext;
  vars: Record<string, unknown>;
  inputs: Record<string, unknown>;
  secrets?: Record<string, string>;
  collectibles: Record<string, unknown>;
  networkCapture?: NetworkCaptureApi;
  currentFrame?: Frame;
  packDir?: string;
}

export interface ShowScriptOptions {
  timeoutMs?: number;
  onStepStart?: (name: string, args: Record<string, unknown>) => void;
  onStepFinish?: (name: string, durationMs: number) => void;
}

// ─── Sentinel for yield ─────────────────────────────────────

const YIELD_SENTINEL = Symbol('ShowScriptYield');

interface YieldValue {
  [YIELD_SENTINEL]: true;
  value: unknown;
}

function isYieldValue(v: unknown): v is YieldValue {
  return typeof v === 'object' && v !== null && YIELD_SENTINEL in v;
}

// ─── Filters ────────────────────────────────────────────────

function applyFilter(value: unknown, filter: Filter): unknown {
  const str = value == null ? '' : String(value);
  switch (filter.name) {
    case 'urlencode':
      return encodeURIComponent(str);
    case 'pctEncode':
      return encodeURIComponent(str).replace(/[!'()*~]/g, (c) =>
        '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      );
    case 'lower':
      return str.toLowerCase();
    case 'upper':
      return str.toUpperCase();
    case 'trim':
      return str.trim();
    case 'default': {
      if (value == null || value === '') {
        return filter.argument ? evaluateLiteral(filter.argument) : '';
      }
      return value;
    }
    case 'join': {
      const sep = filter.argument ? String(evaluateLiteral(filter.argument)) : ',';
      return Array.isArray(value) ? value.join(sep) : str;
    }
    case 'totp': {
      // Delegate to core's template engine for TOTP
      const template = `{{ val | totp }}`;
      return resolveTemplate(template, {
        inputs: { val: str },
        vars: {},
      });
    }
    default:
      throw new Error(`Unknown filter: ${filter.name}`);
  }
}

function evaluateLiteral(lit: Literal): unknown {
  switch (lit.type) {
    case 'StringLiteral':
      return lit.value;
    case 'NumberLiteral':
      return lit.value;
    case 'BooleanLiteral':
      return lit.value;
    case 'NullLiteral':
      return null;
    case 'DurationLiteral':
      return durationToMs(lit);
    case 'ArrayLiteral':
      // Literals in filter args are simple - no async needed
      return lit.elements.map((e) => {
        if (
          e.type === 'StringLiteral' ||
          e.type === 'NumberLiteral' ||
          e.type === 'BooleanLiteral' ||
          e.type === 'NullLiteral' ||
          e.type === 'DurationLiteral'
        ) {
          return evaluateLiteral(e);
        }
        throw new Error('Complex expressions in literal array arguments are not supported');
      });
    case 'ObjectLiteral':
      return Object.fromEntries(
        lit.fields.map((f) => [f.key, evaluateLiteral(f.value as Literal)]),
      );
    default:
      throw new Error(`Unsupported literal type: ${(lit as { type: string }).type}`);
  }
}

// ─── Duration ───────────────────────────────────────────────

function durationToMs(d: DurationLiteral): number {
  switch (d.unit) {
    case 'ms':
      return d.value;
    case 's':
      return d.value * 1000;
    case 'm':
      return d.value * 60_000;
  }
}

// ─── Helpers ────────────────────────────────────────────────

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNamedArg(args: Argument[], name: string): Expression | undefined {
  const found = args.find(
    (a): a is NamedArgument => a.type === 'NamedArgument' && a.name === name,
  );
  return found?.value;
}

function getPositionalArgs(args: Argument[]): PositionalArgument[] {
  return args.filter((a): a is PositionalArgument => a.type === 'PositionalArgument');
}

// ─── Main Interpreter ───────────────────────────────────────

export async function executeShowScript(
  ast: Program,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<Record<string, unknown>> {
  // Process blocks
  let outputNames: string[] = [];

  for (const block of ast.blocks) {
    switch (block.type) {
      case 'InputsBlock':
        processInputsBlock(block, ctx);
        break;
      case 'OutputsBlock':
        outputNames = block.declarations.map((d) => d.name);
        break;
      case 'FlowBlock':
        await executeFlowBlock(block, ctx, options);
        break;
      case 'MetaBlock':
        // Meta is informational only
        break;
    }
  }

  // Collect outputs
  const outputs: Record<string, unknown> = {};
  for (const name of outputNames) {
    if (name in ctx.collectibles) {
      outputs[name] = ctx.collectibles[name];
    } else if (name in ctx.vars) {
      outputs[name] = ctx.vars[name];
    }
  }
  return outputs;
}

function processInputsBlock(block: InputsBlock, ctx: ShowScriptContext): void {
  for (const decl of block.declarations) {
    if (!(decl.name in ctx.inputs) && decl.defaultValue) {
      ctx.inputs[decl.name] = evaluateLiteral(decl.defaultValue as Literal);
    }
  }
}

async function executeFlowBlock(
  block: FlowBlock,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  await executeStatements(block.statements, ctx, options);
}

// ─── Statement Execution ────────────────────────────────────

async function executeStatements(
  stmts: Statement[],
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  for (const stmt of stmts) {
    await executeStatement(stmt, ctx, options);
  }
}

async function executeStatement(
  stmt: Statement,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  switch (stmt.type) {
    case 'StepStatement':
      await executeStepCall(stmt.call, ctx, options);
      break;
    case 'AssignStatement':
      await executeAssign(stmt, ctx, options);
      break;
    case 'IfStatement':
      await executeIf(stmt, ctx, options);
      break;
    case 'WhileStatement':
      await executeWhile(stmt, ctx, options);
      break;
    case 'ForStatement':
      await executeFor(stmt, ctx, options);
      break;
    case 'YieldStatement':
      // Yield outside a loop context is an error
      throw new Error('yield statement outside of a loop');
  }
}

async function executeAssign(
  stmt: AssignStatement,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const value = await evaluateExpression(stmt.value, ctx, options);
  ctx.vars[stmt.name] = value;
}

async function executeIf(
  stmt: IfStatement,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  if (await isTruthy(await evaluateExpression(stmt.condition, ctx, options))) {
    await executeStatements(stmt.body, ctx, options);
    return;
  }

  for (const elif of stmt.elifs) {
    if (await isTruthy(await evaluateExpression(elif.condition, ctx, options))) {
      await executeStatements(elif.body, ctx, options);
      return;
    }
  }

  if (stmt.elseBody) {
    await executeStatements(stmt.elseBody, ctx, options);
  }
}

async function executeWhile(
  stmt: WhileStatement,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown[]> {
  const results: unknown[] = [];
  const MAX_ITERATIONS = 10_000;
  let iteration = 0;

  while (await isTruthy(await evaluateExpression(stmt.condition, ctx, options))) {
    if (++iteration > MAX_ITERATIONS) {
      throw new Error(`While loop exceeded ${MAX_ITERATIONS} iterations`);
    }

    const yielded = await executeBodyWithYield(stmt.body, ctx, options);
    for (const v of yielded) {
      if (Array.isArray(v)) {
        results.push(...v);
      } else {
        results.push(v);
      }
    }
  }

  if (stmt.assignTo) {
    ctx.vars[stmt.assignTo] = results;
  }

  return results;
}

async function executeFor(
  stmt: ForStatement,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown[]> {
  const results: unknown[] = [];
  const iterable = await resolveIterable(stmt.iterable, ctx, options);

  for (const item of iterable) {
    ctx.vars[stmt.variable] = item;
    const yielded = await executeBodyWithYield(stmt.body, ctx, options);
    for (const v of yielded) {
      if (Array.isArray(v)) {
        results.push(...v);
      } else {
        results.push(v);
      }
    }
  }

  if (stmt.assignTo) {
    ctx.vars[stmt.assignTo] = results;
  }

  return results;
}

async function resolveIterable(
  expr: RangeExpression | Identifier | PropertyAccess,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown[]> {
  if (expr.type === 'RangeExpression') {
    const start = Number(await evaluateExpression(expr.start, ctx, options));
    const end = Number(await evaluateExpression(expr.end, ctx, options));
    const result: number[] = [];
    for (let i = start; i <= end; i++) {
      result.push(i);
    }
    return result;
  }
  const value = await evaluateExpression(expr, ctx, options);
  if (Array.isArray(value)) return value;
  throw new Error(`Cannot iterate over ${typeof value}`);
}

/**
 * Executes a body of statements, collecting any yield values.
 */
async function executeBodyWithYield(
  stmts: Statement[],
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown[]> {
  const yielded: unknown[] = [];

  for (const stmt of stmts) {
    if (stmt.type === 'YieldStatement') {
      const value = await evaluateExpression(stmt.value, ctx, options);
      yielded.push(value);
    } else {
      await executeStatement(stmt, ctx, options);
    }
  }

  return yielded;
}

// ─── Expression Evaluation ──────────────────────────────────

async function evaluateExpression(
  expr: Expression,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  switch (expr.type) {
    case 'StringLiteral':
      return expr.value;
    case 'RawString':
      return expr.value;
    case 'NumberLiteral':
      return expr.value;
    case 'BooleanLiteral':
      return expr.value;
    case 'NullLiteral':
      return null;
    case 'DurationLiteral':
      return durationToMs(expr);
    case 'ArrayLiteral':
      return evaluateArrayLiteral(expr, ctx, options);
    case 'ObjectLiteral':
      return evaluateObjectLiteral(expr, ctx, options);
    case 'Identifier':
      return resolveIdentifier(expr, ctx);
    case 'PropertyAccess':
      return resolvePropertyAccess(expr, ctx, options);
    case 'FString':
      return evaluateFString(expr, ctx);
    case 'TargetExpression':
      return resolveTargetExpression(expr, ctx, options);
    case 'StepCall':
      return executeStepCall(expr, ctx, options);
    case 'ExtractionExpression':
      return evaluateExtraction(expr, ctx, options);
    case 'BinaryExpression':
      return evaluateBinary(expr, ctx, options);
    case 'UnaryExpression':
      return evaluateUnary(expr, ctx, options);
    case 'GroupExpression':
      return evaluateExpression(expr.expression, ctx, options);
    case 'WhileStatement':
      return executeWhile(expr, ctx, options);
    case 'ForStatement':
      return executeFor(expr, ctx, options);
    default:
      throw new Error(`Unknown expression type: ${(expr as { type: string }).type}`);
  }
}

async function evaluateArrayLiteral(
  expr: ArrayLiteral,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown[]> {
  const elements: unknown[] = [];
  for (const el of expr.elements) {
    elements.push(await evaluateExpression(el, ctx, options));
  }
  return elements;
}

async function evaluateObjectLiteral(
  expr: ObjectLiteral,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<Record<string, unknown>> {
  const obj: Record<string, unknown> = {};
  for (const field of expr.fields) {
    obj[field.key] = await evaluateExpression(field.value, ctx, options);
  }
  return obj;
}

function resolveIdentifier(expr: Identifier, ctx: ShowScriptContext): unknown {
  const name = expr.name;

  // Built-in variables
  if (name === 'url') return ctx.page.url();

  // Check vars first, then inputs, then secrets
  if (name in ctx.vars) return ctx.vars[name];
  if (name in ctx.inputs) return ctx.inputs[name];
  if (ctx.secrets && name in ctx.secrets) return ctx.secrets[name];

  // Load state identifiers (used in wait())
  if (name === 'networkidle' || name === 'domcontentloaded' || name === 'load') {
    return name;
  }

  return undefined;
}

async function resolvePropertyAccess(
  expr: PropertyAccess,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  const obj = await evaluateExpression(expr.object, ctx, options);

  // Handle special properties
  if (expr.property === 'visible') {
    // Target.visible - check if locator is visible
    if (isLocator(obj)) {
      try {
        return await (obj as Locator).first().isVisible();
      } catch {
        return false;
      }
    }
    return false;
  }

  if (expr.property === 'exists') {
    if (isLocator(obj)) {
      try {
        return (await (obj as Locator).count()) > 0;
      } catch {
        return false;
      }
    }
    return false;
  }

  if (expr.property === 'empty') {
    if (Array.isArray(obj)) return obj.length === 0;
    if (typeof obj === 'object' && obj !== null) return Object.keys(obj).length === 0;
    if (typeof obj === 'string') return obj.length === 0;
    return true;
  }

  // Regular property access on objects
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    return (obj as Record<string, unknown>)[expr.property];
  }

  if (Array.isArray(obj)) {
    // Could be array.length etc.
    if (expr.property === 'length') return obj.length;
    return undefined;
  }

  return undefined;
}

function isLocator(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'count' in obj &&
    typeof (obj as Record<string, unknown>).count === 'function'
  );
}

async function evaluateFString(
  expr: FString,
  ctx: ShowScriptContext,
): Promise<string> {
  let result = '';
  for (const part of expr.parts) {
    if (part.type === 'FStringText') {
      result += part.value;
    } else {
      // FStringInterpolation
      const interp = part as FStringInterpolation;
      let value: unknown = resolveIdentifier(
        { type: 'Identifier', name: interp.identifier },
        ctx,
      );

      // Apply filters
      for (const filter of interp.filters) {
        value = applyFilter(value, filter);
      }

      result += value == null ? '' : String(value);
    }
  }
  return result;
}

async function evaluateBinary(
  expr: BinaryExpression,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  // Short-circuit for logical operators
  if (expr.operator === '&&') {
    const left = await evaluateExpression(expr.left, ctx, options);
    if (!await isTruthy(left)) return left;
    return evaluateExpression(expr.right, ctx, options);
  }
  if (expr.operator === '||') {
    const left = await evaluateExpression(expr.left, ctx, options);
    if (await isTruthy(left)) return left;
    return evaluateExpression(expr.right, ctx, options);
  }

  const left = await evaluateExpression(expr.left, ctx, options);
  const right = await evaluateExpression(expr.right, ctx, options);

  switch (expr.operator) {
    case '+':
      if (typeof left === 'string' || typeof right === 'string') {
        return String(left ?? '') + String(right ?? '');
      }
      return Number(left) + Number(right);
    case '-':
      return Number(left) - Number(right);
    case '*':
      return Number(left) * Number(right);
    case '/':
      return Number(left) / Number(right);
    case '%':
      return Number(left) % Number(right);
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    default:
      throw new Error(`Unknown operator: ${expr.operator}`);
  }
}

async function evaluateUnary(
  expr: UnaryExpression,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  const operand = await evaluateExpression(expr.operand, ctx, options);
  switch (expr.operator) {
    case '-':
      return -Number(operand);
    case '!':
      return !(await isTruthy(operand));
  }
}

async function isTruthy(value: unknown): Promise<boolean> {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// ─── Target Resolution ──────────────────────────────────────

async function resolveTargetExpression(
  expr: TargetExpression,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<Locator> {
  let source: LocatorSource = ctx.currentFrame ?? ctx.page;

  // Apply modifiers (in/near)
  for (const mod of expr.modifiers) {
    if (mod.kind === 'in') {
      const scopeLocator = await resolveTargetExpression(mod.target, ctx, options);
      source = scopeLocator.first();
    }
    // 'near' is a hint for Teach Mode, not enforced at runtime
  }

  if (expr.target.type === 'AnyTarget') {
    return resolveAnyTarget(expr.target, source, ctx, options);
  }

  return resolvePrimaryTarget(expr.target, source, ctx, options);
}

async function resolvePrimaryTarget(
  target: TargetPrimary,
  source: LocatorSource,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<Locator> {
  const positionalArgs = getPositionalArgs(target.args);

  switch (target.targetType) {
    case 'css': {
      const selector = String(await evaluateExpression(positionalArgs[0].value, ctx, options));
      return resolveTarget(source, { kind: 'css', selector });
    }
    case 'text': {
      const text = String(await evaluateExpression(positionalArgs[0].value, ctx, options));
      const exactExpr = getNamedArg(target.args, 'exact');
      const exact = exactExpr
        ? Boolean(await evaluateExpression(exactExpr, ctx, options))
        : false;
      return resolveTarget(source, { kind: 'text', text, exact });
    }
    case 'role': {
      const role = String(await evaluateExpression(positionalArgs[0].value, ctx, options));
      const name = positionalArgs[1]
        ? String(await evaluateExpression(positionalArgs[1].value, ctx, options))
        : undefined;
      const exactExpr = getNamedArg(target.args, 'exact');
      const exact = exactExpr
        ? Boolean(await evaluateExpression(exactExpr, ctx, options))
        : false;
      return resolveTarget(source, { kind: 'role', role: role as any, name, exact });
    }
    case 'label': {
      const text = String(await evaluateExpression(positionalArgs[0].value, ctx, options));
      const exactExpr = getNamedArg(target.args, 'exact');
      const exact = exactExpr
        ? Boolean(await evaluateExpression(exactExpr, ctx, options))
        : false;
      return resolveTarget(source, { kind: 'label', text, exact });
    }
    case 'attr': {
      // @attr("name") -> existence check via CSS
      // @attr("name", "value") -> value check via CSS
      const attrName = String(await evaluateExpression(positionalArgs[0].value, ctx, options));
      if (positionalArgs[1]) {
        const attrValue = String(await evaluateExpression(positionalArgs[1].value, ctx, options));
        return resolveTarget(source, { kind: 'css', selector: `[${attrName}="${attrValue}"]` });
      }
      return resolveTarget(source, { kind: 'css', selector: `[${attrName}]` });
    }
    default:
      throw new Error(`Unknown target type: ${target.targetType}`);
  }
}

async function resolveAnyTarget(
  target: AnyTarget,
  source: LocatorSource,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<Locator> {
  for (const t of target.targets) {
    try {
      const locator = await resolveTargetExpression(t, ctx, options);
      const count = await locator.count();
      if (count > 0) return locator;
    } catch {
      // Try next
    }
  }
  throw new Error(`No target matched in @any() (tried ${target.targets.length} targets)`);
}

// ─── Extraction ─────────────────────────────────────────────

async function evaluateExtraction(
  expr: ExtractionExpression,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  const locator = await resolveTargetExpression(expr.target, ctx, options);

  if (expr.kind === 'text') {
    const text = await locator.first().textContent();
    return text?.trim() ?? '';
  }

  if (expr.kind === 'attr') {
    const attrName = expr.attribute
      ? String(await evaluateExpression(expr.attribute, ctx, options))
      : '';
    return (await locator.first().getAttribute(attrName)) ?? '';
  }

  throw new Error(`Unknown extraction kind: ${expr.kind}`);
}

// ─── Step Execution ─────────────────────────────────────────

async function executeStepCall(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  const start = Date.now();
  options?.onStepStart?.(call.name, {});

  try {
    const result = await executeStepCallInner(call, ctx, options);
    options?.onStepFinish?.(call.name, Date.now() - start);
    return result;
  } catch (err) {
    // Check for optional/on_error flags
    const optionalExpr = getNamedArg(call.args, 'optional');
    if (optionalExpr) {
      const isOptional = Boolean(await evaluateExpression(optionalExpr, ctx, options));
      if (isOptional) {
        options?.onStepFinish?.(call.name, Date.now() - start);
        return undefined;
      }
    }

    const onErrorExpr = getNamedArg(call.args, 'on_error');
    if (onErrorExpr) {
      const onError = String(await evaluateExpression(onErrorExpr, ctx, options));
      if (onError === 'continue') {
        options?.onStepFinish?.(call.name, Date.now() - start);
        return undefined;
      }
    }

    throw err;
  }
}

async function executeStepCallInner(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  const positionalArgs = getPositionalArgs(call.args);

  switch (call.name) {
    // ── Navigation ──
    case 'goto':
      return executeGoto(call, ctx, options);

    // ── Waiting ──
    case 'wait':
      return executeWait(call, ctx, options);

    // ── Interaction ──
    case 'click':
      return executeClick(call, ctx, options);
    case 'fill':
      return executeFill(call, ctx, options);
    case 'press':
      return executePress(call, ctx, options);
    case 'select':
      return executeSelect(call, ctx, options);
    case 'upload':
      return executeUpload(call, ctx, options);

    // ── Extraction ──
    case 'title':
      return ctx.page.title();
    case 'scrape':
      return executeScrape(call, ctx, options);

    // ── Assertion ──
    case 'assert':
      return executeAssert(call, ctx, options);

    // ── Sleep ──
    case 'sleep': {
      const ms = Number(await evaluateExpression(positionalArgs[0].value, ctx, options));
      await sleepMs(ms);
      return undefined;
    }

    // ── Network ──
    case 'network.find':
      return executeNetworkFind(call, ctx, options);
    case 'network.replay':
      return executeNetworkReplay(call, ctx, options);
    case 'extract':
      return executeExtract(call, ctx, options);

    // ── Tabs ──
    case 'new_tab':
      return executeNewTab(call, ctx, options);
    case 'switch_tab':
      return executeSwitchTab(call, ctx, options);

    // ── Frames ──
    case 'frame.enter':
      return executeFrameEnter(call, ctx, options);
    case 'frame.exit':
      ctx.currentFrame = undefined;
      return undefined;

    // ── Built-in functions ──
    case 'contains':
      return executeContains(call, ctx, options);
    case 'equals':
      return executeEquals(call, ctx, options);
    case 'matches':
      return executeMatches(call, ctx, options);
    case 'len':
      return executeLen(call, ctx, options);

    default:
      throw new Error(`Unknown step/function: ${call.name}`);
  }
}

// ─── Step Implementations ───────────────────────────────────

async function executeGoto(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const url = String(await evaluateExpression(positionalArgs[0].value, ctx, options));
  const waitExpr = getNamedArg(call.args, 'wait');
  const waitUntil = waitExpr
    ? String(await evaluateExpression(waitExpr, ctx, options))
    : 'networkidle';

  try {
    await ctx.page.goto(url, {
      waitUntil: waitUntil as 'networkidle' | 'load' | 'domcontentloaded' | 'commit',
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.message?.includes('Timeout')) {
      return;
    }
    throw err;
  }
}

async function executeWait(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const timeoutExpr = getNamedArg(call.args, 'timeout');
  const timeout = timeoutExpr
    ? Number(await evaluateExpression(timeoutExpr, ctx, options))
    : 30_000;

  if (positionalArgs.length === 0) {
    throw new Error('wait() requires at least one argument');
  }

  const firstArg = positionalArgs[0].value;

  // Wait for load state (bare identifier)
  if (firstArg.type === 'Identifier') {
    const name = firstArg.name;
    if (name === 'networkidle' || name === 'domcontentloaded' || name === 'load') {
      await ctx.page.waitForLoadState(name, { timeout });
      return;
    }
  }

  // Wait for target (element)
  if (firstArg.type === 'TargetExpression') {
    const locator = await resolveTargetExpression(firstArg, ctx, options);
    const visibleExpr = getNamedArg(call.args, 'visible');
    const visible = visibleExpr
      ? Boolean(await evaluateExpression(visibleExpr, ctx, options))
      : true;

    await locator.first().waitFor({
      state: visible ? 'visible' : 'attached',
      timeout,
    });
    return;
  }

  // Wait for condition (StepCall like contains(url, ...))
  if (firstArg.type === 'StepCall') {
    const condName = firstArg.name;
    if (condName === 'contains' || condName === 'matches') {
      // These are URL/string conditions - poll until true
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const result = await evaluateExpression(firstArg, ctx, options);
        if (await isTruthy(result)) return;
        await sleepMs(200);
      }
      throw new Error(`wait() condition not met within ${timeout}ms`);
    }
  }

  // Fallback: evaluate and check truthiness
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await evaluateExpression(firstArg, ctx, options);
    if (await isTruthy(result)) return;
    await sleepMs(200);
  }
  throw new Error(`wait() condition not met within ${timeout}ms`);
}

async function executeClick(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const locator = await resolveTargetExpression(
    positionalArgs[0].value as TargetExpression,
    ctx,
    options,
  );

  const waitExpr = getNamedArg(call.args, 'wait');
  const shouldWait = waitExpr
    ? Boolean(await evaluateExpression(waitExpr, ctx, options))
    : true;

  if (shouldWait) {
    await locator.first().waitFor({ state: 'visible' });
  }

  await locator.first().click();
}

async function executeFill(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const locator = await resolveTargetExpression(
    positionalArgs[0].value as TargetExpression,
    ctx,
    options,
  );
  const value = String(await evaluateExpression(positionalArgs[1].value, ctx, options));

  const clearExpr = getNamedArg(call.args, 'clear');
  const clear = clearExpr
    ? Boolean(await evaluateExpression(clearExpr, ctx, options))
    : true;

  await locator.first().waitFor({ state: 'visible' });

  if (clear) {
    await locator.first().fill(value);
  } else {
    await locator.first().type(value);
  }
}

async function executePress(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const key = String(await evaluateExpression(positionalArgs[0].value, ctx, options));

  const timesExpr = getNamedArg(call.args, 'times');
  const times = timesExpr ? Number(await evaluateExpression(timesExpr, ctx, options)) : 1;

  const delayExpr = getNamedArg(call.args, 'delay');
  const delayMs = delayExpr ? Number(await evaluateExpression(delayExpr, ctx, options)) : 0;

  // If "on" target specified, focus it first
  const onExpr = getNamedArg(call.args, 'on');
  if (onExpr && onExpr.type === 'TargetExpression') {
    const locator = await resolveTargetExpression(onExpr, ctx, options);
    await locator.first().focus();
  }

  for (let i = 0; i < times; i++) {
    await ctx.page.keyboard.press(key);
    if (delayMs > 0 && i < times - 1) {
      await sleepMs(delayMs);
    }
  }
}

async function executeSelect(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const locator = await resolveTargetExpression(
    positionalArgs[0].value as TargetExpression,
    ctx,
    options,
  );

  const valueExpr = getNamedArg(call.args, 'value');
  const labelExpr = getNamedArg(call.args, 'label');
  const indexExpr = getNamedArg(call.args, 'index');
  const valuesExpr = getNamedArg(call.args, 'values');

  if (valueExpr) {
    const value = String(await evaluateExpression(valueExpr, ctx, options));
    await locator.first().selectOption({ value });
  } else if (labelExpr) {
    const label = String(await evaluateExpression(labelExpr, ctx, options));
    await locator.first().selectOption({ label });
  } else if (indexExpr) {
    const index = Number(await evaluateExpression(indexExpr, ctx, options));
    await locator.first().selectOption({ index });
  } else if (valuesExpr) {
    const values = (await evaluateExpression(valuesExpr, ctx, options)) as string[];
    await locator.first().selectOption(values.map((v) => ({ value: v })));
  }
}

async function executeUpload(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const locator = await resolveTargetExpression(
    positionalArgs[0].value as TargetExpression,
    ctx,
    options,
  );
  const files = await evaluateExpression(positionalArgs[1].value, ctx, options);

  const pathMod = await import('path');
  const fileList = Array.isArray(files) ? files.map(String) : [String(files)];
  const resolved = fileList.map((f) => {
    if (pathMod.isAbsolute(f)) return f;
    return ctx.packDir ? pathMod.join(ctx.packDir, f) : f;
  });

  await locator.first().setInputFiles(resolved);
}

async function executeScrape(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  const positionalArgs = getPositionalArgs(call.args);
  const locator = await resolveTargetExpression(
    positionalArgs[0].value as TargetExpression,
    ctx,
    options,
  );

  // Second arg is the field definition object
  const fieldDef = positionalArgs[1].value as ObjectLiteral;

  const firstExpr = getNamedArg(call.args, 'first');
  const first = firstExpr
    ? Boolean(await evaluateExpression(firstExpr, ctx, options))
    : false;

  const skipEmptyExpr = getNamedArg(call.args, 'skip_empty');
  const skipEmpty = skipEmptyExpr
    ? Boolean(await evaluateExpression(skipEmptyExpr, ctx, options))
    : true;

  const count = await locator.count();
  const limit = first ? Math.min(1, count) : count;
  const results: Record<string, unknown>[] = [];

  for (let i = 0; i < limit; i++) {
    const element = locator.nth(i);
    const item: Record<string, unknown> = {};

    for (const field of fieldDef.fields) {
      item[field.key] = await evaluateScrapeField(field.value, element, ctx, options);
    }

    if (skipEmpty) {
      const allEmpty = Object.values(item).every(
        (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === ''),
      );
      if (allEmpty) continue;
    }

    results.push(item);
  }

  return first ? results[0] ?? null : results;
}

/**
 * Evaluates a scrape field value in the context of a parent element.
 * Handles text(), attr(), and literal values.
 */
async function evaluateScrapeField(
  expr: Expression,
  parentLocator: Locator,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  // ExtractionExpression: text(@css(...)) or attr(@css(...), "href")
  if (expr.type === 'ExtractionExpression') {
    const targetExpr = expr.target;
    // Resolve target relative to parent element
    const childLocator = await resolvePrimaryTarget(
      targetExpr.target as TargetPrimary,
      parentLocator,
      ctx,
      options,
    );
    const childCount = await childLocator.count();
    if (childCount === 0) return null;

    if (expr.kind === 'text') {
      const text = await childLocator.first().textContent();
      return text?.trim() ?? null;
    }
    if (expr.kind === 'attr') {
      const attrName = expr.attribute
        ? String(await evaluateExpression(expr.attribute, ctx, options))
        : '';
      return (await childLocator.first().getAttribute(attrName)) ?? null;
    }
  }

  // Literal or variable value (e.g., source: "shop1" or batch: current_batch)
  return evaluateExpression(expr, ctx, options);
}

async function executeAssert(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const messageExpr = getNamedArg(call.args, 'message');
  const message = messageExpr
    ? String(await evaluateExpression(messageExpr, ctx, options))
    : 'Assertion failed';

  const firstArg = positionalArgs[0].value;

  // assert(@target, ...) - element assertion
  if (firstArg.type === 'TargetExpression') {
    const locator = await resolveTargetExpression(firstArg, ctx, options);
    const count = await locator.count();

    const visibleExpr = getNamedArg(call.args, 'visible');
    if (visibleExpr !== undefined) {
      const expectedVisible = Boolean(await evaluateExpression(visibleExpr, ctx, options));
      const isVisible = count > 0 ? await locator.first().isVisible() : false;
      if (expectedVisible !== isVisible) {
        throw new Error(`Assertion failed: ${message}`);
      }
      return;
    }

    const containsExpr = getNamedArg(call.args, 'contains');
    if (containsExpr) {
      const expected = String(await evaluateExpression(containsExpr, ctx, options));
      const text = count > 0 ? await locator.first().textContent() : '';
      if (!text || !text.includes(expected)) {
        throw new Error(`Assertion failed: ${message}`);
      }
      return;
    }

    // Default: assert element exists
    if (count === 0) {
      throw new Error(`Assertion failed: ${message}`);
    }
    return;
  }

  // assert(condition) - boolean assertion
  const result = await evaluateExpression(firstArg, ctx, options);
  if (!(await isTruthy(result))) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ─── Network Steps ──────────────────────────────────────────

async function executeNetworkFind(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<string> {
  if (!ctx.networkCapture) {
    throw new Error('network.find requires network capture to be enabled');
  }

  const conditionsExpr = getNamedArg(call.args, 'conditions');
  const waitExpr = getNamedArg(call.args, 'wait');
  const waitMs = waitExpr ? Number(await evaluateExpression(waitExpr, ctx, options)) : 0;

  // Build where clause from conditions array
  const where: Record<string, unknown> = {};
  if (conditionsExpr && conditionsExpr.type === 'ArrayLiteral') {
    for (const cond of conditionsExpr.elements) {
      if (cond.type === 'StepCall') {
        const condArgs = getPositionalArgs(cond.args);
        const firstArgValue = condArgs[0].value;
        const firstArgName =
          firstArgValue.type === 'Identifier' ? firstArgValue.name : '';

        if (cond.name === 'contains') {
          const value = String(await evaluateExpression(condArgs[1].value, ctx, options));
          if (firstArgName === 'url') where.urlIncludes = value;
          if (firstArgName === 'response') where.responseContains = value;
        } else if (cond.name === 'equals') {
          const value = await evaluateExpression(condArgs[1].value, ctx, options);
          if (firstArgName === 'method') where.method = value;
          if (firstArgName === 'status') where.status = value;
        } else if (cond.name === 'matches') {
          const value = String(await evaluateExpression(condArgs[1].value, ctx, options));
          if (firstArgName === 'url') where.urlRegex = value;
        }
      }
    }
  }

  // Poll for the request
  const pollInterval = 400;

  // Give response handlers time to complete when matching on response body
  if (where.responseContains != null) {
    await sleepMs(Math.min(pollInterval * 4, 2000));
  }

  let requestId = ctx.networkCapture.getRequestIdByIndex(where as any, 'last');

  if (requestId == null && waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleepMs(pollInterval);
      requestId = ctx.networkCapture.getRequestIdByIndex(where as any, 'last');
      if (requestId != null) break;
    }
  }

  if (requestId == null) {
    throw new Error(`network.find: no request matched (where: ${JSON.stringify(where)})`);
  }

  return requestId;
}

async function executeNetworkReplay(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  if (!ctx.networkCapture) {
    throw new Error('network.replay requires network capture to be enabled');
  }

  const positionalArgs = getPositionalArgs(call.args);
  const requestId = String(await evaluateExpression(positionalArgs[0].value, ctx, options));

  // Parse overrides from second positional arg (object literal)
  let overrides: Record<string, unknown> | undefined;
  if (positionalArgs[1]) {
    overrides = (await evaluateExpression(positionalArgs[1].value, ctx, options)) as Record<
      string,
      unknown
    >;
  }

  const replayOverrides = overrides
    ? buildNetworkReplayOverrides(overrides)
    : undefined;

  const result = await ctx.networkCapture.replay(requestId, replayOverrides as any);

  const responseType = overrides?.response ?? 'text';

  if (responseType === 'json') {
    try {
      return JSON.parse(result.body);
    } catch {
      throw new Error(`network.replay: response body is not valid JSON (status ${result.status})`);
    }
  }

  return result.body;
}

function buildNetworkReplayOverrides(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};

  if (obj.url_replace && Array.isArray(obj.url_replace)) {
    overrides.urlReplace = [{ find: obj.url_replace[0], replace: obj.url_replace[1] }];
  }
  if (obj.body_replace && Array.isArray(obj.body_replace)) {
    overrides.bodyReplace = [{ find: obj.body_replace[0], replace: obj.body_replace[1] }];
  }
  if (obj.query_set) overrides.setQuery = obj.query_set;
  if (obj.headers_set) overrides.setHeaders = obj.headers_set;
  if (obj.url) overrides.url = obj.url;
  if (obj.body) overrides.body = obj.body;

  return Object.keys(overrides).length > 0 ? overrides : {};
}

async function executeExtract(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  const positionalArgs = getPositionalArgs(call.args);
  const data = await evaluateExpression(positionalArgs[0].value, ctx, options);

  const pathExpr = getNamedArg(call.args, 'path');
  const asExpr = getNamedArg(call.args, 'as');

  if (pathExpr) {
    const pathStr = String(await evaluateExpression(pathExpr, ctx, options));
    const { search } = await import('@jmespath-community/jmespath');
    return search(data as any, pathStr);
  }

  if (asExpr) {
    const asType = String(await evaluateExpression(asExpr, ctx, options));
    if (asType === 'text') {
      return typeof data === 'string' ? data : JSON.stringify(data);
    }
  }

  return data;
}

// ─── Tab Steps ──────────────────────────────────────────────

async function executeNewTab(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<unknown> {
  if (!ctx.browserContext) {
    throw new Error('new_tab requires a browser context');
  }

  const positionalArgs = getPositionalArgs(call.args);
  const url = positionalArgs[0]
    ? String(await evaluateExpression(positionalArgs[0].value, ctx, options))
    : undefined;

  const newPage = await ctx.browserContext.newPage();

  if (url) {
    try {
      await newPage.goto(url, { waitUntil: 'networkidle' });
    } catch (err: any) {
      if (!(err?.name === 'TimeoutError' || err?.message?.includes('Timeout'))) {
        throw err;
      }
    }
  }

  // Switch to the new page
  const pages = ctx.browserContext.pages();
  const tabIndex = pages.indexOf(newPage);
  ctx.page = newPage;

  return tabIndex;
}

async function executeSwitchTab(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  if (!ctx.browserContext) {
    throw new Error('switch_tab requires a browser context');
  }

  const positionalArgs = getPositionalArgs(call.args);
  const tabArg = await evaluateExpression(positionalArgs[0].value, ctx, options);

  const pages = ctx.browserContext.pages();
  let targetIndex: number;

  if (tabArg === 'last') {
    targetIndex = pages.length - 1;
  } else if (tabArg === 'previous') {
    // Use internal tracking
    const prev = ctx.vars['__previousTabIndex'] as number | undefined;
    if (prev === undefined) throw new Error('switch_tab: no previous tab');
    targetIndex = prev;
  } else {
    targetIndex = Number(tabArg);
  }

  if (targetIndex < 0 || targetIndex >= pages.length) {
    throw new Error(`switch_tab: tab index ${targetIndex} out of range (0-${pages.length - 1})`);
  }

  const closeCurrentExpr = getNamedArg(call.args, 'close_current');
  if (closeCurrentExpr) {
    const shouldClose = Boolean(await evaluateExpression(closeCurrentExpr, ctx, options));
    if (shouldClose) {
      await ctx.page.close();
    }
  }

  ctx.vars['__previousTabIndex'] = pages.indexOf(ctx.page);
  ctx.page = pages[targetIndex];
  await ctx.page.bringToFront();
}

// ─── Frame Steps ────────────────────────────────────────────

async function executeFrameEnter(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<void> {
  const positionalArgs = getPositionalArgs(call.args);
  const nameExpr = getNamedArg(call.args, 'name');
  const urlExpr = getNamedArg(call.args, 'url');

  let frame: Frame | null = null;

  if (positionalArgs.length > 0 && positionalArgs[0].value.type === 'TargetExpression') {
    // frame.enter(@css("iframe.content"))
    const locator = await resolveTargetExpression(
      positionalArgs[0].value as TargetExpression,
      ctx,
      options,
    );
    const handle = await locator.first().elementHandle();
    if (handle) {
      frame = await handle.contentFrame();
    }
  } else if (nameExpr) {
    const name = String(await evaluateExpression(nameExpr, ctx, options));
    frame = ctx.page.frame({ name });
  } else if (urlExpr) {
    const url = String(await evaluateExpression(urlExpr, ctx, options));
    frame = ctx.page.frame({ url });
  }

  if (!frame) {
    throw new Error('frame.enter: frame not found');
  }

  ctx.currentFrame = frame;
}

// ─── Built-in Functions ─────────────────────────────────────

async function executeContains(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<boolean> {
  const positionalArgs = getPositionalArgs(call.args);
  const haystack = await evaluateExpression(positionalArgs[0].value, ctx, options);
  const needle = await evaluateExpression(positionalArgs[1].value, ctx, options);

  if (typeof haystack === 'string') {
    return haystack.includes(String(needle));
  }
  if (Array.isArray(haystack)) {
    return haystack.includes(needle);
  }
  return false;
}

async function executeEquals(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<boolean> {
  const positionalArgs = getPositionalArgs(call.args);
  const a = await evaluateExpression(positionalArgs[0].value, ctx, options);
  const b = await evaluateExpression(positionalArgs[1].value, ctx, options);
  return a === b;
}

async function executeMatches(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<boolean> {
  const positionalArgs = getPositionalArgs(call.args);
  const value = String(await evaluateExpression(positionalArgs[0].value, ctx, options));
  const pattern = String(await evaluateExpression(positionalArgs[1].value, ctx, options));
  return new RegExp(pattern).test(value);
}

async function executeLen(
  call: StepCall,
  ctx: ShowScriptContext,
  options?: ShowScriptOptions,
): Promise<number> {
  const positionalArgs = getPositionalArgs(call.args);
  const value = await evaluateExpression(positionalArgs[0].value, ctx, options);
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length;
  return 0;
}
