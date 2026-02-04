import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { TaskPack, TaskPackManifest, InputSchema, CollectibleDefinition, SecretDefinition, BrowserSettings } from './types.js';
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

    // For json-dsl packs, kind must be "json-dsl" and main must be absent
    if (manifest.kind === 'json-dsl') {
      if (manifest.main) {
        throw new Error('json-dsl packs must not have a "main" field');
      }
      // flow.json will be loaded separately
      return manifest;
    }

    // For JSON-only packs (inline), flow must be present
    // For module-based packs, main must be present
    if (!manifest.flow && !manifest.main) {
      throw new Error('taskpack.json must have either "flow" (JSON-only), "kind": "json-dsl" (with flow.json), or "main" (module-based)');
    }

    return manifest;
  }

  /**
   * Load task pack from directory
   * Supports JSON-only (inline), JSON-DSL (flow.json), and module-based packs
   */
  static async loadTaskPack(packPath: string): Promise<TaskPack> {
    const manifest = this.loadManifest(packPath);

    // Style 1: JSON-DSL pack (flow.json file)
    if (manifest.kind === 'json-dsl') {
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
        inputs: flowData.inputs || manifest.inputs || {},
        collectibles: flowData.collectibles || manifest.collectibles || [],
        flow: flowData.flow,
        auth: manifest.auth,
        browser: manifest.browser,
      };
    }

    // Style 2: JSON-only pack (flow defined in manifest)
    if (manifest.flow) {
      return {
        metadata: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
        },
        inputs: manifest.inputs || {},
        collectibles: manifest.collectibles || [],
        flow: manifest.flow,
        auth: manifest.auth,
        browser: manifest.browser,
      };
    }

    // Style 3: Module-based pack
    if (!manifest.main) {
      throw new Error('taskpack.json must have either "flow" (JSON-only), "kind": "json-dsl" (with flow.json), or "main" (module-based)');
    }

    const mainPath = resolve(packPath, manifest.main);

    if (!existsSync(mainPath)) {
      throw new Error(`Task pack main file not found: ${mainPath}`);
    }

    try {
      // Use pathToFileURL for proper ES module import
      const moduleUrl = pathToFileURL(mainPath).href;
      const module = await import(moduleUrl);
      
      if (!module.default || typeof module.default !== 'object') {
        throw new Error('Task pack module must export a default object');
      }

      const taskPack = module.default as TaskPack;

      // Validate task pack structure
      if (!taskPack.metadata || !taskPack.inputs || !taskPack.collectibles) {
        throw new Error('Task pack module must export: metadata, inputs, and collectibles');
      }

      // Must have either flow or run function
      if (!taskPack.flow && typeof taskPack.run !== 'function') {
        throw new Error('Task pack module must export either a "flow" array or a "run" function');
      }

      // Ensure metadata matches manifest
      if (taskPack.metadata.id !== manifest.id || taskPack.metadata.version !== manifest.version) {
        throw new Error('Task pack metadata does not match manifest');
      }

      return taskPack;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        throw new Error(`Failed to load task pack module: ${mainPath}. Make sure the pack is built.`);
      }
      throw error;
    }
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
