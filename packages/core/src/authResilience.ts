/**
 * Auth resilience module: handles "run once" steps, auth failure detection, and recovery
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from 'playwright';
import type { DslStep } from './dsl/types.js';
import type { AuthPolicy, AuthGuard, Logger } from './types.js';
import type { NetworkCaptureApi } from './networkCapture.js';

const ONCE_CACHE_DIR_ENV = 'SHOWRUN_ONCE_CACHE_DIR';

function getOnceCacheDir(): string {
  const dir = process.env[ONCE_CACHE_DIR_ENV] ?? join(tmpdir(), 'showrun-once-cache');
  return dir;
}

/** Sanitize id for use in cache filename (no path separators) */
function sanitizeCacheId(id: string): string {
  return id.replace(/[/\\]/g, '-');
}

import type { NetworkEntrySerializable } from './networkCapture.js';

/**
 * Outputs produced by a step (vars, collectibles, and network entries)
 */
export interface StepOutput {
  vars: Record<string, unknown>;
  collectibles: Record<string, unknown>;
  /** Network entries referenced by this step (for network_find/network_replay caching) */
  networkEntries?: NetworkEntrySerializable[];
}

/**
 * Cache for tracking executed "once" steps per session/profile.
 * Stores step outputs (vars and collectibles) to restore them when steps are skipped.
 * Can be loaded from and persisted to disk when sessionId/profileId are provided.
 */
export class OnceCache {
  private sessionCache = new Map<string, StepOutput>();
  private profileCache = new Map<string, StepOutput>();

  /**
   * Create a cache, optionally loading from disk for the given sessionId and/or profileId.
   *
   * Storage locations:
   * - Session cache: always in temp directory (ephemeral, cleared on server restart)
   * - Profile cache: in profileCacheDir/.once-cache/profile.json if provided, else temp directory
   */
  static fromDisk(sessionId?: string, profileId?: string, profileCacheDir?: string): OnceCache {
    const defaultDir = getOnceCacheDir();
    const cache = new OnceCache();

    // Session cache always in temp directory (ephemeral)
    if (sessionId) {
      const file = join(defaultDir, `once-session-${sanitizeCacheId(sessionId)}.json`);
      if (existsSync(file)) {
        try {
          const data = readFileSync(file, 'utf-8');
          const parsed = JSON.parse(data);
          // Backward compatibility: if data is an array (old format), convert to Map with empty outputs
          if (Array.isArray(parsed)) {
            parsed.forEach((id: string) =>
              cache.sessionCache.set(id, { vars: {}, collectibles: {} })
            );
          } else if (typeof parsed === 'object' && parsed !== null) {
            // New format: object with stepId -> StepOutput
            for (const [stepId, outputs] of Object.entries(parsed)) {
              const stepOutput = outputs as StepOutput;
              cache.sessionCache.set(stepId, {
                vars: stepOutput.vars ?? {},
                collectibles: stepOutput.collectibles ?? {},
                networkEntries: stepOutput.networkEntries,
              });
            }
          }
        } catch {
          // Ignore corrupt or missing file
        }
      }
    }

    // Profile cache in pack directory if provided, else default temp dir
    if (profileId) {
      let profileFile: string;
      if (profileCacheDir) {
        const cacheSubdir = join(profileCacheDir, '.once-cache');
        profileFile = join(cacheSubdir, 'profile.json');
      } else {
        profileFile = join(defaultDir, `once-profile-${sanitizeCacheId(profileId)}.json`);
      }
      if (existsSync(profileFile)) {
        try {
          const data = readFileSync(profileFile, 'utf-8');
          const parsed = JSON.parse(data);
          // Backward compatibility: if data is an array (old format), convert to Map with empty outputs
          if (Array.isArray(parsed)) {
            parsed.forEach((id: string) =>
              cache.profileCache.set(id, { vars: {}, collectibles: {} })
            );
          } else if (typeof parsed === 'object' && parsed !== null) {
            // New format: object with stepId -> StepOutput
            for (const [stepId, outputs] of Object.entries(parsed)) {
              const stepOutput = outputs as StepOutput;
              cache.profileCache.set(stepId, {
                vars: stepOutput.vars ?? {},
                collectibles: stepOutput.collectibles ?? {},
                networkEntries: stepOutput.networkEntries,
              });
            }
          }
        } catch {
          // Ignore corrupt or missing file
        }
      }
    }
    return cache;
  }

