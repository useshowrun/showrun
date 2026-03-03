import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parse } from '@showrun/showscript';
import type { Program, FlowBlock } from '@showrun/showscript';
import { executeShowScript, type ShowScriptContext } from './showscript-interpreter.js';

// ─── Mock Page ──────────────────────────────────────────────

function createMockLocator(opts: {
  text?: string;
  count?: number;
  visible?: boolean;
  attr?: Record<string, string>;
} = {}) {
  const loc: any = {
    count: vi.fn().mockResolvedValue(opts.count ?? 1),
    first: vi.fn().mockReturnThis(),
    nth: vi.fn().mockReturnThis(),
    textContent: vi.fn().mockResolvedValue(opts.text ?? ''),
    getAttribute: vi.fn().mockImplementation((name: string) =>
      Promise.resolve(opts.attr?.[name] ?? null),
    ),
    isVisible: vi.fn().mockResolvedValue(opts.visible ?? true),
    waitFor: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    elementHandle: vi.fn().mockResolvedValue(null),
    innerHTML: vi.fn().mockResolvedValue('<div></div>'),
    locator: vi.fn().mockReturnThis(),
    getByText: vi.fn().mockReturnThis(),
    getByRole: vi.fn().mockReturnThis(),
    getByLabel: vi.fn().mockReturnThis(),
    getByPlaceholder: vi.fn().mockReturnThis(),
    getByAltText: vi.fn().mockReturnThis(),
    getByTestId: vi.fn().mockReturnThis(),
  };
  // Make nth return a locator with same methods
  loc.nth.mockReturnValue(loc);
  loc.first.mockReturnValue(loc);
  return loc;
}

function createMockPage(locatorOpts?: Parameters<typeof createMockLocator>[0]) {
  const loc = createMockLocator(locatorOpts);
  const page: any = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://example.com/dashboard'),
    title: vi.fn().mockResolvedValue('Example Page'),
    locator: vi.fn().mockReturnValue(loc),
    getByText: vi.fn().mockReturnValue(loc),
    getByRole: vi.fn().mockReturnValue(loc),
    getByLabel: vi.fn().mockReturnValue(loc),
    getByPlaceholder: vi.fn().mockReturnValue(loc),
    getByAltText: vi.fn().mockReturnValue(loc),
    getByTestId: vi.fn().mockReturnValue(loc),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
    },
    close: vi.fn().mockResolvedValue(undefined),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    frame: vi.fn().mockReturnValue(null),
    _mockLocator: loc,
  };
  return page;
}

