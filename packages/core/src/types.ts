import type { Browser, Page } from 'playwright';
import type { DslStep } from './dsl/types.js';
import type { NetworkCaptureApi } from './networkCapture.js';

/**
 * Primitive types supported in input/collectible schemas
 */
export type PrimitiveType = 'string' | 'number' | 'boolean';

/**
 * Secret definition for task pack secrets
 */
export interface SecretDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

/**
 * Browser engine options
 */
export type BrowserEngine = 'chromium' | 'camoufox';

/**
 * Browser persistence mode
 * - 'none': Ephemeral, no data persisted (default)
 * - 'session': Data persisted in temp directory, cleared after 30min inactivity
 * - 'profile': Data persisted in pack directory, permanent
 */
export type BrowserPersistence = 'none' | 'session' | 'profile';

/**
 * Browser configuration for task packs
 */
export interface BrowserSettings {
  /**
   * Browser engine to use (default: 'camoufox')
   */
  engine?: BrowserEngine;
  /**
   * Persistence mode for browser data (cookies, localStorage, etc.)
   * - 'none': Fresh browser each run (default)
   * - 'session': Persist in temp dir, cleared after inactivity
   * - 'profile': Persist in pack's .browser-profile/ directory
   */
  persistence?: BrowserPersistence;
}

/**
 * Field definition in a schema
 */
export interface FieldDefinition {
  type: PrimitiveType;
  required?: boolean;
  description?: string;
  /** Default value for this field when not provided */
  default?: unknown;
}

/**
 * Input schema definition
 */
export type InputSchema = Record<string, FieldDefinition>;

/**
 * Collectible definition
 */
export interface CollectibleDefinition {
  name: string;
  type: PrimitiveType;
  description?: string;
}

/**
 * Task Pack metadata
 */
export interface TaskPackMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
}

/**
 * Task Pack manifest (taskpack.json)
 *
 * Only json-dsl format is supported:
 * - taskpack.json: metadata with kind: "json-dsl"
 * - flow.json: inputs, collectibles, and flow steps
 */
export interface TaskPackManifest extends TaskPackMetadata {
  /**
   * Pack kind: must be "json-dsl"
   */
  kind: 'json-dsl';
  /**
   * Auth configuration for resilience and recovery
   */
  auth?: AuthConfig;
  /**
   * Secret definitions (names and descriptions for secrets stored in .secrets.json)
   */
  secrets?: SecretDefinition[];
  /**
   * Browser configuration
   */
  browser?: BrowserSettings;
}

/**
 * Run context provided to task pack execution
 */
export interface RunContext {
  page: Page;
  browser: Browser;
  logger: Logger;
  artifacts: ArtifactManager;
  /** Present when flow runs with network capture (e.g. runner); required for network_find/network_replay */
  networkCapture?: NetworkCaptureApi;
}

/**
 * Run result returned by task pack
 */
export interface RunResult {
  collectibles: Record<string, unknown>;
  meta: {
    url?: string;
    durationMs: number;
    notes?: string;
  };
  /**
   * Diagnostic hints from JSONPath operations (e.g., unsupported syntax, empty results).
   * These help AI agents understand why data extraction may have failed.
   */
  _hints?: string[];
}

/**
 * Logger interface for structured logging
 */
export interface Logger {
  log(event: LogEvent): void;
}

/**
 * Auth policy configuration for reactive auth failure detection and recovery
 */
export interface AuthPolicy {
  /**
   * Enable auth failure detection and recovery (default: true)
   */
  enabled?: boolean;
  /**
   * HTTP status codes that indicate auth failure (default: [401, 403])
   */
  statusCodes?: number[];
  /**
   * URL patterns (substring match) that trigger auth failure detection
   * If provided, only responses matching these patterns will trigger recovery
   */
  urlIncludes?: string[];
  /**
   * URL regex patterns for auth failure detection
   * If provided, only responses matching these patterns will trigger recovery
   */
  urlRegex?: string;
  /**
   * Optional: URL patterns that indicate login page (for navigation-based detection)
   */
  loginUrlIncludes?: string[];
  /**
   * Maximum number of recovery attempts per run (default: 1)
   */
  maxRecoveriesPerRun?: number;
  /**
   * Maximum number of times to retry a failed step after recovery (default: 1)
   */
  maxStepRetryAfterRecovery?: number;
  /**
   * Cooldown delay in milliseconds before retrying after recovery (default: 0)
   */
  cooldownMs?: number;
}

/**
 * Auth guard configuration for proactive auth checks (OFF by default)
 */
export interface AuthGuard {
  /**
   * Enable auth guard (default: false)
   */
  enabled?: boolean;
  /**
   * Guard strategy: check for visible selector or URL pattern
   */
  strategy?: {
    /**
     * Assert that a selector is visible (preferred, no extra navigation)
     */
    visibleSelector?: string;
    /**
     * OR check URL pattern after initial navigation (if already on a page)
     */
    urlIncludes?: string;
  };
}

/**
 * Auth configuration for task packs
 */
export interface AuthConfig {
  /**
   * Auth policy for reactive failure detection and recovery
   */
  authPolicy?: AuthPolicy;
  /**
   * Auth guard for proactive checks (OFF by default)
   */
  authGuard?: AuthGuard;
}

/**
 * Log event types
 */
export type LogEvent =
  | { type: 'run_started'; data: { packId: string; packVersion: string; inputs: unknown } }
  | { type: 'step_started'; data: { stepId: string; type: string; label?: string; params?: unknown } }
  | { type: 'step_finished'; data: { stepId: string; type: string; label?: string; durationMs: number } }
  | { type: 'step_skipped'; data: { stepId: string; type: string; reason: 'once_already_executed' | 'condition_met'; restoredVars?: string[]; restoredCollectibles?: string[]; condition?: string } }
  | { type: 'auth_failure_detected'; data: { url: string; status: number; stepId?: string } }
  | { type: 'auth_recovery_started'; data: { recoveryAttempt: number; maxRecoveries: number } }
  | { type: 'auth_recovery_finished'; data: { recoveryAttempt: number; success: boolean } }
  | { type: 'auth_recovery_exhausted'; data: { url: string; status: number; maxRecoveries: number } }
  | { type: 'run_finished'; data: { success: boolean; durationMs: number } }
  | { type: 'error'; data: { error: string; stepId?: string; type?: string; label?: string } };

/**
 * Artifact manager for saving screenshots and HTML snapshots
 */
export interface ArtifactManager {
  saveScreenshot(name: string): Promise<string>;
  saveHTML(name: string, html: string): Promise<string>;
}

/**
 * Task Pack module interface
 * 
 * Supports two execution styles:
 * - Declarative: provide `flow` array of DSL steps
 * - Imperative: provide `run` function
 * 
 * If both are provided, `flow` takes precedence.
 */
export interface TaskPack {
  metadata: TaskPackMetadata;
  inputs: InputSchema;
  collectibles: CollectibleDefinition[];
  /**
   * Declarative flow of DSL steps
   */
  flow: DslStep[];
  /**
   * Auth configuration for resilience and recovery
   */
  auth?: AuthConfig;
  /**
   * Browser configuration
   */
  browser?: BrowserSettings;
}
