#!/usr/bin/env node
// github-user-repos.mjs — Look up GitHub users and their top repos by stars.
//
// Commands:
//   node github-user-repos.mjs search <query> [--limit=10]
//   node github-user-repos.mjs profile <login>
//   node github-user-repos.mjs top-repos <login> [--min-stars=N] [--limit=10]
//
// Auth (optional — raises rate limit from 60/hr to 5000/hr):
//   --token=<GITHUB_TOKEN>   or export GITHUB_TOKEN=...
//
// Requires Node 22+ (built-in fetch). Zero npm dependencies.

import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const BASE = 'https://api.github.com';
const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/github-user-repos');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function saveJson(path, data) {
  ensureDir(resolve(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const a of args) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(a);
  }
  return { flags, positional };
}

function authHeaders(token) {
  const h = {
    'accept': 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'showrun-github-user-repos',
  };
  if (token) h['authorization'] = `Bearer ${token}`;
  return h;
}

async function ghGet(url, token) {
  const res = await fetch(url, { headers: authHeaders(token) });
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (res.status === 403 || res.status === 429) {
    const resetTime = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : 'unknown';
    console.error(`[RATE_LIMITED] Remaining: ${remaining}, resets at: ${resetTime}. Set GITHUB_TOKEN for higher limits.`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

async function doSearch(query, limit, token) {
  const url = `${BASE}/search/users?q=${encodeURIComponent(query)}&per_page=${limit}`;
  const data = await ghGet(url, token);
  const items = (data.items || []).map(u => ({
    login: u.login,
    type: u.type,
    url: u.html_url,
    avatar: u.avatar_url,
    score: u.score,
  }));

  saveJson(resolve(CACHE_DIR, `search-${query.replace(/[^\w]+/g, '_')}.json`), { query, total: data.total_count, items });

  console.log(`Found ${data.total_count} user(s). Showing top ${items.length}:\n`);
  for (const u of items) {
    console.log(`  ${u.login.padEnd(25)} ${u.type.padEnd(12)} ${u.url}`);
  }
  if (items.length === 0) console.log('  (no matches — try a broader query or a specific login/handle)');
}

async function doProfile(login, token) {
  const url = `${BASE}/users/${encodeURIComponent(login)}`;
  const u = await ghGet(url, token);
  const out = {
    login: u.login,
    name: u.name,
    bio: u.bio,
    company: u.company,
    blog: u.blog,
    email: u.email,
    twitter: u.twitter_username,
    location: u.location,
    hireable: u.hireable,
    public_repos: u.public_repos,
    followers: u.followers,
    following: u.following,
    created_at: u.created_at,
    url: u.html_url,
  };
  saveJson(resolve(CACHE_DIR, `profile-${login}.json`), out);
  console.log(JSON.stringify(out, null, 2));
}

async function doTopRepos(login, minStars, limit, token) {
  // Fetch owner-only repos sorted by star count (GitHub sort=stars is per-user aggregate popularity)
  const url = `${BASE}/users/${encodeURIComponent(login)}/repos?sort=stars&direction=desc&per_page=100&type=owner`;
  const repos = await ghGet(url, token);

  const filtered = repos
    .filter(r => !r.fork && r.stargazers_count >= minStars)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, limit)
    .map(r => ({
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      stars: r.stargazers_count,
      forks: r.forks_count,
      language: r.language,
      url: r.html_url,
      created_at: r.created_at,
      updated_at: r.updated_at,
      archived: r.archived,
    }));

  saveJson(resolve(CACHE_DIR, `top-repos-${login}.json`), { login, min_stars: minStars, repos: filtered });

  console.log(`Top ${filtered.length} repo(s) for ${login} (min ${minStars} stars, owner-only, non-fork):\n`);
  for (const r of filtered) {
    const stars = `★${r.stars}`.padEnd(10);
    const lang = (r.language || '').padEnd(12);
    console.log(`  ${stars} ${lang} ${r.full_name}`);
    if (r.description) console.log(`              ${r.description}`);
  }
  if (filtered.length === 0) console.log('  (none — try lowering --min-stars or check the login)');
}

// CLI
const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);
const token = flags.token || process.env.GITHUB_TOKEN || '';

switch (command) {
  case 'search': {
    const query = positional.join(' ');
    if (!query) {
      console.error('Usage: github-user-repos.mjs search <query> [--limit=10]');
      process.exit(1);
    }
    await doSearch(query, parseInt(flags.limit || '10', 10), token);
    break;
  }
  case 'profile': {
    const login = positional[0];
    if (!login) {
      console.error('Usage: github-user-repos.mjs profile <login>');
      process.exit(1);
    }
    await doProfile(login, token);
    break;
  }
  case 'top-repos': {
    const login = positional[0];
    if (!login) {
      console.error('Usage: github-user-repos.mjs top-repos <login> [--min-stars=0] [--limit=10]');
      process.exit(1);
    }
    const minStars = parseInt(flags['min-stars'] || '0', 10);
    const limit = parseInt(flags.limit || '10', 10);
    await doTopRepos(login, minStars, limit, token);
    break;
  }
  default:
    console.log(`github-user-repos

Look up GitHub users and their top repos by stars. Useful for VC research
on technical founders (e.g. "did this CTO ship a widely-used OSS project?").

Commands:
  search <query> [--limit=10]                 Search GitHub users by name/login/email
  profile <login>                             Full user profile (name, bio, company, email)
  top-repos <login> [--min-stars=N] [--limit=10]
                                              User's top owner-only repos sorted by stars

Auth (optional — raises rate limit from 60/hr to 5000/hr):
  --token=<GITHUB_TOKEN>   or set GITHUB_TOKEN env var

Examples:
  node github-user-repos.mjs search "linus torvalds"
  node github-user-repos.mjs profile torvalds
  node github-user-repos.mjs top-repos torvalds --min-stars=10000
  GITHUB_TOKEN=ghp_... node github-user-repos.mjs top-repos sindresorhus`);
}