function createCtx(pageOpts?: Parameters<typeof createMockLocator>[0]): ShowScriptContext {
  return {
    page: createMockPage(pageOpts),
    vars: {},
    inputs: {},
    collectibles: {},
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('ShowScript Interpreter', () => {
  describe('Literals and assignments', () => {
    it('assigns string literal to variable', async () => {
      const ast = parse('flow:\n    x = "hello"');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe('hello');
    });

    it('assigns number literal', async () => {
      const ast = parse('flow:\n    x = 42');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(42);
    });

    it('assigns boolean literal', async () => {
      const ast = parse('flow:\n    x = true');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(true);
    });

    it('assigns null literal', async () => {
      const ast = parse('flow:\n    x = null');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(null);
    });

    it('assigns array literal', async () => {
      const ast = parse('flow:\n    x = [1, 2, 3]');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toEqual([1, 2, 3]);
    });

    it('assigns object literal', async () => {
      const ast = parse('flow:\n    x = { a: 1, b: "two" }');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toEqual({ a: 1, b: 'two' });
    });
  });

  describe('Binary expressions', () => {
    it('evaluates arithmetic', async () => {
      const ast = parse('flow:\n    x = 2 + 3 * 4');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(14);
    });

    it('evaluates comparison', async () => {
      const ast = parse('flow:\n    x = 5 > 3');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(true);
    });

    it('evaluates string concatenation', async () => {
      const ast = parse('flow:\n    x = "hello" + " " + "world"');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe('hello world');
    });

    it('evaluates logical operators', async () => {
      const ast = parse('flow:\n    x = true && false');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(false);
    });
  });

  describe('Unary expressions', () => {
    it('evaluates negation', async () => {
      const ast = parse('flow:\n    x = -5');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(-5);
    });

    it('evaluates logical not', async () => {
      const ast = parse('flow:\n    x = !true');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(false);
    });
  });

  describe('F-strings', () => {
    it('interpolates variables', async () => {
      const ast = parse('flow:\n    name = "world"\n    x = f"hello {name}"');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe('hello world');
    });

    it('applies filters', async () => {
      const ast = parse('flow:\n    q = "hello world"\n    x = f"{q | urlencode}"');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe('hello%20world');
    });
  });

  describe('Control flow', () => {
    it('executes if/true branch', async () => {
      const ast = parse(`
flow:
    x = 0
    if (true) {
        x = 1
    }
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(1);
    });

    it('executes else branch', async () => {
      const ast = parse(`
flow:
    x = 0
    if (false) {
        x = 1
    } else {
        x = 2
    }
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(2);
    });

    it('executes elif branch', async () => {
      const ast = parse(`
flow:
    x = 0
    if (false) {
        x = 1
    } elif (true) {
        x = 2
    } else {
        x = 3
    }
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(2);
    });

    it('executes while loop', async () => {
      const ast = parse(`
flow:
    i = 0
    while (i < 5) {
        i = i + 1
    }
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.i).toBe(5);
    });

    it('collects yielded values from while loop', async () => {
      const ast = parse(`
flow:
    i = 0
    results = while (i < 3) {
        i = i + 1
        yield i
    }
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.results).toEqual([1, 2, 3]);
    });

    it('executes for loop with range', async () => {
      const ast = parse(`
flow:
    sum = 0
    for (i in range(1, 5)) {
        sum = sum + i
    }
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.sum).toBe(15);
    });

    it('collects yielded values from for loop', async () => {
      const ast = parse(`
flow:
    results = for (i in range(1, 3)) {
        yield i * 2
    }
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.results).toEqual([2, 4, 6]);
    });
  });

  describe('Built-in functions', () => {
    it('contains() checks string inclusion', async () => {
      const ast = parse(`
flow:
    x = contains("hello world", "world")
    y = contains("hello", "xyz")
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(true);
      expect(ctx.vars.y).toBe(false);
    });

    it('equals() checks equality', async () => {
      const ast = parse(`
flow:
    x = equals(5, 5)
    y = equals("a", "b")
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(true);
      expect(ctx.vars.y).toBe(false);
    });

    it('matches() checks regex', async () => {
      const ast = parse(`
flow:
    x = matches("test123", r"\\d+")
    y = matches("abc", r"\\d+")
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(true);
      expect(ctx.vars.y).toBe(false);
    });

    it('len() returns length', async () => {
      const ast = parse(`
flow:
    arr = [1, 2, 3]
    x = len(arr)
    y = len("hello")
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(3);
      expect(ctx.vars.y).toBe(5);
    });

    it('title() returns page title', async () => {
      const ast = parse(`
flow:
    t = title()
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.t).toBe('Example Page');
    });
  });

  describe('Built-in variables', () => {
    it('url resolves to current page URL', async () => {
      const ast = parse(`
flow:
    x = contains(url, "/dashboard")
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(true);
    });
  });

  describe('Steps', () => {
    it('executes goto step', async () => {
      const ast = parse('flow:\n    goto("https://example.com")');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.page.goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'networkidle',
      });
    });

    it('executes click step', async () => {
      const ast = parse('flow:\n    click(@css(".button"))');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      const loc = (ctx.page as any)._mockLocator;
      expect(ctx.page.locator).toHaveBeenCalledWith('.button');
      expect(loc.click).toHaveBeenCalled();
    });

    it('executes fill step', async () => {
      const ast = parse('flow:\n    fill(@css("input"), "hello")');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      const loc = (ctx.page as any)._mockLocator;
      expect(loc.fill).toHaveBeenCalledWith('hello');
    });

    it('executes press step', async () => {
      const ast = parse('flow:\n    press("Enter")');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect((ctx.page as any).keyboard.press).toHaveBeenCalledWith('Enter');
    });

    it('executes sleep step', async () => {
      const ast = parse('flow:\n    sleep(10ms)');
      const ctx = createCtx();
      const start = Date.now();
      await executeShowScript(ast, ctx);
      // Should complete quickly (10ms + overhead)
      expect(Date.now() - start).toBeLessThan(500);
    });

    it('executes assert with boolean condition', async () => {
      const ast = parse('flow:\n    assert(true, message: "should pass")');
      const ctx = createCtx();
      await expect(executeShowScript(ast, ctx)).resolves.not.toThrow();
    });

    it('throws on failed assert', async () => {
      const ast = parse('flow:\n    assert(false, message: "expected failure")');
      const ctx = createCtx();
      await expect(executeShowScript(ast, ctx)).rejects.toThrow('expected failure');
    });
  });

  describe('Inputs and outputs', () => {
    it('applies input defaults', async () => {
      const ast = parse(`
inputs:
    name: string = "default_name"

flow:
    x = name
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe('default_name');
    });

    it('uses provided inputs over defaults', async () => {
      const ast = parse(`
inputs:
    name: string = "default_name"

flow:
    x = name
`);
      const ctx = createCtx();
      ctx.inputs = { name: 'custom_name' };
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe('custom_name');
    });

    it('collects outputs from vars', async () => {
      const ast = parse(`
outputs:
    result: string

flow:
    result = "done"
`);
      const ctx = createCtx();
      const outputs = await executeShowScript(ast, ctx);
      expect(outputs.result).toBe('done');
    });
  });

  describe('Property access', () => {
    it('accesses object properties', async () => {
      const ast = parse(`
flow:
    obj = { a: 1, b: "hello" }
    x = obj.a
    y = obj.b
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(1);
      expect(ctx.vars.y).toBe('hello');
    });

    it('accesses .empty on arrays', async () => {
      const ast = parse(`
flow:
    arr = []
    x = arr.empty
    arr2 = [1]
    y = arr2.empty
`);
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(true);
      expect(ctx.vars.y).toBe(false);
    });
  });

  describe('Duration literals', () => {
    it('converts seconds to ms', async () => {
      const ast = parse('flow:\n    x = 5s');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(5000);
    });

    it('converts ms to ms', async () => {
      const ast = parse('flow:\n    x = 100ms');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(100);
    });

    it('converts minutes to ms', async () => {
      const ast = parse('flow:\n    x = 1m');
      const ctx = createCtx();
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(60000);
    });
  });

  describe('Optional steps', () => {
    it('continues on optional step failure', async () => {
      const ast = parse(`
flow:
    x = 0
    click(@css(".nonexistent"), optional: true)
    x = 1
`);
      const ctx = createCtx();
      const mockLoc = (ctx.page as any)._mockLocator;
      mockLoc.click.mockRejectedValueOnce(new Error('element not found'));
      await executeShowScript(ast, ctx);
      expect(ctx.vars.x).toBe(1);
    });
  });
});
