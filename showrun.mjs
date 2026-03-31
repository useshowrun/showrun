#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const API_URL = 'https://api.showrun.co';
const SHOWRUN_URL = 'https://showrun.co/showrun.mjs';
const DEFAULT_CHECK_INTERVAL_HOURS = 24;

// --- Config ---

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config');
  return join(xdg, 'showrun');
}

function configPath() {
  return join(configDir(), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n');
}

function getApiKey() {
  const config = loadConfig();
  if (!config.api_key) {
    console.error('Not logged in. Run: node showrun.mjs login <email>');
    process.exit(1);
  }
  return config.api_key;
}

function getApiUrl() {
  return loadConfig().api_url || API_URL;
}

// --- Lock file ---

function lockPath() {
  return join(dirname(new URL(import.meta.url).pathname), '.showrun-lock.json');
}

function loadLock() {
  try {
    return JSON.parse(readFileSync(lockPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveLock(lock) {
  writeFileSync(lockPath(), JSON.stringify(lock, null, 2) + '\n');
}

// --- API helpers ---

async function api(path, opts = {}) {
  const url = `${getApiUrl()}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

async function apiAuth(path, opts = {}) {
  const apiKey = getApiKey();
  return api(path, {
    ...opts,
    headers: { Authorization: `Bearer ${apiKey}`, ...opts.headers },
  });
}

// --- Prompt helper ---

function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function lockVersion(entry) {
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.version;
}

// --- Self-update ---

async function selfUpdate() {
  try {
    const selfPath = new URL(import.meta.url).pathname;
    const localContent = readFileSync(selfPath, 'utf8');
    const localHash = createHash('sha256').update(localContent).digest('hex');

    const res = await fetch(SHOWRUN_URL);
    if (!res.ok) return;
    const remoteContent = await res.text();
    const remoteHash = createHash('sha256').update(remoteContent).digest('hex');

    if (localHash === remoteHash) return;

    writeFileSync(selfPath, remoteContent);
    console.log('showrun.mjs updated. Please re-run your command.');
    process.exit(0);
  } catch {
    // Silent failure — don't block the user's command
  }
}

// --- Auto-update ---

async function autoUpdate() {
  const config = loadConfig();
  if (!config.api_key) return;

  const interval = config.check_interval_hours ?? DEFAULT_CHECK_INTERVAL_HOURS;
  if (interval <= 0) return;

  const lastCheck = config.last_check ? new Date(config.last_check) : null;
  const now = new Date();

  if (lastCheck && (now - lastCheck) < interval * 60 * 60 * 1000) return;

  await selfUpdate();

  try {
    const lock = loadLock();
    const remote = await apiAuth('/skills');
    const remoteSkills = flattenSkills(remote.platforms);
    const remotePaths = new Set(Object.keys(remoteSkills));
    const localPaths = new Set(Object.keys(lock));

    const hasUpdates =
      [...remotePaths].some((p) => !localPaths.has(p) || lockVersion(lock[p]) !== remoteSkills[p]);

    if (hasUpdates) {
      console.log('Updates available, syncing...');
      await cmdSync(null, true);
    }
  } catch {
    // Silent failure — don't block the user's command
  }

  saveConfig({ ...loadConfig(), last_check: now.toISOString() });
}

// --- Commands ---

async function cmdLogin(email) {
  if (!email) {
    console.error('Usage: showrun.mjs login <email>');
    process.exit(1);
  }

  console.log(`Sending verification email to ${email}...`);
  await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });

  console.log('Check your email for a magic link or OTP code.');
  const input = await prompt('Paste magic link or OTP code: ');

  let code;
  if (input.startsWith('http')) {
    const url = new URL(input);
    code = url.searchParams.get('token') || url.pathname.split('/').pop();
  } else {
    code = input;
  }

  const result = await api('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });

  const existing = loadConfig();
  saveConfig({
    ...existing,
    api_key: result.api_key,
    api_url: getApiUrl(),
    last_check: new Date().toISOString(),
    check_interval_hours: existing.check_interval_hours ?? DEFAULT_CHECK_INTERVAL_HOURS,
  });
  console.log('Logged in successfully. API key saved.');
}

async function cmdVerify(email, code) {
  if (!email || !code) {
    console.error('Usage: showrun.mjs verify <email> <code>');
    process.exit(1);
  }

  const result = await api('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });

  const existing = loadConfig();
  saveConfig({
    ...existing,
    api_key: result.api_key,
    api_url: getApiUrl(),
    last_check: new Date().toISOString(),
    check_interval_hours: existing.check_interval_hours ?? DEFAULT_CHECK_INTERVAL_HOURS,
  });
  console.log('Verified. API key saved.');
}

async function cmdCheck() {
  const lock = loadLock();
  const remote = await apiAuth('/skills');

  const remoteSkills = flattenSkills(remote.platforms);
  const localPaths = new Set(Object.keys(lock));
  const remotePaths = new Set(Object.keys(remoteSkills));

  const added = [...remotePaths].filter((p) => !localPaths.has(p));
  const removed = [...localPaths].filter((p) => !remotePaths.has(p));
  const updated = [...remotePaths].filter(
    (p) => localPaths.has(p) && lockVersion(lock[p]) !== remoteSkills[p]
  );

  if (!added.length && !removed.length && !updated.length) {
    console.log('Everything up to date.');
    return;
  }

  if (added.length) console.log(`\nNew (${added.length}):\n  ${added.join('\n  ')}`);
  if (updated.length) console.log(`\nUpdated (${updated.length}):\n  ${updated.join('\n  ')}`);
  if (removed.length) console.log(`\nRemoved (${removed.length}):\n  ${removed.join('\n  ')}`);

  saveConfig({ ...loadConfig(), last_check: new Date().toISOString() });
}

async function cmdSync(filter, silent = false) {
  const remote = await apiAuth('/skills');
  const remoteSkills = flattenSkills(remote.platforms);
  const lock = loadLock();
  const skillsDir = join(dirname(new URL(import.meta.url).pathname), 'skills');

  let paths = Object.keys(remoteSkills);
  if (filter) {
    paths = paths.filter((p) => p.startsWith(filter));
    if (!paths.length) {
      console.error(`No skills matching "${filter}".`);
      process.exit(1);
    }
  }

  let synced = 0;
  let skipped = 0;

  for (const skillPath of paths) {
    const lockEntry = lock[skillPath];
    if (!filter && lockEntry && lockVersion(lockEntry) === remoteSkills[skillPath]) {
      // Verify all expected files actually exist on disk
      const hasSkillMd = existsSync(join(skillsDir, skillPath, 'SKILL.md'));
      const expectedScript = typeof lockEntry === 'object' ? lockEntry.script_name : null;
      const hasScript = !expectedScript ||
        existsSync(join(skillsDir, skillPath, 'scripts', expectedScript));
      if (hasSkillMd && hasScript) {
        skipped++;
        continue;
      }
    }

    const skill = await apiAuth(`/skills/${skillPath}`);
    const destDir = join(skillsDir, skillPath);
    mkdirSync(destDir, { recursive: true });

    writeFileSync(join(destDir, 'SKILL.md'), skill.skill_md);

    if (skill.script_name) {
      const scriptsDir = join(destDir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const scriptRes = await fetch(`${getApiUrl()}/skills/${skillPath}/script`, {
        headers: { Authorization: `Bearer ${getApiKey()}` },
      });
      if (scriptRes.ok) {
        writeFileSync(join(scriptsDir, skill.script_name), await scriptRes.text());
      } else {
        console.error(`  ✗ Failed to download script for ${skillPath} (HTTP ${scriptRes.status})`);
        continue;
      }
    }

    lock[skillPath] = { version: remoteSkills[skillPath], script_name: skill.script_name || null };
    synced++;
  }

  saveLock(lock);
  saveConfig({ ...loadConfig(), last_check: new Date().toISOString() });

  if (!silent) {
    console.log(`Synced ${synced} skill(s), ${skipped} already up to date.`);
  }
}

async function cmdWhoami() {
  const result = await apiAuth('/me');
  console.log(`Email: ${result.email}`);
  console.log(`API Key: ${result.api_key}`);
  console.log(`Member since: ${result.created_at}`);
}

async function cmdConfig(key, value) {
  if (!key) {
    const config = loadConfig();
    for (const [k, v] of Object.entries(config)) {
      if (k === 'api_key') continue;
      console.log(`${k}: ${v}`);
    }
    return;
  }

  if (value === undefined) {
    const config = loadConfig();
    console.log(config[key] ?? '(not set)');
    return;
  }

  const config = loadConfig();
  const parsed = Number(value);
  config[key] = isNaN(parsed) ? value : parsed;
  saveConfig(config);
  console.log(`${key} = ${config[key]}`);
}

// --- Helpers ---

function flattenSkills(platforms) {
  const result = {};
  for (const [name, value] of Object.entries(platforms)) {
    if (value.apps) {
      for (const [appName, appValue] of Object.entries(value.apps)) {
        if (appValue.skills) {
          for (const [skillName, version] of Object.entries(appValue.skills)) {
            result[`${name}/${appName}/${skillName}`] = version;
          }
        }
      }
    } else if (value.skills) {
      for (const [skillName, version] of Object.entries(value.skills)) {
        result[`${name}/${skillName}`] = version;
      }
    }
  }
  return result;
}

// --- Main ---

const [cmd, ...args] = process.argv.slice(2);

// Auto-update before any authenticated command
if (['check', 'sync', 'whoami'].includes(cmd)) {
  await autoUpdate();
}

try {
  switch (cmd) {
    case 'login':
      await cmdLogin(args[0]);
      break;
    case 'verify':
      await cmdVerify(args[0], args[1]);
      break;
    case 'check':
      await cmdCheck();
      break;
    case 'sync':
      await cmdSync(args[0]);
      break;
    case 'whoami':
      await cmdWhoami();
      break;
    case 'config':
      await cmdConfig(args[0], args[1]);
      break;
    default:
      console.log(`ShowRun Skills CLI

Usage:
  showrun.mjs login <email>           Request access (sends magic link + OTP)
  showrun.mjs verify <email> <code>   Verify with OTP code or magic link token
  showrun.mjs sync [path]             Download/update skills
  showrun.mjs check                   Show available updates
  showrun.mjs whoami                  Show current user info
  showrun.mjs config [key] [value]    View or set configuration`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
