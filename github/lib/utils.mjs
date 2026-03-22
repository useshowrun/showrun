/**
 * Shared utilities for GitHub scraper skills
 *
 * Data Sources:
 *   - GitHub REST API v3: https://api.github.com
 *   - No authentication required for public data (60 req/hour unauthenticated)
 *   - Set GITHUB_TOKEN env var for 5000 req/hour authenticated access
 *
 * API Version: 2022-11-28
 */

import https from "https";
import http from "http";
import { URL } from "url";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

export function emitError(code, message, extra = {}) {
  process.stdout.write(
    "RESULT:" + JSON.stringify({ error: true, code, message, ...extra }) + "\n"
  );
  process.exit(1);
}

export function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// GitHub API headers
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

export function getGitHubHeaders(extra = {}) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-browser-skills/1.0 (github-scraper)",
    ...extra,
  };
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// HTTP fetch helper (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return body string, status code, and headers.
 * Follows up to 5 redirects automatically.
 */
export function fetchUrl(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const maxRedirects = options.maxRedirects ?? 5;
    let redirectsLeft = maxRedirects;

    function doRequest(currentUrl) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${currentUrl}`));
      }

      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;

      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: options.headers || getGitHubHeaders(),
        timeout: options.timeout || 25000,
      };

      const req = lib.request(reqOptions, (res) => {
        // Handle redirects
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          redirectsLeft--;
          let redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith("http")) {
            redirectUrl = new URL(redirectUrl, currentUrl).toString();
          }
          res.resume();
          return doRequest(redirectUrl);
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            finalUrl: currentUrl,
          });
        });
        res.on("error", reject);
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out: ${currentUrl}`));
      });
      req.on("error", reject);
      req.end();
    }

    doRequest(urlStr);
  });
}

/**
 * Fetch and parse JSON from a URL (with GitHub API headers).
 * Handles rate limit detection and surfaces informative errors.
 */
