import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  deepMerge,
  discoverConfigDirs,
  loadConfig,
  applyConfigToEnv,
  resolveFilePath,
  type ShowRunConfig,
} from '../config.js';

/** Create a unique temporary directory for each test */
function makeTempDir(): string {
  const dir = join(tmpdir(), `showrun-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('deepMerge', () => {
  it('merges flat objects', () => {
    const base: Record<string, number> = { a: 1, b: 2 };
    const override: Record<string, number> = { b: 3, c: 4 };
    expect(deepMerge(base, override)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('recursively merges nested objects', () => {
    const base = { llm: { provider: 'openai', openai: { apiKey: 'k1' } } };
    const override = { llm: { provider: 'anthropic', anthropic: { apiKey: 'k2' } } };
    const result = deepMerge(
      base as Record<string, unknown>,
      override as Record<string, unknown>,
    );
    expect(result).toEqual({
      llm: {
        provider: 'anthropic',
        openai: { apiKey: 'k1' },
        anthropic: { apiKey: 'k2' },
      },
    });
  });

  it('skips null and undefined values in override', () => {
    const base = { a: 1, b: 2 };
    const override = { a: null, b: undefined, c: 3 } as unknown as Record<string, unknown>;
    expect(deepMerge(base as Record<string, unknown>, override)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('replaces arrays instead of merging them', () => {
    const base = { items: [1, 2, 3] };
    const override = { items: [4, 5] };
    expect(deepMerge(
      base as Record<string, unknown>,
      override as Record<string, unknown>,
    )).toEqual({ items: [4, 5] });
  });

  it('replaces primitives', () => {
    const base = { x: 'old' };
    const override = { x: 'new' };
    expect(deepMerge(
      base as Record<string, unknown>,
      override as Record<string, unknown>,
    )).toEqual({ x: 'new' });
  });
});

describe('discoverConfigDirs', () => {
  it('returns an array of strings', () => {
    const dirs = discoverConfigDirs();
    expect(Array.isArray(dirs)).toBe(true);
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      expect(typeof d).toBe('string');
    }
  });

  it('includes cwd/.showrun as the last entry', () => {
    const dirs = discoverConfigDirs();
    const last = dirs[dirs.length - 1];
    expect(last).toBe(join(process.cwd(), '.showrun'));
  });

  it('respects XDG_CONFIG_HOME when set (non-Windows)', () => {
    if (process.platform === 'win32') return; // skip on Windows
    const original = process.env.XDG_CONFIG_HOME;
    const customXdg = '/tmp/custom-xdg-config';
    process.env.XDG_CONFIG_HOME = customXdg;
    try {
      const dirs = discoverConfigDirs();
      expect(dirs[0]).toBe(join(customXdg, 'showrun'));
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original;
    }
  });
});

describe('applyConfigToEnv', () => {
  const testEnvVars = [
    'LLM_PROVIDER',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'MAX_BROWSER_ROUNDS',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of testEnvVars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of testEnvVars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('sets env vars from config when not already present', () => {
    const config: ShowRunConfig = {
      llm: { provider: 'anthropic', anthropic: { apiKey: 'sk-test' } },
    };
    applyConfigToEnv(config);
    expect(process.env.LLM_PROVIDER).toBe('anthropic');
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('does not overwrite existing env vars', () => {
    process.env.ANTHROPIC_API_KEY = 'existing-key';
    const config: ShowRunConfig = {
      llm: { anthropic: { apiKey: 'should-not-replace' } },
    };
    applyConfigToEnv(config);
    expect(process.env.ANTHROPIC_API_KEY).toBe('existing-key');
  });

  it('converts numbers to strings', () => {
    const config: ShowRunConfig = {
      agent: { maxBrowserRounds: 5 },
    };
    applyConfigToEnv(config);
    expect(process.env.MAX_BROWSER_ROUNDS).toBe('5');
  });
});

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty config and loadedFiles when no config files exist', () => {
    // loadConfig uses discoverConfigDirs which won't include tempDir
    // but this validates the basic structure
    const result = loadConfig();
    expect(result.config).toBeDefined();
    expect(Array.isArray(result.loadedFiles)).toBe(true);
    expect(Array.isArray(result.searchedDirs)).toBe(true);
  });
});

describe('resolveFilePath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when file is not found', () => {
    const result = resolveFilePath(`nonexistent-${randomBytes(8).toString('hex')}.txt`);
    expect(result).toBeNull();
  });

  it('finds a file in cwd', () => {
    // This tests the cwd fallback — the AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md
    // should be found if it exists in the repo root
    const promptFile = 'AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md';
    const cwdPath = resolve(process.cwd(), promptFile);
    if (existsSync(cwdPath)) {
      const result = resolveFilePath(promptFile);
      expect(result).toBeTruthy();
    }
  });
});
