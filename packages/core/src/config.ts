/**
 * System-wide configuration for ShowRun.
 *
 * Layered config discovery:
 *   Built-in defaults < global config.json < project config.json < .env < real env vars
 *
 * Config directory search order (lowest → highest priority):
 *   Linux/macOS: $XDG_CONFIG_HOME/showrun/ → ~/.showrun/ → ancestor .showrun/ → cwd/.showrun/
 *   Windows:     %APPDATA%\showrun\        → ancestor .showrun\ → cwd\.showrun\
 */

import { existsSync, readFileSync, copyFileSync } from 'fs';
import { resolve, join, parse as parsePath } from 'path';
import { platform, homedir } from 'os';
import { cwd } from 'process';
import { ensureDir, readJsonFile, atomicWrite } from './packUtils.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface LlmProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface ShowRunConfig {
  llm?: {
    provider?: string;
    anthropic?: LlmProviderConfig;
    openai?: LlmProviderConfig;
  };
  agent?: {
    maxBrowserRounds?: number;
  };
  prompts?: {
    teachChatSystemPrompt?: string;
    autonomousExplorationPromptPath?: string;
    teachModeSystemPromptPath?: string;
  };
}

export interface ResolvedConfigPaths {
  config: ShowRunConfig;
  /** Config files that were loaded, in priority order (lowest first) */
  loadedFiles: string[];
  /** All directories that were searched */
  searchedDirs: string[];
}

// ── Deep merge helper ──────────────────────────────────────────────────────

/**
 * Recursively merge `override` into `base`, returning a new object.
 * - Primitives and arrays in override replace base values.
 * - Null/undefined values in override are skipped.
 * - Nested plain objects are merged recursively.
 */
export function deepMerge<T>(base: T, override: T): T {
  if (
    typeof base !== 'object' || base === null ||
    typeof override !== 'object' || override === null ||
    Array.isArray(base) || Array.isArray(override)
  ) {
    return override;
  }

  const result = { ...base } as Record<string, unknown>;
  const src = override as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const overrideVal = src[key];
    if (overrideVal === null || overrideVal === undefined) continue;

    const baseVal = result[key];
    if (
      typeof baseVal === 'object' && baseVal !== null && !Array.isArray(baseVal) &&
      typeof overrideVal === 'object' && overrideVal !== null && !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }
  return result as T;
}

// ── Directory discovery ────────────────────────────────────────────────────

/**
 * Walk from `startDir` up toward the filesystem root, collecting every
 * `.showrun/` directory encountered. Returns in bottom-up order (closest
 * ancestor first) which is the *highest* priority order.
 */
function walkUpForShowrunDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(startDir);
  const root = parsePath(dir).root;
  // Skip cwd itself — handled separately
  dir = resolve(dir, '..');
  while (dir !== root && dir.length > root.length) {
    const candidate = join(dir, '.showrun');
    if (existsSync(candidate)) {
      dirs.push(candidate);
    }
    dir = resolve(dir, '..');
  }
  // Reverse so that farthest ancestor is first (lowest priority)
  return dirs.reverse();
}

/**
 * Returns an ordered list of config directories to search, lowest priority first.
 */
export function discoverConfigDirs(): string[] {
  const dirs: string[] = [];
  const os = platform();
  const home = homedir();
  const currentDir = cwd();

  if (os === 'win32') {
    // Windows: %APPDATA%\showrun
    const appData = process.env.APPDATA;
    if (appData) {
      dirs.push(join(appData, 'showrun'));
    }
  } else {
    // Linux/macOS: XDG_CONFIG_HOME/showrun (default ~/.config/showrun)
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config');
    dirs.push(join(xdgConfig, 'showrun'));

    // ~/.showrun
    dirs.push(join(home, '.showrun'));
  }

  // Ancestor .showrun/ directories (farthest ancestor first = lowest priority)
  dirs.push(...walkUpForShowrunDirs(currentDir));

  // cwd/.showrun (highest priority)
  dirs.push(join(currentDir, '.showrun'));

  return dirs;
}

// ── Config loading ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ShowRunConfig = {};

/**
 * Load all `config.json` files from discovered directories, merge them, and
 * return the result along with metadata about which files were loaded.
 */
