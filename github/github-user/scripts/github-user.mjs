#!/usr/bin/env node
/**
 * GitHub User/Organization Profile Scraper
 *
 * Fetches public profile data for a GitHub user or organization,
 * with optional repository listing.
 * Uses the GitHub REST API — no browser needed.
 *
 * Data Sources:
 *   - User profile:  GET /users/{username}
 *   - Org profile:   GET /orgs/{org}  (tried if /users/ returns org type)
 *   - User repos:    GET /users/{username}/repos?sort=updated&per_page=30
 *   - Org repos:     GET /orgs/{org}/repos?sort=updated&per_page=30
 *   - Search users:  GET /search/users?q={username}
 *
 * Usage:
 *   node github-user.mjs <username-or-url> [options]
 *
 * Arguments:
 *   <username-or-url>  GitHub username or profile URL (required)
 *                      Examples:
 *                        torvalds
 *                        microsoft
 *                        https://github.com/gaearon
 *
 * Options:
 *   --include-repos      Also fetch the user's/org's public repositories
 *   --max-repos N        Max repos to fetch (default: 30, max: 100)
 *
 * Examples:
 *   node github-user.mjs torvalds
 *   node github-user.mjs microsoft --include-repos --max-repos 20
 *   node github-user.mjs https://github.com/gaearon --include-repos
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(__dirname, "../../lib/utils.mjs");
const {
  emitResult,
  emitError,
  log,
  fetchJson,
  parseUsername,
  normalizeUser,
  normalizeRepo,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node github-user.mjs <username-or-url> [options]

Arguments:
  <username-or-url>   GitHub username or profile URL (required)
                      e.g. torvalds
                           https://github.com/microsoft

Options:
  --include-repos     Fetch the user's public repositories
  --max-repos N       Max repos to return (default: 30, max: 100)
  --help              Show this help

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const userInput = args[0];
let includeRepos = false;
let maxRepos = 30;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--include-repos") includeRepos = true;
  else if (arg === "--max-repos" && args[i + 1]) {
    maxRepos = Math.min(100, Math.max(1, parseInt(args[++i], 10) || 30));
  }
}

// ---------------------------------------------------------------------------
// Parse username
// ---------------------------------------------------------------------------

const username = parseUsername(userInput);
if (!username) {
  emitError(
    "INVALID_INPUT",
    `Could not parse a GitHub username from: "${userInput}". ` +
      `Provide a username (e.g. "torvalds") or a GitHub profile URL.`
  );
}

log(`[github-user] Fetching profile: ${username}`);

const BASE = "https://api.github.com";

// ---------------------------------------------------------------------------
// Fetch user/org profile
// ---------------------------------------------------------------------------

let userData;
let isOrg = false;

try {
  userData = await fetchJson(`${BASE}/users/${username}`);
} catch (err) {
  if (err && err.notFound) {
    emitError(
      "NOT_FOUND",
      `GitHub user or organization "${username}" not found. Check the spelling and try again.`
    );
  }
  emitError("FETCH_ERROR", `Failed to fetch user profile: ${err.message || String(err)}`);
}

// If it's an Organization type, also fetch the org-specific fields
if (userData.type === "Organization") {
  isOrg = true;
  log(`[github-user] "${username}" is an Organization — fetching org details`);
  try {
    const orgData = await fetchJson(`${BASE}/orgs/${username}`);
    // Merge org data (has more fields like blog, email, location, description)
    userData = { ...userData, ...orgData };
  } catch (err) {
    log(`[github-user] Warning: Could not fetch org details, using /users endpoint data: ${err.message || String(err)}`);
  }
}

const profile = normalizeUser(userData);

// Handle org-specific fields that /users doesn't expose
if (isOrg) {
  profile.description = userData.description || null;
  profile.membersUrl = userData.members_url ? userData.members_url.replace("{/member}", "") : null;
  profile.publicMembersUrl = userData.public_members_url ? userData.public_members_url.replace("{/member}", "") : null;
}

log(`[github-user] Found: ${profile.name || profile.login} (${profile.type}), ${profile.publicRepos} public repos`);

// ---------------------------------------------------------------------------
// Optional: Repos
// ---------------------------------------------------------------------------

profile.repos = null;

if (includeRepos) {
  const perPage = Math.min(maxRepos, 100);
  log(`[github-user] Fetching repos (max: ${maxRepos})...`);

  const reposEndpoint = isOrg
    ? `${BASE}/orgs/${username}/repos?sort=updated&per_page=${perPage}&type=public`
    : `${BASE}/users/${username}/repos?sort=updated&per_page=${perPage}&type=public`;

  try {
    const reposData = await fetchJson(reposEndpoint);
    if (Array.isArray(reposData)) {
      profile.repos = reposData.slice(0, maxRepos).map(normalizeRepo);
      log(`[github-user] Got ${profile.repos.length} repos`);
    }
  } catch (err) {
    log(`[github-user] Warning: Could not fetch repos: ${err.message || String(err)}`);
    profile.repos = [];
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

emitResult(profile);
