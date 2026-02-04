/**
 * Secrets utilities for task pack secrets management
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import type { SecretDefinition, TaskPackManifest } from '@mcpify/core';
import { TaskPackLoader, type SecretsFile } from '@mcpify/core';

/**
 * Information about a secret (no actual value exposed)
 */
export interface SecretInfo {
  name: string;
  description?: string;
  required?: boolean;
  hasValue: boolean;
  preview?: string; // First 2 chars + asterisks
}

/**
 * Get preview string for a secret value (first 2 chars + asterisks)
 */
function getSecretPreview(value: string): string {
  if (!value || value.length <= 2) {
    return '**'; // Don't reveal short secrets
  }
  return value.slice(0, 2) + '*'.repeat(Math.min(value.length - 2, 6));
}

/**
 * Load secrets file from pack directory
 */
function loadSecretsFile(packPath: string): SecretsFile {
  const secretsPath = join(packPath, '.secrets.json');

  if (!existsSync(secretsPath)) {
    return { version: 1, secrets: {} };
  }

  try {
    const content = readFileSync(secretsPath, 'utf-8');
    const data = JSON.parse(content) as SecretsFile;
    return data.version === 1 ? data : { version: 1, secrets: {} };
  } catch {
    return { version: 1, secrets: {} };
  }
}

/**
 * Write secrets file atomically
 */
function writeSecretsFile(packPath: string, secretsFile: SecretsFile): void {
  const secretsPath = join(packPath, '.secrets.json');
  const tempPath = `${secretsPath}.tmp`;

  try {
    const content = JSON.stringify(secretsFile, null, 2) + '\n';
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, secretsPath);
  } catch (error) {
    // Cleanup temp file if rename failed
    try {
      if (existsSync(tempPath)) {
        renameSync(tempPath, secretsPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Get secret names with their values status (no actual values returned)
 */
export function getSecretNamesWithValues(packPath: string): SecretInfo[] {
  // Get definitions from manifest
  const definitions = TaskPackLoader.getSecretDefinitions(packPath);

  // Get actual values
  const secretsFile = loadSecretsFile(packPath);
  const secretValues = secretsFile.secrets || {};

  // Build info list
  const result: SecretInfo[] = [];

  // First add all defined secrets
  for (const def of definitions) {
    const value = secretValues[def.name];
    result.push({
      name: def.name,
      description: def.description,
      required: def.required,
      hasValue: !!value,
      preview: value ? getSecretPreview(value) : undefined,
    });
  }

  // Add any secrets that exist but aren't defined (orphaned)
  for (const name of Object.keys(secretValues)) {
    if (!definitions.find((d) => d.name === name)) {
      const value = secretValues[name];
      result.push({
        name,
        description: undefined,
        required: undefined,
        hasValue: !!value,
        preview: value ? getSecretPreview(value) : undefined,
      });
    }
  }

  return result;
}

/**
 * Set a secret value
 */
export function setSecretValue(packPath: string, name: string, value: string): void {
  const secretsFile = loadSecretsFile(packPath);
  secretsFile.secrets[name] = value;
  writeSecretsFile(packPath, secretsFile);
}

/**
 * Delete a secret value
 */
export function deleteSecretValue(packPath: string, name: string): void {
  const secretsFile = loadSecretsFile(packPath);
  delete secretsFile.secrets[name];
  writeSecretsFile(packPath, secretsFile);
}

/**
 * Update secret definitions in manifest
 */
export function updateSecretDefinitions(packPath: string, definitions: SecretDefinition[]): void {
  const manifestPath = join(packPath, 'taskpack.json');

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as TaskPackManifest;

    // Update secrets array
    manifest.secrets = definitions;

    // Write atomically
    const tempPath = `${manifestPath}.tmp`;
    const newContent = JSON.stringify(manifest, null, 2) + '\n';
    writeFileSync(tempPath, newContent, 'utf-8');
    renameSync(tempPath, manifestPath);
  } catch (error) {
    throw new Error(`Failed to update manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}
