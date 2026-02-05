#!/usr/bin/env node
/**
 * Copies dashboard UI assets to the dist folder for npm publishing
 */
import { cpSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
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
