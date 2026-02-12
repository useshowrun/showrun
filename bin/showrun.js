#!/usr/bin/env node
/**
 * Bootstrap script for running showrun from a git clone.
 *
 * When the CLI bundle hasn't been built yet, this script automatically
 * runs `pnpm install && pnpm build` before forwarding to the real CLI.
 * Published npm releases use packages/showrun/dist/cli.js directly.
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cliPath = resolve(root, 'packages/showrun/dist/cli.js');

if (!existsSync(cliPath)) {
  // Detect dev environment: pnpm-workspace.yaml exists at repo root
  const isDevRepo = existsSync(resolve(root, 'pnpm-workspace.yaml'));

  if (isDevRepo) {
    console.log('[showrun] CLI not built — running pnpm install && pnpm build ...');
    try {
      execSync('pnpm install && pnpm build', { cwd: root, stdio: 'inherit' });
    } catch {
      console.error('[showrun] Build failed. Please run manually:');
      console.error('  cd ' + root);
      console.error('  pnpm install && pnpm build');
      process.exit(1);
    }
  } else {
    console.error('Error: ShowRun CLI not built.');
    console.error('');
    console.error('For GitHub usage, you need to build first:');
    console.error('  git clone https://github.com/useshowrun/showrun');
    console.error('  cd showrun');
    console.error('  pnpm install');
    console.error('  pnpm build');
    console.error('  node packages/showrun/dist/cli.js dashboard');
    console.error('');
    console.error('For easier usage, install from npm:');
    console.error('  npx showrun dashboard');
    process.exit(1);
  }
}

// Forward to the actual CLI
const args = process.argv.slice(2);
const child = spawn('node', [cliPath, ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
