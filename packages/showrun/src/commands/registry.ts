/**
 * showrun registry <subcommand> - Registry commands for publishing and installing packs
 *
 * Authentication uses the OAuth Device Authorization Grant (RFC 8628):
 *   1. CLI requests a device code from the registry
 *   2. User opens a URL in the browser and enters a short code
 *   3. CLI polls until the user approves, then receives tokens
 *   4. The CLI never sees the user's password
 */

import { resolve } from 'path';
import { existsSync } from 'fs';
import { cwd, platform } from 'process';
import { execSync } from 'child_process';
import { RegistryClient, RegistryError, type ReportReason } from '@showrun/core';

// ── Arg parsing helpers ───────────────────────────────────────────────────

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith('--')) return undefined;
  return next;
}

function getPositional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('--'));
}

// ── Browser open helper ──────────────────────────────────────────────────

function tryOpenBrowser(url: string): void {
  try {
    const cmd =
      platform === 'darwin' ? 'open'
      : platform === 'win32' ? 'start'
      : 'xdg-open';
    execSync(`${cmd} ${JSON.stringify(url)}`, { stdio: 'ignore' });
  } catch {
    // Silently fail — user can open the URL manually
  }
}

// ── Sleep helper ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Subcommands ───────────────────────────────────────────────────────────

async function cmdLogin(_args: string[]): Promise<void> {
  const client = new RegistryClient();

  // Step 1: Request device code
  const device = await client.startDeviceLogin();

  // Step 2: Show code and URL to user
  console.log();
  console.log(`  Open this URL in your browser:`);
  console.log();
  console.log(`    ${device.verificationUri}`);
  console.log();
  console.log(`  Then enter this code: ${device.userCode}`);
  console.log();

  // Try to open the browser automatically
  tryOpenBrowser(device.verificationUri);

  console.log('Waiting for authorization...');

  // Step 3: Poll until user approves or code expires
  const deadline = Date.now() + device.expiresIn * 1000;
  const interval = Math.max(device.interval, 5) * 1000; // minimum 5s as per RFC

  while (Date.now() < deadline) {
    await sleep(interval);

    const result = await client.pollDeviceLogin(device.deviceCode);

    if (result.status === 'complete') {
      const name = result.user.displayName || result.user.username;
      console.log(`Logged in as ${name} (${result.user.email})`);
      return;
    }

    if (result.status === 'expired') {
      throw new Error('Device code expired. Please run `showrun registry login` again.');
    }

    // status === 'pending' — keep polling
  }

  throw new Error('Login timed out. Please run `showrun registry login` again.');
}

async function cmdLogout(_args: string[]): Promise<void> {
  const client = new RegistryClient();
  await client.logout();
  console.log('Logged out. Auth tokens removed.');
}

async function cmdWhoami(_args: string[]): Promise<void> {
  const client = new RegistryClient();
  if (!client.isAuthenticated()) {
    console.log('Not logged in. Run `showrun registry login` to authenticate.');
    return;
  }

  const user = await client.whoami();
  console.log(`Username:     ${user.username}`);
  console.log(`Email:        ${user.email}`);
  if (user.displayName) {
    console.log(`Display name: ${user.displayName}`);
  }
}

