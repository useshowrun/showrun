#!/usr/bin/env node
/**
 * GitHub Repository Detail Scraper
 *
 * Fetches full metadata for a GitHub repository, with optional extras:
 * README content, recent issues, releases, and top contributors.
 * Uses the GitHub REST API — no browser needed.
 *
 * Data Sources:
 *   - Repo metadata:   GET /repos/{owner}/{repo}
 *   - README:          GET /repos/{owner}/{repo}/readme
 *   - Topics:          GET /repos/{owner}/{repo}/topics
 *   - Issues:          GET /repos/{owner}/{repo}/issues?state=open&per_page=25
 *   - Releases:        GET /repos/{owner}/{repo}/releases?per_page=10
 *   - Contributors:    GET /repos/{owner}/{repo}/contributors?per_page=25
 *
 * Usage:
 *   node github-repo.mjs <owner/repo-or-url> [options]
 *
 * Arguments:
 *   <owner/repo-or-url>  Repository identifier (required)
 *                        Examples:
 *                          facebook/react
 *                          https://github.com/torvalds/linux
 *                          github.com/microsoft/vscode
 *
 * Options:
 *   --include-readme       Fetch and decode README (truncated to 5000 chars)
 *   --include-issues       Fetch recent open issues (up to 25)
 *   --include-releases     Fetch recent releases (up to 10)
 *   --include-contributors Fetch top contributors (up to 25)
 *   --all                  Include all optional data (readme + issues + releases + contributors)
 *
 * Examples:
 *   node github-repo.mjs facebook/react
 *   node github-repo.mjs torvalds/linux --all
 *   node github-repo.mjs https://github.com/microsoft/vscode --include-readme --include-issues
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
  fetchUrl,
  getGitHubHeaders,
  parseOwnerRepo,
  normalizeRepo,
  normalizeIssue,
  normalizeRelease,
  normalizeContributor,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node github-repo.mjs <owner/repo-or-url> [options]

Arguments:
  <owner/repo-or-url>    Repository identifier (required)
                         e.g. facebook/react
                              https://github.com/torvalds/linux

Options:
  --include-readme         Fetch and decode README (truncated to 5000 chars)
  --include-issues         Fetch recent open issues (up to 25)
  --include-releases       Fetch recent releases (up to 10)
  --include-contributors   Fetch top contributors (up to 25)
  --all                    Include all optional data
  --help                   Show this help

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const repoInput = args[0];
let includeReadme = false;
let includeIssues = false;
let includeReleases = false;
let includeContributors = false;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--include-readme") includeReadme = true;
  else if (arg === "--include-issues") includeIssues = true;
  else if (arg === "--include-releases") includeReleases = true;
  else if (arg === "--include-contributors") includeContributors = true;
  else if (arg === "--all") {
    includeReadme = true;
    includeIssues = true;
    includeReleases = true;
    includeContributors = true;
  }
}

// ---------------------------------------------------------------------------
// Parse input
// ---------------------------------------------------------------------------

const parsed = parseOwnerRepo(repoInput);
if (!parsed) {
  emitError(
    "INVALID_INPUT",
    `Could not parse repository from: "${repoInput}". ` +
      `Provide "owner/repo", a GitHub URL, or path like "facebook/react".`
  );
}

const { owner, repo } = parsed;
log(`[github-repo] Fetching: ${owner}/${repo}`);

const BASE = "https://api.github.com";
const REPO_URL = `${BASE}/repos/${owner}/${repo}`;

// ---------------------------------------------------------------------------
// Fetch repo metadata
// ---------------------------------------------------------------------------

let repoData;
try {
  repoData = await fetchJson(REPO_URL);
} catch (err) {
  if (err && err.notFound) {
    emitError(
      "NOT_FOUND",
      `Repository "${owner}/${repo}" not found. It may be private, deleted, or the name may be incorrect.`
    );
  }
  emitError("FETCH_ERROR", `Failed to fetch repository: ${err.message || String(err)}`);
}

const result = normalizeRepo(repoData);
log(`[github-repo] Got repo: ${result.fullName} (⭐ ${result.stars.toLocaleString()})`);

// Topics are included in repo response when available
// But for completeness, also explicitly fetch via topics endpoint
if (!result.topics || result.topics.length === 0) {
  try {
    const topicsData = await fetchJson(`${REPO_URL}/topics`, {
      extraHeaders: { Accept: "application/vnd.github.mercy-preview+json" },
    });
    if (topicsData && Array.isArray(topicsData.names)) {
      result.topics = topicsData.names;
    }
  } catch (err) {
    log(`[github-repo] Warning: Could not fetch topics: ${err.message || String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Optional: README
// ---------------------------------------------------------------------------

result.readme = null;

if (includeReadme) {
  log(`[github-repo] Fetching README...`);
  try {
    const readmeData = await fetchJson(`${REPO_URL}/readme`);
    if (readmeData && readmeData.content) {
      const decoded = Buffer.from(readmeData.content, "base64").toString("utf8");
      result.readme = decoded.substring(0, 5000);
      if (decoded.length > 5000) {
        result.readme += "\n\n[README truncated at 5000 chars]";
      }
      log(`[github-repo] README fetched (${decoded.length} chars, truncated to ${result.readme.length})`);
    }
  } catch (err) {
    if (err && err.notFound) {
      log(`[github-repo] No README found for this repository`);
    } else {
      log(`[github-repo] Warning: Could not fetch README: ${err.message || String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Optional: Recent open issues
// ---------------------------------------------------------------------------

result.recentIssues = null;

if (includeIssues) {
  log(`[github-repo] Fetching recent open issues...`);
  try {
    const issuesUrl = `${REPO_URL}/issues?state=open&per_page=25&sort=created&direction=desc`;
    const issuesData = await fetchJson(issuesUrl);
    if (Array.isArray(issuesData)) {
      // GitHub issues endpoint also returns PRs; filter them out
      result.recentIssues = issuesData
        .filter((i) => !i.pull_request)
        .map(normalizeIssue);
      log(`[github-repo] Got ${result.recentIssues.length} open issues`);
    }
  } catch (err) {
    log(`[github-repo] Warning: Could not fetch issues: ${err.message || String(err)}`);
    result.recentIssues = [];
  }
}

// ---------------------------------------------------------------------------
// Optional: Releases
// ---------------------------------------------------------------------------

result.latestRelease = null;
result.releases = null;

if (includeReleases) {
  log(`[github-repo] Fetching releases...`);
  try {
    const releasesData = await fetchJson(`${REPO_URL}/releases?per_page=10`);
    if (Array.isArray(releasesData) && releasesData.length > 0) {
      const normalized = releasesData.map(normalizeRelease);
      result.latestRelease = normalized[0];
      result.releases = normalized;
      log(`[github-repo] Got ${normalized.length} releases, latest: ${normalized[0].tagName}`);
    } else {
      result.releases = [];
      log(`[github-repo] No releases found`);
    }
  } catch (err) {
    log(`[github-repo] Warning: Could not fetch releases: ${err.message || String(err)}`);
    result.releases = [];
  }
}

// ---------------------------------------------------------------------------
// Optional: Contributors
// ---------------------------------------------------------------------------

result.topContributors = null;

if (includeContributors) {
  log(`[github-repo] Fetching top contributors...`);
  try {
    const contribData = await fetchJson(`${REPO_URL}/contributors?per_page=25`);
    if (Array.isArray(contribData)) {
      result.topContributors = contribData.map(normalizeContributor);
      log(`[github-repo] Got ${result.topContributors.length} contributors`);
    }
  } catch (err) {
    log(`[github-repo] Warning: Could not fetch contributors: ${err.message || String(err)}`);
    result.topContributors = [];
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

emitResult(result);
