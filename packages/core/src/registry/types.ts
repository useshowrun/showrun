/**
 * Registry API types — mirrors @showrun-registry/shared without taking a dependency.
 */

// ── Auth ──────────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  displayName?: string;
}

/** Response from POST /api/auth/device — starts device authorization flow */
export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Successful response from POST /api/auth/device/token after user approves */
export interface DeviceTokenResponse {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
}

/**
 * Result of polling the device token endpoint.
 * `status` is 'pending' while the user hasn't approved yet,
 * 'complete' with tokens on success, or 'expired' if the code timed out.
 */
export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'complete'; accessToken: string; refreshToken: string; user: UserProfile };

export interface RegistryRefreshResponse {
  accessToken: string;
}

// ── Token storage ─────────────────────────────────────────────────────────

export interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
  registryUrl: string;
  /** ISO timestamp when auth was saved */
  savedAt: string;
}

// ── Packs ─────────────────────────────────────────────────────────────────

export interface PackSummary {
  id: string;
  slug: string;
  name: string;
  description?: string;
  visibility: 'public' | 'private';
  latestVersion?: string;
  owner: { id: string; username: string };
  createdAt: string;
  updatedAt: string;
}

export interface PackVersionSummary {
  version: string;
  changelog?: string;
  createdAt: string;
}

export interface PackDetail extends PackSummary {
  versions: PackVersionSummary[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ── Publish ───────────────────────────────────────────────────────────────

export interface PublishParams {
  /** Local pack directory path */
  packPath: string;
  /** Registry slug (defaults to pack ID) */
  slug?: string;
  /** Visibility: public or private */
  visibility?: 'public' | 'private';
  /** Changelog for this version */
  changelog?: string;
}

export interface PublishResult {
  slug: string;
  version: string;
  created: boolean;
  warnings: string[];
}

// ── Search ────────────────────────────────────────────────────────────────

export interface SearchQuery {
  q?: string;
  page?: number;
  limit?: number;
}

// ── Client interface ──────────────────────────────────────────────────────

export interface IRegistryClient {
  startDeviceLogin(): Promise<DeviceCodeResponse>;
  pollDeviceLogin(deviceCode: string): Promise<DevicePollResult>;
  logout(): Promise<void>;
  whoami(): Promise<UserProfile>;
  isAuthenticated(): boolean;
  publishPack(params: PublishParams): Promise<PublishResult>;
  searchPacks(query: SearchQuery): Promise<PaginatedResponse<PackSummary>>;
  installPack(slug: string, destDir: string, version?: string): Promise<void>;
}