  /**
   * Persist cache to disk for the given sessionId and/or profileId.
   *
   * Storage locations:
   * - Session cache: always in temp directory (ephemeral)
   * - Profile cache: in profileCacheDir/.once-cache/profile.json if provided, else temp directory
   */
  persist(sessionId?: string, profileId?: string, profileCacheDir?: string): void {
    const defaultDir = getOnceCacheDir();

    // Session cache always in temp directory
    if (sessionId) {
      try {
        mkdirSync(defaultDir, { recursive: true });
        const file = join(defaultDir, `once-session-${sanitizeCacheId(sessionId)}.json`);
        const cacheObj: Record<string, StepOutput> = {};
        for (const [stepId, outputs] of this.sessionCache) {
          cacheObj[stepId] = outputs;
        }
        writeFileSync(file, JSON.stringify(cacheObj, null, 2), 'utf-8');
      } catch {
        // Ignore write errors
      }
    }

    // Profile cache in pack directory if provided, else default temp dir
    if (profileId) {
      let profileFile: string;
      let profileDir: string;
      if (profileCacheDir) {
        profileDir = join(profileCacheDir, '.once-cache');
        profileFile = join(profileDir, 'profile.json');
      } else {
        profileDir = defaultDir;
        profileFile = join(defaultDir, `once-profile-${sanitizeCacheId(profileId)}.json`);
      }
      try {
        mkdirSync(profileDir, { recursive: true });
        const cacheObj: Record<string, StepOutput> = {};
        for (const [stepId, outputs] of this.profileCache) {
          cacheObj[stepId] = outputs;
        }
        writeFileSync(profileFile, JSON.stringify(cacheObj, null, 2), 'utf-8');
      } catch {
        // Ignore write errors
      }
    }
  }

  /**
   * Check if a step should be skipped (already executed)
   */
  isExecuted(stepId: string, scope: 'session' | 'profile' | undefined): boolean {
    if (!scope) return false;
    if (scope === 'session') {
      return this.sessionCache.has(stepId);
    } else {
      return this.profileCache.has(stepId);
    }
  }

  /**
   * Mark a step as executed with its outputs
   */
  markExecuted(stepId: string, scope: 'session' | 'profile', outputs: StepOutput = { vars: {}, collectibles: {} }): void {
    if (scope === 'session') {
      this.sessionCache.set(stepId, outputs);
    } else {
      this.profileCache.set(stepId, outputs);
    }
  }

  /**
   * Get cached outputs for a step
   */
  getOutputs(stepId: string, scope: 'session' | 'profile'): StepOutput | undefined {
    const cache = scope === 'session' ? this.sessionCache : this.profileCache;
    return cache.get(stepId);
  }

  /**
   * Clear cache for a specific scope
   */
  clear(scope: 'session' | 'profile'): void {
    if (scope === 'session') {
      this.sessionCache.clear();
    } else {
      this.profileCache.clear();
    }
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.sessionCache.clear();
    this.profileCache.clear();
  }
}

/**
 * Auth failure detection result
 */
export interface AuthFailure {
  url: string;
  status: number;
  stepId?: string;
}

/**
 * Auth failure monitor that watches network responses
 */
export class AuthFailureMonitor {
  private authPolicy: {
    enabled: boolean;
    statusCodes: number[];
    urlIncludes: string[];
    urlRegex?: string;
    loginUrlIncludes: string[];
    maxRecoveriesPerRun: number;
    maxStepRetryAfterRecovery: number;
    cooldownMs: number;
  };
  private failures: AuthFailure[] = [];
  private urlRegex?: RegExp;

  constructor(authPolicy: AuthPolicy) {
    this.authPolicy = {
      enabled: authPolicy.enabled ?? true,
      statusCodes: authPolicy.statusCodes ?? [401, 403],
      urlIncludes: authPolicy.urlIncludes ?? [],
      urlRegex: authPolicy.urlRegex,
      loginUrlIncludes: authPolicy.loginUrlIncludes ?? [],
      maxRecoveriesPerRun: authPolicy.maxRecoveriesPerRun ?? 1,
      maxStepRetryAfterRecovery: authPolicy.maxStepRetryAfterRecovery ?? 1,
      cooldownMs: authPolicy.cooldownMs ?? 0,
    };
    if (this.authPolicy.urlRegex) {
      this.urlRegex = new RegExp(this.authPolicy.urlRegex);
    }
  }

