import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TaskPack, TaskPackManifest, InputSchema, CollectibleDefinition, SecretDefinition } from './types.js';
import type { DslStep } from './dsl/types.js';
import { loadSnapshots } from './requestSnapshot.js';
import { parse as parseShowScript } from '@showrun/showscript';
import type { TypeSpec, InputsBlock, OutputsBlock } from '@showrun/showscript';

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
 * Supported formats:
 * - json-dsl: taskpack.json + flow.json (inputs, collectibles, flow steps)
 * - showscript: taskpack.json + flow.showscript (ShowScript DSL)
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

    // Validate kind
    if (manifest.kind !== 'json-dsl' && manifest.kind !== 'showscript') {
      throw new Error('taskpack.json "kind" must be "json-dsl" or "showscript".');
    }

    return manifest;
  }

  /**
   * Load task pack from directory
   */
  static async loadTaskPack(packPath: string): Promise<TaskPack> {
    const manifest = this.loadManifest(packPath);

    if (manifest.kind === 'showscript') {
      return this.loadShowScriptPack(packPath, manifest);
    }

    return this.loadJsonDslPack(packPath, manifest);
  }

  /**
   * Load a json-dsl task pack
   */
  private static loadJsonDslPack(packPath: string, manifest: TaskPackManifest): TaskPack {
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

    // Optionally load snapshots.json (not an error if missing)
    const snapshots = loadSnapshots(packPath);

    return {
      metadata: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
      },
      kind: 'json-dsl',
      inputs: flowData.inputs || {},
      collectibles: flowData.collectibles || [],
      flow: flowData.flow,
      auth: manifest.auth,
      browser: manifest.browser,
      ...(snapshots ? { snapshots } : {}),
    };
  }

  /**
   * Load a showscript task pack
   */
  private static loadShowScriptPack(packPath: string, manifest: TaskPackManifest): TaskPack {
    const scriptPath = join(packPath, 'flow.showscript');
    if (!existsSync(scriptPath)) {
      throw new Error(`flow.showscript not found for showscript pack: ${scriptPath}`);
    }

    let source: string;
    try {
      source = readFileSync(scriptPath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read flow.showscript: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Parse ShowScript to extract inputs and outputs
    const inputs = this.parseShowScriptInputs(source);
    const collectibles = this.parseShowScriptOutputs(source);

    return {
      metadata: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
      },
      kind: 'showscript',
      inputs,
      collectibles,
      flow: [], // empty — showscript packs don't use DSL steps
      showscriptSource: source,
      auth: manifest.auth,
      browser: manifest.browser,
    };
  }

  /**
   * Convert ShowScript TypeSpec to JSON-DSL PrimitiveType
   */
  private static showScriptTypeToJsonDslType(typeSpec: TypeSpec): 'string' | 'number' | 'boolean' {
    switch (typeSpec) {
      case 'number':
        return 'number';
      case 'bool':
        return 'boolean';
      case 'string':
      case 'secret':
      case 'array':
      case 'object':
      default:
        return 'string';
    }
  }

  /**
   * Convert ShowScript TypeSpec to CollectibleDefinition type
   */
  private static showScriptTypeToPrimitiveType(typeSpec: TypeSpec): 'string' | 'number' | 'boolean' {
    switch (typeSpec) {
      case 'number':
        return 'number';
      case 'bool':
        return 'boolean';
      case 'string':
      case 'secret':
      case 'array':
      case 'object':
      default:
        return 'string';
    }
  }

  /**
   * Parse inputs from ShowScript source and convert to InputSchema format
   */
  private static parseShowScriptInputs(source: string): InputSchema {
    const ast = parseShowScript(source);
    const inputsBlock = ast.blocks.find((b): b is InputsBlock => b.type === 'InputsBlock');

    if (!inputsBlock) {
      return {};
    }

    const inputs: InputSchema = {};

    for (const decl of inputsBlock.declarations) {
      const entry: InputSchema[string] = {
        type: this.showScriptTypeToJsonDslType(decl.typeSpec),
      };

      // Required if no default value
      entry.required = !decl.defaultValue;

      // Extract default value if present
      if (decl.defaultValue) {
        switch (decl.defaultValue.type) {
          case 'StringLiteral':
            entry.default = decl.defaultValue.value;
            break;
          case 'NumberLiteral':
            entry.default = decl.defaultValue.value;
            break;
          case 'BooleanLiteral':
            entry.default = decl.defaultValue.value;
            break;
          case 'NullLiteral':
            entry.default = null;
            break;
          case 'ArrayLiteral':
            entry.default = [];
            break;
          case 'ObjectLiteral':
            entry.default = {};
            break;
        }
      }

      inputs[decl.name] = entry;
    }

    return inputs;
  }

  /**
   * Parse outputs from ShowScript source and convert to CollectibleDefinition[] format
   */
  private static parseShowScriptOutputs(source: string): CollectibleDefinition[] {
    const ast = parseShowScript(source);
    const outputsBlock = ast.blocks.find((b): b is OutputsBlock => b.type === 'OutputsBlock');

    if (!outputsBlock) {
      return [];
    }

    return outputsBlock.declarations.map(decl => ({
      name: decl.name,
      type: this.showScriptTypeToPrimitiveType(decl.typeSpec),
    }));
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
