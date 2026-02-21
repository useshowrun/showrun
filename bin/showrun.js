#!/usr/bin/env node
/**
 * Bootstrap script for running showrun.
 *
 * When the CLI bundle hasn't been built yet, this script automatically
 * ensures pnpm is available, runs `pnpm install && pnpm build`, then
 * forwards to the real CLI at packages/showrun/dist/cli.js.
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cliPath = resolve(root, 'packages/showrun/dist/cli.js');

if (!existsSync(cliPath)) {
  // Check if source tree is present (workspace packages exist)
  const hasSource = existsSync(resolve(root, 'packages/showrun/src/cli.ts'));

  if (!hasSource) {
    console.error('Error: ShowRun CLI not built and source not found.');
    console.error('');
    console.error('Install from npm:');
    console.error('  npm install -g showrun');
    console.error('');
    console.error('Or clone from GitHub:');
    console.error('  git clone https://github.com/useshowrun/showrun');
    console.error('  cd showrun && pnpm install && pnpm build');
    process.exit(1);
  }

  console.log('[showrun] CLI not built — building now...');

  // Ensure pnpm is available
  try {
    execSync('pnpm --version', { stdio: 'ignore' });
  } catch {
    console.log('[showrun] pnpm not found, installing via corepack...');
    try {
      execSync('corepack enable pnpm', { cwd: root, stdio: 'inherit' });
    } catch {
      console.log('[showrun] corepack failed, trying npm install -g pnpm...');
      try {
        execSync('npm install -g pnpm', { cwd: root, stdio: 'inherit' });
      } catch {
        console.error('[showrun] Could not install pnpm. Please install it manually:');
        console.error('  npm install -g pnpm');
        process.exit(1);
      }
    }
  }

  // Build
  try {
    execSync('pnpm install && pnpm build', { cwd: root, stdio: 'inherit' });
  } catch {
    console.error('[showrun] Build failed. Please run manually:');
    console.error('  cd ' + root);
    console.error('  pnpm install && pnpm build');
    process.exit(1);
  }

  // Verify the build produced the CLI
  if (!existsSync(cliPath)) {
    console.error('[showrun] Build completed but CLI not found at ' + cliPath);
    process.exit(1);
  }

  console.log('[showrun] Build complete.');
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
