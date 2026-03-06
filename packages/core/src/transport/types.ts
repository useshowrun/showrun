/**
 * Swappable replay transport for network_replay steps.
 * Follows the same pluggable-provider pattern as proxy/ module.
 */

/**
 * Available replay transport implementations.
 * - 'playwright': Uses Playwright's page.request.fetch() (default)
 * - 'impit': Uses impit for browser-grade TLS fingerprinting
 */
export type ReplayTransportName = 'playwright' | 'impit';

/**
 * Transport configuration stored in taskpack.json under `browser.replayTransport`.
 */
export interface ReplayTransportConfig {
  /** Transport to use for network_replay. Default: 'playwright' */
  transport?: ReplayTransportName;
  /** Impit-specific options (only used when transport is 'impit') */
  impit?: {
    /** Browser TLS fingerprint to emulate (default: 'firefox') */
    browser?: 'firefox' | 'chrome';
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
  };
}

/**
 * Fully resolved request ready for transport execution.
 * Built by networkCapture.replay() after applying all overrides.
 */
export interface ReplayRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Response returned by a replay transport.
 */
export interface ReplayResponse {
  status: number;
  contentType?: string;
  body: string;
  bodySize: number;
}

/**
 * Interface for pluggable replay transports.
 * Implement this to add support for a new HTTP client.
 */
export interface ReplayTransport {
  /** Transport name for logging/diagnostics */
  readonly name: ReplayTransportName;

  /** Execute a fully-resolved HTTP request and return the response */
  execute(request: ReplayRequest): Promise<ReplayResponse>;

  /** Optional cleanup when the transport is no longer needed */
  dispose?(): void;
}
