import { describe, it, expect, vi } from 'vitest';
import { executePlaywrightJs, extractFunctionBody } from '../dsl/playwrightJsExecutor.js';
import type { PlaywrightJsScope } from '../dsl/playwrightJsExecutor.js';

// Minimal mock page/context/frame for testing
function createMockScope(overrides?: Partial<PlaywrightJsScope>): PlaywrightJsScope {
  return {
    page: {
      goto: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue('Test Title'),
      url: vi.fn().mockReturnValue('https://example.com'),
      locator: vi.fn().mockReturnValue({
        evaluateAll: vi.fn().mockResolvedValue([]),
      }),
    } as any,
    context: {} as any,
    frame: {} as any,
    inputs: { query: 'hello' },
    secrets: { apiKey: 'secret123' },
    replay: vi.fn().mockResolvedValue({ status: 200, contentType: 'application/json', body: '{}', bodySize: 2 }),
    ...overrides,
  };
}

describe('extractFunctionBody', () => {
  it('extracts body from async function export', () => {
    const code = `module.exports = async function({ page }) {
      await page.goto('https://example.com');
      return { title: 'test' };
    };`;
    const body = extractFunctionBody(code);
    expect(body).toContain("await page.goto('https://example.com')");
    expect(body).toContain("return { title: 'test' }");
  });

  it('extracts body from async arrow export', () => {
    const code = `module.exports = async ({ page }) => {
      return { title: await page.title() };
    };`;
    const body = extractFunctionBody(code);
    expect(body).toContain('return { title: await page.title() }');
  });

  it('throws on invalid format', () => {
    expect(() => extractFunctionBody('const x = 1;')).toThrow(
      'Could not parse flow.playwright.js'
    );
  });
});

describe('executePlaywrightJs', () => {
  it('returns collectibles from user code', async () => {
    const code = `module.exports = async function({ page, inputs }) {
      return { result: inputs.query + '_processed' };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result).toEqual({ result: 'hello_processed' });
  });

  it('can call page methods', async () => {
    const code = `module.exports = async function({ page }) {
      const t = await page.title();
      return { title: t };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result).toEqual({ title: 'Test Title' });
    expect(scope.page.title).toHaveBeenCalled();
  });

  it('blocks dangerous globals', async () => {
    const code = `module.exports = async function({ page }) {
      return {
        hasProcess: typeof process !== 'undefined',
        hasRequire: typeof require !== 'undefined',
        hasBuffer: typeof Buffer !== 'undefined',
        hasGlobal: typeof global !== 'undefined',
        hasGlobalThis: typeof globalThis !== 'undefined',
        hasFetch: typeof fetch !== 'undefined',
        hasEval: typeof eval !== 'undefined',
        hasFunction: typeof Function !== 'undefined',
        hasSetTimeout: typeof setTimeout !== 'undefined',
      };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result.hasProcess).toBe(false);
    expect(result.hasRequire).toBe(false);
    expect(result.hasBuffer).toBe(false);
    expect(result.hasGlobal).toBe(false);
    expect(result.hasGlobalThis).toBe(false);
    expect(result.hasFetch).toBe(false);
    expect(result.hasEval).toBe(false);
    expect(result.hasFunction).toBe(false);
    expect(result.hasSetTimeout).toBe(false);
  });

  it('freezes inputs (mutations do not propagate)', async () => {
    const code = `module.exports = async function({ inputs }) {
      inputs.query = 'modified';
      return { value: inputs.query };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    // Frozen object silently ignores assignment in sloppy mode
    expect(result.value).toBe('hello');
    // Original scope inputs are also unmodified
    expect(scope.inputs.query).toBe('hello');
  });

  it('freezes secrets (mutations do not propagate)', async () => {
    const code = `module.exports = async function({ secrets }) {
      secrets.apiKey = 'hacked';
      return { value: secrets.apiKey };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result.value).toBe('secret123');
    expect(scope.secrets.apiKey).toBe('secret123');
  });

  it('returns empty object when code returns undefined', async () => {
    const code = `module.exports = async function({ page }) {
      // no return
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result).toEqual({});
  });

  it('can access replay function', async () => {
    const code = `module.exports = async function({ replay }) {
      const res = await replay('req-1');
      return { status: res.status };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result).toEqual({ status: 200 });
    expect(scope.replay).toHaveBeenCalledWith('req-1');
  });

  it('times out on long-running code', async () => {
    const code = `module.exports = async function({ page }) {
      await new Promise(() => {}); // never resolves
      return {};
    };`;
    const scope = createMockScope();
    await expect(
      executePlaywrightJs(code, scope, 100) // 100ms timeout
    ).rejects.toThrow('timed out');
  });
});
