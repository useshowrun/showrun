/**
 * Browser data persistence management
 *
 * Handles user data directory resolution for different persistence modes:
 * - none: No persistence, browser uses ephemeral profile
 * - session: Temp directory persistence with automatic cleanup
 * - profile: Pack-local persistent profile
 */

import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrowserPersistence } from './types.js';

/**
 * Session inactivity timeout for cleanup (30 minutes in milliseconds)
 */
const SESSION_INACTIVITY_MS = 30 * 60 * 1000;

/**
 * Base directory name for session storage in temp
 */
const SESSION_BASE_DIR = 'mcpify-browser-sessions';

/**
 * Profile directory name within pack directory
 */
const PROFILE_DIR_NAME = '.browser-profile';

/**
 * Configuration for resolving browser data directory
 */
export interface BrowserDataDirConfig {
  /**
   * Persistence mode
   */
  persistence: BrowserPersistence;
  /**
   * Session ID (required for 'session' mode)
   */
  sessionId?: string;
  /**
   * Pack directory path (required for 'profile' mode)
   */
  packPath?: string;
}

/**
 * Resolves the user data directory path based on persistence configuration
 *
 * @param config - Persistence configuration
 * @returns User data directory path, or undefined for 'none' persistence
 */
export function resolveBrowserDataDir(config: BrowserDataDirConfig): string | undefined {
  const { persistence, sessionId, packPath } = config;

  switch (persistence) {
    case 'none':
      return undefined;

    case 'session': {
      if (!sessionId) {
        console.warn('[browserPersistence] Session persistence requires sessionId, falling back to none');
        return undefined;
      }
      const baseDir = join(tmpdir(), SESSION_BASE_DIR);
      ensureDir(baseDir);
      const sessionDir = join(baseDir, sanitizeSessionId(sessionId));
      ensureDir(sessionDir);
      // Touch the directory to update mtime for activity tracking
      touchDirectory(sessionDir);
      return sessionDir;
    }

    case 'profile': {
      if (!packPath) {
        console.warn('[browserPersistence] Profile persistence requires packPath, falling back to none');
        return undefined;
      }
      const profileDir = join(packPath, PROFILE_DIR_NAME);
      ensureDir(profileDir);
      return profileDir;
    }

    default:
      return undefined;
  }
}

/**
 * Cleans up inactive session directories
 *
 * Sessions that haven't been accessed in SESSION_INACTIVITY_MS are removed.
 * Should be called periodically (e.g., on dashboard startup or interval).
 */
export function cleanupInactiveSessions(): number {
  const baseDir = join(tmpdir(), SESSION_BASE_DIR);

  if (!existsSync(baseDir)) {
    return 0;
  }

  const now = Date.now();
  let cleanedCount = 0;

  try {
    const entries = readdirSync(baseDir);

    for (const entry of entries) {
      const sessionDir = join(baseDir, entry);

      try {
        const stats = statSync(sessionDir);
        if (!stats.isDirectory()) continue;

        const lastAccess = stats.mtime.getTime();
        const inactiveMs = now - lastAccess;

        if (inactiveMs > SESSION_INACTIVITY_MS) {
          rmSync(sessionDir, { recursive: true, force: true });
          cleanedCount++;
          console.log(`[browserPersistence] Cleaned up inactive session: ${entry}`);
        }
      } catch (error) {
        // Ignore errors for individual sessions (might be in use)
        console.warn(`[browserPersistence] Could not check/clean session ${entry}:`, error);
      }
    }
  } catch (error) {
    console.warn('[browserPersistence] Error during session cleanup:', error);
  }

  return cleanedCount;
}

/**
 * Gets the session base directory path (for testing/debugging)
 */
export function getSessionBaseDir(): string {
  return join(tmpdir(), SESSION_BASE_DIR);
}

/**
 * Gets the profile directory path for a pack
 */
export function getProfileDir(packPath: string): string {
  return join(packPath, PROFILE_DIR_NAME);
}

/**
 * Ensures a directory exists
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Sanitizes a session ID for use as a directory name
 */
function sanitizeSessionId(sessionId: string): string {
  // Replace unsafe characters with underscores
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Touches a directory to update its mtime
 */
function touchDirectory(dir: string): void {
  try {
    const now = new Date();
    // Node doesn't have a direct utimes for directories, but we can use a marker file
    const markerPath = join(dir, '.last_access');
    const fs = require('fs');
    fs.closeSync(fs.openSync(markerPath, 'w'));
    fs.utimesSync(dir, now, now);
  } catch {
    // Ignore errors - touch is best-effort for cleanup tracking
  }
}