async function cmdPublish(args: string[]): Promise<void> {
  const client = new RegistryClient();

  const packPath = getFlag(args, '--path');
  if (!packPath) throw new Error('--path is required');

  const resolvedPath = resolve(cwd(), packPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Pack directory not found: ${resolvedPath}`);
  }

  const slug = getFlag(args, '--slug');
  const visibility = getFlag(args, '--visibility') as 'public' | 'private' | undefined;
  const changelog = getFlag(args, '--changelog');

  console.log(`Publishing pack from ${resolvedPath}...`);
  const result = await client.publishPack({
    packPath: resolvedPath,
    slug,
    visibility,
    changelog,
  });

  if (result.created) {
    console.log(`Created new pack: ${result.slug}`);
  }
  console.log(`Published ${result.slug}@${result.version}`);
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`  Warning: ${w}`);
    }
  }
}

async function cmdSearch(args: string[]): Promise<void> {
  const client = new RegistryClient();

  const q = getPositional(args);
  const page = getFlag(args, '--page');
  const limit = getFlag(args, '--limit');

  const result = await client.searchPacks({
    q,
    page: page ? parseInt(page, 10) : undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
  });

  if (result.data.length === 0) {
    console.log('No packs found.');
    return;
  }

  console.log(`Found ${result.total} pack(s) (page ${result.page}/${result.totalPages}):\n`);

  for (const pack of result.data) {
    const vis = pack.visibility === 'private' ? ' [private]' : '';
    const ver = pack.latestVersion ? ` v${pack.latestVersion}` : '';
    console.log(`  ${pack.slug}${ver}${vis}`);
    console.log(`    ${pack.description || 'No description'}`);
    console.log(`    by ${pack.owner.username}`);
    console.log();
  }
}

async function cmdInstall(args: string[]): Promise<void> {
  const client = new RegistryClient();

  const slug = getPositional(args);
  if (!slug) throw new Error('Pack slug is required. Usage: showrun registry install <slug>');

  const destDir = getFlag(args, '--dir') || resolve(cwd(), 'taskpacks');
  const version = getFlag(args, '--version');

  const resolvedDest = resolve(cwd(), destDir);
  console.log(`Installing ${slug}${version ? `@${version}` : ''} to ${resolvedDest}...`);

  await client.installPack(slug, resolvedDest, version);
  console.log(`Installed ${slug} to ${resolve(resolvedDest, slug)}`);
}

const VALID_REPORT_REASONS = ['malicious', 'spam', 'inappropriate', 'copyright'] as const;

async function cmdReport(args: string[]): Promise<void> {
  const client = new RegistryClient();

  const slug = getPositional(args);
  if (!slug) {
    throw new Error('Pack slug is required. Usage: showrun registry report <slug> --reason <reason>');
  }

  const reason = getFlag(args, '--reason') as ReportReason | undefined;
  if (!reason) {
    throw new Error(
      `--reason is required. Valid reasons: ${VALID_REPORT_REASONS.join(', ')}`,
    );
  }
  if (!VALID_REPORT_REASONS.includes(reason)) {
    throw new Error(
      `Invalid reason "${reason}". Valid reasons: ${VALID_REPORT_REASONS.join(', ')}`,
    );
  }

  const description = getFlag(args, '--description');

  await client.reportPack({ slug, reason, description });
  console.log(`Report submitted for pack "${slug}" (reason: ${reason}).`);
  console.log('The registry team will review your report. Thank you.');
}

// ── Command dispatch ──────────────────────────────────────────────────────

export async function cmdRegistry(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subcommandArgs = args.slice(1);

  try {
    switch (subcommand) {
      case 'login':
        await cmdLogin(subcommandArgs);
        break;
      case 'logout':
        await cmdLogout(subcommandArgs);
        break;
      case 'whoami':
        await cmdWhoami(subcommandArgs);
        break;
      case 'publish':
        await cmdPublish(subcommandArgs);
        break;
      case 'search':
        await cmdSearch(subcommandArgs);
        break;
      case 'install':
        await cmdInstall(subcommandArgs);
        break;
      case 'report':
        await cmdReport(subcommandArgs);
        break;
      case undefined:
      case '--help':
      case '-h':
        printRegistryHelp();
        break;
      default:
        throw new Error(`Unknown registry command: ${subcommand}. Use --help for usage.`);
    }
  } catch (error) {
    if (error instanceof RegistryError && error.status === 0) {
      // Config error — friendly message without stack trace
      console.error(error.message);
      process.exit(1);
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export function printRegistryHelp(): void {
  console.log(`
Usage: showrun registry <command> [options]

Registry commands for publishing and installing task packs

Commands:
  login         Authenticate via browser (OAuth Device Flow)

  logout        Remove stored auth tokens

  whoami        Show current authenticated user

  publish       Publish a task pack to the registry
    --path <path>         Pack directory (required)
    --slug <slug>         Registry slug (defaults to pack ID)
    --visibility <vis>    public or private (default: public)
    --changelog <text>    Changelog for this version

  search        Search for task packs
    <query>               Search query
    --page <N>            Page number
    --limit <N>           Results per page

  install       Install a task pack from the registry
    <slug>                Pack slug (required)
    --dir <path>          Destination directory (default: ./taskpacks)
    --version <ver>       Specific version (default: latest)

  report        Report a pack for policy violation
    <slug>                Pack slug (required)
    --reason <reason>     malicious, spam, inappropriate, or copyright (required)
    --description <text>  Additional details (optional, max 2000 chars)

Environment:
  SHOWRUN_REGISTRY_URL    Registry server URL (or set registry.url in config.json)

Examples:
  showrun registry login
  showrun registry whoami
  showrun registry publish --path ./taskpacks/my-pack
  showrun registry search "linkedin"
  showrun registry install example-json --dir ./taskpacks
  showrun registry report some-pack --reason malicious --description "Steals credentials"
  showrun registry logout
`);
}