export async function fetchJson(urlStr, options = {}) {
  const headers = options.headers || getGitHubHeaders(options.extraHeaders || {});
  const resp = await fetchUrl(urlStr, { ...options, headers });

  // Check rate limit headers
  const remaining = resp.headers["x-ratelimit-remaining"];
  const resetTs = resp.headers["x-ratelimit-reset"];
  if (remaining !== undefined) {
    const rem = parseInt(remaining, 10);
    if (rem <= 5) {
      const resetTime = resetTs ? new Date(parseInt(resetTs, 10) * 1000).toISOString() : "unknown";
      log(`[github] ⚠️  Rate limit low: ${rem} requests remaining. Resets at ${resetTime}`);
    }
    if (rem === 0) {
      const resetTime = resetTs ? new Date(parseInt(resetTs, 10) * 1000).toISOString() : "unknown";
      emitError("RATE_LIMITED", `GitHub API rate limit exceeded. Resets at ${resetTime}. Set GITHUB_TOKEN env var for 5000 req/hour.`, {
        rateLimitReset: resetTime,
        tip: "Set GITHUB_TOKEN environment variable to increase rate limit to 5000/hour",
      });
    }
  }

  if (resp.status === 403) {
    let msg = `HTTP 403 from GitHub API for ${urlStr}`;
    try {
      const body = JSON.parse(resp.body);
      if (body.message) msg = body.message;
      if (body.message && body.message.toLowerCase().includes("rate limit")) {
        const resetTime = resetTs ? new Date(parseInt(resetTs, 10) * 1000).toISOString() : "unknown";
        emitError("RATE_LIMITED", `GitHub API rate limit exceeded. Resets at ${resetTime}. Set GITHUB_TOKEN for 5000 req/hour.`, {
          rateLimitReset: resetTime,
        });
      }
    } catch (_) {}
    throw new Error(msg);
  }

  if (resp.status === 404) {
    throw new Object({ notFound: true, status: 404, url: urlStr });
  }

  if (resp.status >= 400) {
    let msg = `HTTP ${resp.status} for ${urlStr}`;
    try {
      const body = JSON.parse(resp.body);
      if (body.message) msg = body.message;
    } catch (_) {}
    throw new Error(msg);
  }

  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new Error(`Invalid JSON from ${urlStr}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Input parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse an "owner/repo" string or GitHub URL into { owner, repo }.
 * Accepts:
 *   - "facebook/react"
 *   - "https://github.com/facebook/react"
 *   - "github.com/facebook/react"
 *   - "https://github.com/facebook/react/tree/main"
 *   - "https://github.com/facebook/react.git"
 *
 * Returns { owner, repo } or null if not parseable.
 */
export function parseOwnerRepo(input) {
  if (!input) return null;
  input = input.trim().replace(/\.git$/, "");

  // Full URL
  const urlMatch = input.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }

  // "owner/repo" format
  const slashMatch = input.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slashMatch) {
    return { owner: slashMatch[1], repo: slashMatch[2] };
  }

  return null;
}

/**
 * Parse a GitHub username or URL.
 * Accepts:
 *   - "torvalds"
 *   - "https://github.com/torvalds"
 *   - "github.com/torvalds"
 *
 * Returns the username string or null.
 */
export function parseUsername(input) {
  if (!input) return null;
  input = input.trim();

  // Full URL
  const urlMatch = input.match(/github\.com\/([^/#?\s]+)/i);
  if (urlMatch) return urlMatch[1];

  // Plain username (no slashes)
  if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(input)) {
    return input;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Data normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw GitHub repository API response into a clean object.
 */
export function normalizeRepo(raw) {
  return {
    id: raw.id,
    fullName: raw.full_name,
    name: raw.name,
    owner: raw.owner ? {
      login: raw.owner.login,
      type: raw.owner.type,
      avatarUrl: raw.owner.avatar_url,
    } : null,
    description: raw.description || null,
    url: raw.html_url,
    homepage: raw.homepage || null,
    stars: raw.stargazers_count ?? 0,
    forks: raw.forks_count ?? 0,
    watchers: raw.watchers_count ?? 0,
    openIssues: raw.open_issues_count ?? 0,
    size: raw.size ?? 0,
    language: raw.language || null,
    topics: raw.topics || [],
    license: raw.license ? {
      name: raw.license.name,
      spdxId: raw.license.spdx_id,
    } : null,
    isPrivate: raw.private ?? false,
    isFork: raw.fork ?? false,
    isArchived: raw.archived ?? false,
    isTemplate: raw.is_template ?? false,
    defaultBranch: raw.default_branch || "main",
    createdAt: raw.created_at || null,
    updatedAt: raw.updated_at || null,
    pushedAt: raw.pushed_at || null,
  };
}

/**
 * Normalize a raw GitHub issue API response into a clean object.
 */
export function normalizeIssue(raw) {
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    state: raw.state,
    url: raw.html_url,
    author: raw.user ? raw.user.login : null,
    labels: (raw.labels || []).map((l) => l.name),
    comments: raw.comments ?? 0,
    createdAt: raw.created_at || null,
    updatedAt: raw.updated_at || null,
    body: raw.body ? raw.body.substring(0, 500) : null,
  };
}

/**
 * Normalize a raw GitHub release API response into a clean object.
 */
export function normalizeRelease(raw) {
  return {
    id: raw.id,
    tagName: raw.tag_name,
    name: raw.name || raw.tag_name,
    isDraft: raw.draft ?? false,
    isPrerelease: raw.prerelease ?? false,
    url: raw.html_url,
    author: raw.author ? raw.author.login : null,
    publishedAt: raw.published_at || null,
    body: raw.body ? raw.body.substring(0, 1000) : null,
    assets: (raw.assets || []).map((a) => ({
      name: a.name,
      downloadCount: a.download_count,
      size: a.size,
    })),
  };
}

/**
 * Normalize a raw GitHub contributor API response.
 */
export function normalizeContributor(raw) {
  return {
    login: raw.login,
    avatarUrl: raw.avatar_url,
    url: raw.html_url,
    contributions: raw.contributions,
    type: raw.type,
  };
}

/**
 * Normalize a raw GitHub user/org API response.
 */
export function normalizeUser(raw) {
  return {
    login: raw.login,
    name: raw.name || null,
    type: raw.type || "User",
    avatarUrl: raw.avatar_url,
    url: raw.html_url,
    bio: raw.bio || null,
    company: raw.company || null,
    location: raw.location || null,
    email: raw.email || null,
    blog: raw.blog || null,
    publicRepos: raw.public_repos ?? 0,
    publicGists: raw.public_gists ?? 0,
    followers: raw.followers ?? 0,
    following: raw.following ?? 0,
    createdAt: raw.created_at || null,
  };
}
