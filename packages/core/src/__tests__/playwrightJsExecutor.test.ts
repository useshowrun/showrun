import { describe, it, expect, vi } from 'vitest';
import { executePlaywrightJs, extractFunctionBody } from '../dsl/playwrightJsExecutor.js';
import type { PlaywrightJsScope } from '../dsl/playwrightJsExecutor.js';

// Minimal mock page/context/frame for testing
function createMockScope(overrides?: Partial<PlaywrightJsScope>): PlaywrightJsScope {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue('Test Title'),
    url: vi.fn().mockReturnValue('https://example.com'),
    locator: vi.fn().mockReturnValue({
      evaluateAll: vi.fn().mockResolvedValue([]),
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    mouse: { click: vi.fn().mockResolvedValue(undefined) },
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as any;

  return {
    page: mockPage,
    context: {} as any,
    frame: {} as any,
    inputs: { query: 'hello' },
    secrets: { apiKey: 'secret123' },
    showrun: {
      network: {
        list: vi.fn().mockResolvedValue([]),
        find: vi.fn().mockResolvedValue(null),
        get: vi.fn().mockResolvedValue(null),
        replay: vi.fn().mockResolvedValue({ status: 200, contentType: 'application/json', body: '{}', bodySize: 2 }),
      },
    },
    util: {
      detectCloudflareTurnstile: vi.fn().mockResolvedValue({ found: false }),
      solveCloudflareTurnstile: vi.fn().mockResolvedValue({ success: false, detected: false }),
    },
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
    expect(result.collectibles).toEqual({ result: 'hello_processed' });
    expect(result.logs).toEqual([]);
  });

  it('can call page methods', async () => {
    const code = `module.exports = async function({ page }) {
      const t = await page.title();
      return { title: t };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result.collectibles).toEqual({ title: 'Test Title' });
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
    expect(result.collectibles.hasProcess).toBe(false);
    expect(result.collectibles.hasRequire).toBe(false);
    expect(result.collectibles.hasBuffer).toBe(false);
    expect(result.collectibles.hasGlobal).toBe(false);
    expect(result.collectibles.hasGlobalThis).toBe(false);
    expect(result.collectibles.hasFetch).toBe(false);
    expect(result.collectibles.hasEval).toBe(false);
    expect(result.collectibles.hasFunction).toBe(false);
    expect(result.collectibles.hasSetTimeout).toBe(false);
  });

  it('freezes inputs (mutations do not propagate)', async () => {
    const code = `module.exports = async function({ inputs }) {
      inputs.query = 'modified';
      return { value: inputs.query };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    // Frozen object silently ignores assignment in sloppy mode
    expect(result.collectibles.value).toBe('hello');
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
    expect(result.collectibles.value).toBe('secret123');
    expect(scope.secrets.apiKey).toBe('secret123');
  });

  it('returns empty object when code returns undefined', async () => {
    const code = `module.exports = async function({ page }) {
      // no return
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result.collectibles).toEqual({});
  });

  it('can access showrun.network.replay', async () => {
    const code = `module.exports = async function({ showrun }) {
      const res = await showrun.network.replay('req-1');
      return { status: res.status };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result.collectibles).toEqual({ status: 200 });
    expect(scope.showrun.network.replay).toHaveBeenCalledWith('req-1');
  });

  it('can access showrun.network.list', async () => {
    const code = `module.exports = async function({ showrun }) {
      const entries = await showrun.network.list();
      return { count: entries.length };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result.collectibles).toEqual({ count: 0 });
    expect(scope.showrun.network.list).toHaveBeenCalled();
  });

  it('can access showrun.network.find', async () => {
    const code = `module.exports = async function({ showrun }) {
      const entry = await showrun.network.find({ urlIncludes: '/api' });
      return { found: entry !== null };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result.collectibles).toEqual({ found: false });
    expect(scope.showrun.network.find).toHaveBeenCalledWith({ urlIncludes: '/api' });
  });

  it('captures console.log output', async () => {
    const code = `module.exports = async function({ page }) {
      console.log('hello', 'world');
      console.warn('a warning');
      console.error('an error');
      console.info('info message');
      return { done: true };
    };`;
    const scope = createMockScope();
    const result = await executePlaywrightJs(code, scope);
    expect(result.collectibles).toEqual({ done: true });
    expect(result.logs).toEqual([
      'hello world',
      '[warn] a warning',
      '[error] an error',
      'info message',
    ]);
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
