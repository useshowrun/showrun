#!/usr/bin/env node
/**
 * Copies dashboard UI assets to the dist folder for npm publishing
 */
import { cpSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs';
import { resolve, dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const dashboardUi = resolve(root, '../dashboard/dist/ui');
const targetDir = resolve(root, 'dist/ui');

if (!existsSync(dashboardUi)) {
  console.error('Dashboard UI not found. Run "pnpm build" in packages/dashboard first.');
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
cpSync(dashboardUi, targetDir, { recursive: true });

console.log('Copied dashboard UI assets to dist/ui');

// Copy example-json taskpack template for first-run seeding
const exampleJson = resolve(root, '../../taskpacks/example-json');
const templatesDir = resolve(root, 'dist/templates/example-json');

if (existsSync(exampleJson)) {
  mkdirSync(templatesDir, { recursive: true });
  // Copy only essential pack files, skip databases and runtime artifacts
  const skipExts = new Set(['.db', '.db-shm', '.db-wal']);
  const skipDirs = new Set(['runs', 'node_modules', '.versions']);
  for (const entry of readdirSync(exampleJson, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    if (entry.isFile() && skipExts.has(extname(entry.name))) continue;
    const src = join(exampleJson, entry.name);
    const dest = join(templatesDir, entry.name);
    if (entry.isDirectory()) {
      cpSync(src, dest, { recursive: true });
    } else {
      copyFileSync(src, dest);
    }
  }
  console.log('Copied example-json template to dist/templates/example-json');
} else {
  console.warn('Warning: taskpacks/example-json not found, skipping template copy');
}
