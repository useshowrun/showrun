import { readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { TaskPackLoader } from '@showrun/core';
import type { TaskPack } from '@showrun/core';

/**
 * Options for pack discovery
 */
export interface PackDiscoveryOptions {
  /**
   * List of directories to search for task packs
   */
  directories: string[];
  /**
   * Whether to search nested directories (one level deep)
   */
  nested?: boolean;
}

/**
 * Result of pack discovery
 */
export interface DiscoveredPack {
  /**
   * The task pack instance
   */
  pack: TaskPack;
  /**
   * Path to the pack directory
   */
  path: string;
  /**
   * MCP-safe tool name derived from pack ID
   */
  toolName: string;
}

/**
 * Converts a task pack ID to an MCP-safe tool name
 * Replaces non [a-zA-Z0-9._-] characters with underscores
 */
export function packIdToToolName(packId: string): string {
  return packId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Discovers task packs from directories
 */
export async function discoverPacks(
  options: PackDiscoveryOptions
): Promise<DiscoveredPack[]> {
  const { directories, nested = true } = options;
  const discovered: DiscoveredPack[] = [];
  const toolNameMap = new Map<string, DiscoveredPack>();

  for (const dir of directories) {
    const resolvedDir = resolve(dir);
    
    if (!existsSync(resolvedDir)) {
      console.warn(`Warning: Directory does not exist: ${resolvedDir}`);
      continue;
    }

    try {
      const entries = readdirSync(resolvedDir, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = join(resolvedDir, entry.name);
        
        if (entry.isDirectory()) {
          // Check if this directory contains a taskpack.json
          const manifestPath = join(entryPath, 'taskpack.json');
          
          if (existsSync(manifestPath)) {
            try {
              const pack = await TaskPackLoader.loadTaskPack(entryPath);
              const toolName = packIdToToolName(pack.metadata.id);

              // Check for tool name collision
              if (toolNameMap.has(toolName)) {
                const existing = toolNameMap.get(toolName)!;
                console.warn(
                  `Warning: Tool name collision detected. Pack "${pack.metadata.id}" ` +
                  `(${entryPath}) maps to tool name "${toolName}" which is already ` +
                  `used by pack "${existing.pack.metadata.id}" (${existing.path}). ` +
                  `Skipping the later pack.`
                );
                continue;
              }

              const discoveredPack: DiscoveredPack = {
                pack,
                path: entryPath,
                toolName,
              };

              discovered.push(discoveredPack);
              toolNameMap.set(toolName, discoveredPack);
            } catch (error) {
              console.warn(
                `Warning: Failed to load task pack from ${entryPath}: ` +
                `${error instanceof Error ? error.message : String(error)}`
              );
            }
          } else if (nested) {
            // Check nested directories (one level deep)
            try {
              const nestedEntries = readdirSync(entryPath, { withFileTypes: true });
              
              for (const nestedEntry of nestedEntries) {
                if (nestedEntry.isDirectory()) {
                  const nestedPath = join(entryPath, nestedEntry.name);
                  const nestedManifestPath = join(nestedPath, 'taskpack.json');
                  
                  if (existsSync(nestedManifestPath)) {
                    try {
                      const pack = await TaskPackLoader.loadTaskPack(nestedPath);
                      const toolName = packIdToToolName(pack.metadata.id);

                      // Check for tool name collision
                      if (toolNameMap.has(toolName)) {
                        const existing = toolNameMap.get(toolName)!;
                        console.warn(
                          `Warning: Tool name collision detected. Pack "${pack.metadata.id}" ` +
                          `(${nestedPath}) maps to tool name "${toolName}" which is already ` +
                          `used by pack "${existing.pack.metadata.id}" (${existing.path}). ` +
                          `Skipping the later pack.`
                        );
                        continue;
                      }

                      const discoveredPack: DiscoveredPack = {
                        pack,
                        path: nestedPath,
                        toolName,
                      };

                      discovered.push(discoveredPack);
                      toolNameMap.set(toolName, discoveredPack);
                    } catch (error) {
                      console.warn(
                        `Warning: Failed to load nested task pack from ${nestedPath}: ` +
                        `${error instanceof Error ? error.message : String(error)}`
                      );
                    }
                  }
                }
              }
            } catch (error) {
              // Ignore errors reading nested directories
            }
          }
        }
      }
    } catch (error) {
      console.warn(
        `Warning: Failed to read directory ${resolvedDir}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return discovered;
}
