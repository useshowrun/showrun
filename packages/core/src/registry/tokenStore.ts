/**
 * Persistent token storage for registry authentication.
 *
 * Tokens are stored in `auth.json` inside the global config directory
 * (`~/.config/showrun/auth.json` on Linux/macOS, `%APPDATA%\showrun\auth.json`
 * on Windows). File permissions are set to 0o600 on Unix to prevent other
 * users from reading credentials.
 */

import { existsSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { getGlobalConfigDir } from '../config.js';
import { ensureDir, atomicWrite, readJsonFile } from '../packUtils.js';
import type { StoredAuth } from './types.js';

const AUTH_FILENAME = 'auth.json';

function getAuthPath(): string {
  return join(getGlobalConfigDir(), AUTH_FILENAME);
}

export function loadTokens(): StoredAuth | null {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) return null;

  try {
    return readJsonFile<StoredAuth>(authPath);
  } catch {
    return null;
  }
}

export function saveTokens(auth: StoredAuth): void {
  const configDir = getGlobalConfigDir();
  ensureDir(configDir);

  const authPath = join(configDir, AUTH_FILENAME);
  atomicWrite(authPath, JSON.stringify(auth, null, 2) + '\n');

  // Restrict file permissions on Unix (owner-only read/write)
  if (platform() !== 'win32') {
    try {
      chmodSync(authPath, 0o600);
    } catch {
      // Ignore permission errors (e.g. on some CI environments)
    }
  }
}

export function clearTokens(): void {
  const authPath = getAuthPath();
  if (existsSync(authPath)) {
    try {
      unlinkSync(authPath);
    } catch {
      // Ignore if file is already gone
    }
  }
}
