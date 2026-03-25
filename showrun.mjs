#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

const API_URL = 'https://api.showrun.co';

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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

  // Detect if input is a URL (magic link) or a code
  let code;
  if (input.startsWith('http')) {
    // Extract token from magic link URL
    const url = new URL(input);
    code = url.searchParams.get('token') || url.pathname.split('/').pop();
  } else {
    code = input;
  }

  const result = await api('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });

  saveConfig({ api_key: result.api_key, api_url: getApiUrl() });
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

  saveConfig({ api_key: result.api_key, api_url: getApiUrl() });
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
    (p) => localPaths.has(p) && lock[p] !== remoteSkills[p]
  );

  if (!added.length && !removed.length && !updated.length) {
    console.log('Everything up to date.');
    return;
  }

  if (added.length) console.log(`\nNew (${added.length}):\n  ${added.join('\n  ')}`);
  if (updated.length) console.log(`\nUpdated (${updated.length}):\n  ${updated.join('\n  ')}`);
  if (removed.length) console.log(`\nRemoved (${removed.length}):\n  ${removed.join('\n  ')}`);
}

async function cmdSync(filter) {
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
    if (!filter && lock[skillPath] === remoteSkills[skillPath]) {
      skipped++;
      continue;
    }

    const skill = await apiAuth(`/skills/${skillPath}`);
    const destDir = join(skillsDir, skillPath);
    const scriptsDir = join(destDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    // Write SKILL.md
    writeFileSync(join(destDir, 'SKILL.md'), skill.skill_md);

    // Download script
    if (skill.script_name) {
      const scriptRes = await fetch(`${getApiUrl()}/skills/${skillPath}/script`, {
        headers: { Authorization: `Bearer ${getApiKey()}` },
      });
      if (scriptRes.ok) {
        const scriptContent = await scriptRes.text();
        writeFileSync(join(scriptsDir, skill.script_name), scriptContent);
      }
    }

    lock[skillPath] = remoteSkills[skillPath];
    synced++;
  }

  saveLock(lock);
  console.log(`Synced ${synced} skill(s), ${skipped} already up to date.`);
}

async function cmdWhoami() {
  const result = await apiAuth('/me');
  console.log(`Email: ${result.email}`);
  console.log(`API Key: ${result.api_key}`);
  console.log(`Member since: ${result.created_at}`);
}

// --- Helpers ---

function flattenSkills(platforms, prefix = '') {
  const result = {};
  for (const [name, value] of Object.entries(platforms)) {
    if (value.skills && Array.isArray(value.skills)) {
      // This is a leaf with skill list — but we use the object form
    }
    if (value.apps) {
      // Platform with sub-apps (e.g., linkedin)
      for (const [appName, appValue] of Object.entries(value.apps)) {
        if (appValue.skills) {
          for (const [skillName, version] of Object.entries(appValue.skills)) {
            result[`${name}/${appName}/${skillName}`] = version;
          }
        }
      }
    } else if (value.skills) {
      // Flat platform (e.g., crunchbase)
      for (const [skillName, version] of Object.entries(value.skills)) {
        result[`${name}/${skillName}`] = version;
      }
    }
  }
  return result;
}

// --- Main ---

const [cmd, ...args] = process.argv.slice(2);

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
    default:
      console.log(`ShowRun Skills CLI

Usage:
  showrun.mjs login <email>           Request access (sends magic link + OTP)
  showrun.mjs verify <email> <code>   Verify with OTP code or magic link token
  showrun.mjs sync [path]             Download/update skills
  showrun.mjs check                   Show available updates
  showrun.mjs whoami                  Show current user info`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