  /**
   * Check if auth policy is enabled
   */
  isEnabled(): boolean {
    return this.authPolicy.enabled;
  }

  /**
   * Check if a response indicates auth failure
   */
  isAuthFailure(url: string, status: number): boolean {
    if (!this.authPolicy.enabled) return false;
    if (!this.authPolicy.statusCodes.includes(status)) return false;

    // Check URL patterns if configured
    if (this.authPolicy.urlIncludes.length > 0) {
      const matches = this.authPolicy.urlIncludes.some((pattern) => url.includes(pattern));
      if (!matches) return false;
    }

    // Check URL regex if configured
    if (this.urlRegex) {
      if (!this.urlRegex.test(url)) return false;
    }

    return true;
  }

  /**
   * Record an auth failure
   */
  recordFailure(failure: AuthFailure): void {
    this.failures.push(failure);
  }

  /**
   * Get the latest auth failure
   */
  getLatestFailure(): AuthFailure | undefined {
    return this.failures[this.failures.length - 1];
  }

  /**
   * Get max recoveries allowed
   */
  getMaxRecoveries(): number {
    return this.authPolicy.maxRecoveriesPerRun;
  }

  /**
   * Get max step retries after recovery
   */
  getMaxStepRetries(): number {
    return this.authPolicy.maxStepRetryAfterRecovery;
  }

  /**
   * Get cooldown delay in ms
   */
  getCooldownMs(): number {
    return this.authPolicy.cooldownMs;
  }

  /**
   * Clear recorded failures (for testing or reset)
   */
  clearFailures(): void {
    this.failures = [];
  }

  /**
   * Clear failures for a specific step ID
   */
  clearFailuresForStep(stepId: string): void {
    this.failures = this.failures.filter((f) => f.stepId !== stepId);
  }

  /**
   * Get failures for a specific step ID
   */
  getFailuresForStep(stepId: string): AuthFailure[] {
    return this.failures.filter((f) => f.stepId === stepId);
  }
}

/**
 * Auth guard for proactive checks (OFF by default)
 */
export class AuthGuardChecker {
  private guard: AuthGuard;

  constructor(guard: AuthGuard) {
    this.guard = {
      enabled: guard.enabled ?? false,
      strategy: guard.strategy,
    };
  }

  /**
   * Check if guard is enabled
   */
  isEnabled(): boolean {
    return this.guard.enabled ?? false;
  }

  /**
   * Check auth status using configured strategy
   */
  async checkAuth(page: Page): Promise<boolean> {
    if (!this.isEnabled()) return true; // Guard disabled = assume auth is valid

    const strategy = this.guard.strategy;
    if (!strategy) return true; // No strategy = assume auth is valid

    // Check visible selector
    if (strategy.visibleSelector) {
      try {
        const element = page.locator(strategy.visibleSelector);
        const isVisible = await element.isVisible({ timeout: 5000 }).catch(() => false);
        return isVisible;
      } catch {
        return false;
      }
    }

    // Check URL pattern
    if (strategy.urlIncludes) {
      const currentUrl = page.url();
      return currentUrl.includes(strategy.urlIncludes);
    }

    return true; // Default: assume valid
  }
}

/**
 * Setup network response monitoring for browser sessions
 */
export function setupBrowserAuthMonitoring(
  page: Page,
  monitor: AuthFailureMonitor,
  logger: Logger,
  currentStepId?: string
): void {
  if (!monitor.isEnabled()) return;

  page.on('response', (response) => {
    const url = response.url();
    const status = response.status();

    if (monitor.isAuthFailure(url, status)) {
      monitor.recordFailure({ url, status, stepId: currentStepId });
      logger.log({
        type: 'auth_failure_detected',
        data: {
          url,
          status,
          stepId: currentStepId,
        },
      });
    }
  });
}

/**
 * Check if a step should be skipped due to "once" cache
 */
export function shouldSkipStep(
  step: DslStep,
  onceCache: OnceCache,
  sessionId?: string,
  profileId?: string
): boolean {
  if (!step.once) return false;

  // Determine scope: if sessionId provided, use session; otherwise use profile
  const scope = step.once === 'session' && sessionId ? 'session' : 'profile';
  return onceCache.isExecuted(step.id, scope);
}

/**
 * Get steps that should be rerun during recovery (all steps with once flag)
 */
export function getOnceSteps(steps: DslStep[]): DslStep[] {
  return steps.filter((step) => step.once !== undefined);
}
