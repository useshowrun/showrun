import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TaskPack, TaskPackManifest, InputSchema, CollectibleDefinition, SecretDefinition } from './types.js';
import type { DslStep } from './dsl/types.js';

/**
 * Structure of the .secrets.json file
 */
export interface SecretsFile {
  version: 1;
  secrets: Record<string, string>;
}

/**
 * Loads a Task Pack from a directory path
 *
 * Only json-dsl format is supported:
 * - taskpack.json: metadata with kind: "json-dsl"
 * - flow.json: inputs, collectibles, and flow steps
 */
export class TaskPackLoader {
  /**
   * Load task pack manifest from directory
   */
  static loadManifest(packPath: string): TaskPackManifest {
    const manifestPath = join(packPath, 'taskpack.json');

    if (!existsSync(manifestPath)) {
      throw new Error(`Task pack manifest not found: ${manifestPath}`);
    }

    let manifest: TaskPackManifest;
    try {
      const content = readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to parse taskpack.json: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Validate required fields
    if (!manifest.id || !manifest.name || !manifest.version) {
      throw new Error('taskpack.json missing required fields: id, name, version');
    }

    // Only json-dsl format is supported
    if (manifest.kind !== 'json-dsl') {
      throw new Error('taskpack.json must have "kind": "json-dsl". Other formats are no longer supported.');
    }

    return manifest;
  }

  /**
   * Load task pack from directory (json-dsl format only)
   */
  static async loadTaskPack(packPath: string): Promise<TaskPack> {
    const manifest = this.loadManifest(packPath);

    const flowPath = join(packPath, 'flow.json');
    if (!existsSync(flowPath)) {
      throw new Error(`flow.json not found for json-dsl pack: ${flowPath}`);
    }

    let flowData: {
      inputs?: InputSchema;
      collectibles?: CollectibleDefinition[];
      flow: DslStep[];
    };

    try {
      const content = readFileSync(flowPath, 'utf-8');
      flowData = JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to parse flow.json: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!flowData.flow || !Array.isArray(flowData.flow)) {
      throw new Error('flow.json must have a "flow" array');
    }

    return {
      metadata: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
      },
      inputs: flowData.inputs || {},
      collectibles: flowData.collectibles || [],
      flow: flowData.flow,
      auth: manifest.auth,
      browser: manifest.browser,
    };
  }

  /**
   * Load secrets from .secrets.json file in pack directory
   * Returns empty object if file doesn't exist
   */
  static loadSecrets(packPath: string): Record<string, string> {
    const secretsPath = join(packPath, '.secrets.json');

    if (!existsSync(secretsPath)) {
      return {};
    }

    try {
      const content = readFileSync(secretsPath, 'utf-8');
      const secretsFile = JSON.parse(content) as SecretsFile;

      // Validate version
      if (secretsFile.version !== 1) {
        console.warn(`[TaskPackLoader] Unsupported secrets file version: ${secretsFile.version}, expected 1`);
        return {};
      }

      return secretsFile.secrets || {};
    } catch (error) {
      console.warn(`[TaskPackLoader] Failed to load secrets from ${secretsPath}: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  /**
   * Get secret definitions from manifest
   */
  static getSecretDefinitions(packPath: string): SecretDefinition[] {
    try {
      const manifest = this.loadManifest(packPath);
      return manifest.secrets || [];
    } catch {
      return [];
    }
  }
}