export function loadConfig(): ResolvedConfigPaths {
  const searchedDirs = discoverConfigDirs();
  let merged: ShowRunConfig = { ...DEFAULT_CONFIG };
  const loadedFiles: string[] = [];

  for (const dir of searchedDirs) {
    const configPath = join(dir, 'config.json');
    if (existsSync(configPath)) {
      try {
        const fileConfig = readJsonFile<ShowRunConfig>(configPath);
        merged = deepMerge(merged, fileConfig);
        loadedFiles.push(configPath);
      } catch (err) {
        console.warn(`[Config] Failed to load ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { config: merged, loadedFiles, searchedDirs };
}

// ── Env var mapping ────────────────────────────────────────────────────────

/** Map of config path → env var name */
const CONFIG_TO_ENV: Array<{ path: string[]; envVar: string }> = [
  { path: ['llm', 'provider'], envVar: 'LLM_PROVIDER' },
  { path: ['llm', 'anthropic', 'apiKey'], envVar: 'ANTHROPIC_API_KEY' },
  { path: ['llm', 'anthropic', 'model'], envVar: 'ANTHROPIC_MODEL' },
  { path: ['llm', 'anthropic', 'baseUrl'], envVar: 'ANTHROPIC_BASE_URL' },
  { path: ['llm', 'openai', 'apiKey'], envVar: 'OPENAI_API_KEY' },
  { path: ['llm', 'openai', 'model'], envVar: 'OPENAI_MODEL' },
  { path: ['llm', 'openai', 'baseUrl'], envVar: 'OPENAI_BASE_URL' },
  { path: ['agent', 'maxBrowserRounds'], envVar: 'MAX_BROWSER_ROUNDS' },
  { path: ['prompts', 'teachChatSystemPrompt'], envVar: 'TEACH_CHAT_SYSTEM_PROMPT' },
  { path: ['prompts', 'autonomousExplorationPromptPath'], envVar: 'AUTONOMOUS_EXPLORATION_PROMPT_PATH' },
  { path: ['prompts', 'teachModeSystemPromptPath'], envVar: 'TEACH_MODE_SYSTEM_PROMPT_PATH' },
];

function getNestedValue(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Apply config values to `process.env`, only setting vars that are not already present.
 */
export function applyConfigToEnv(config: ShowRunConfig): void {
  for (const { path, envVar } of CONFIG_TO_ENV) {
    if (process.env[envVar]) continue; // real env / dotenv takes precedence
    const value = getNestedValue(config as Record<string, unknown>, path);
    if (value !== undefined && value !== null) {
      process.env[envVar] = String(value);
    }
  }
}

// ── File resolution ────────────────────────────────────────────────────────

/**
 * Resolve a filename by searching local paths first (cwd, then ancestors),
 * then config directories (highest priority first).
 * Local files always win over config dir copies.
 * Returns the first existing path, or null.
 */
export function resolveFilePath(filename: string): string | null {
  // 1. Search cwd first — local files take priority
  const cwdPath = resolve(cwd(), filename);
  if (existsSync(cwdPath)) return cwdPath;

  // 2. Walk up from cwd looking for the file directly (not inside .showrun)
  let dir = resolve(cwd(), '..');
  const root = parsePath(dir).root;
  while (dir !== root && dir.length > root.length) {
    const candidate = resolve(dir, filename);
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, '..');
  }

  // 3. Fall back to config dirs from highest priority (last) to lowest (first)
  const configDirs = discoverConfigDirs();
  for (let i = configDirs.length - 1; i >= 0; i--) {
    const candidate = join(configDirs[i], filename);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// ── System prompt helper ───────────────────────────────────────────────────

/**
 * Get the global config directory path for the current platform.
 */
export function getGlobalConfigDir(): string {
  const os = platform();
  if (os === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, 'showrun');
    return join(homedir(), 'AppData', 'Roaming', 'showrun');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdgConfig, 'showrun');
}

/**
 * Ensure a system prompt file exists in a config directory.
 * If the prompt was found outside config dirs (e.g. repo root), copy it
 * into the global config dir so it's available when running from any directory.
 */
export function ensureSystemPromptInConfigDir(filename: string, sourcePath: string): string {
  const configDirs = discoverConfigDirs();

  // Check if the file already exists in any config dir
  for (const dir of configDirs) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }

  // Not in any config dir — copy it to the global config dir
  const globalDir = getGlobalConfigDir();
  const destPath = join(globalDir, filename);

  ensureDir(globalDir);
  copyFileSync(sourcePath, destPath);
  console.log(`[Config] Created config directory at ${globalDir}`);
  console.log(`[Config] Copied ${filename} to ${destPath}`);

  return destPath;
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Load config, merge, and apply to process.env.
 * This is the single call sites should use (e.g. CLI bootstrap).
 */
export function initConfig(): ResolvedConfigPaths {
  const result = loadConfig();
  applyConfigToEnv(result.config);

  if (result.loadedFiles.length > 0) {
    console.log(`[Config] Loaded: ${result.loadedFiles.join(', ')}`);
  }

  return result;
}

// ── Default config template ────────────────────────────────────────────────

export const DEFAULT_CONFIG_TEMPLATE: ShowRunConfig = {
  llm: {
    provider: 'anthropic',
    anthropic: { apiKey: '', model: '', baseUrl: '' },
    openai: { apiKey: '', model: '', baseUrl: '' },
  },
  agent: {
    maxBrowserRounds: 0,
  },
  prompts: {
    teachChatSystemPrompt: '',
    autonomousExplorationPromptPath: '',
    teachModeSystemPromptPath: '',
  },
};
