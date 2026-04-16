# github-user-repos

Find a GitHub user and list their top repositories by star count. Useful for VC research on technical founders — e.g. "did this CTO previously ship a widely-used OSS project?"

## Prerequisites

- Node.js 22+ (built-in `fetch`). Zero npm dependencies.

## Auth (optional)

All commands work **unauthenticated** at a rate limit of 60 requests/hour per IP.

For heavier use, set `GITHUB_TOKEN` (personal access token, no scopes required for public data):
```bash
export GITHUB_TOKEN=ghp_...
```
Or pass per-call: `--token=ghp_...`. Authenticated limit is 5,000/hour.

## Commands

### Search for a user

```bash
node scripts/github-user-repos.mjs search <query> [--limit=10]
```

Searches by name, login, or email-substring. Returns top matches with login + profile URL.

### Get user profile

```bash
node scripts/github-user-repos.mjs profile <login>
```

Returns name, bio, company, blog, email (if public), twitter, location, public repo count, followers.

### Top repos by stars

```bash
node scripts/github-user-repos.mjs top-repos <login> [--min-stars=N] [--limit=10]
```

Lists owner-only repos (excludes forks) sorted by stars descending. Use `--min-stars=10000` to test the "widely-used OSS" criterion.

## Examples

```bash
# Find a founder by name
node scripts/github-user-repos.mjs search "Guillermo Rauch"

# Confirm their identity / bio
node scripts/github-user-repos.mjs profile rauchg

# Check for 10k+ star OSS projects
node scripts/github-user-repos.mjs top-repos rauchg --min-stars=10000
```

## Output

JSON results are cached to `~/.local/share/showrun/data/github-user-repos/cache/`:
- `search-<query>.json`
- `profile-<login>.json`
- `top-repos-<login>.json`

Terminal output is a compact summary (tabular for search/top-repos, full JSON for profile).

## Agent guidance

- `search` results are imprecise. When a name has few hits, use `profile` to confirm identity (match bio/company/location against known context before treating as definitive).
- For "founding CTO shipped OSS with N+ stars" workflows: run `search` with the person's name → pick candidate login(s) → `top-repos --min-stars=N`. If no match, try variants (full name, "firstname lastname", GitHub handle).
- If you hit HTTP 403/429, you are rate-limited. Ask the user for a `GITHUB_TOKEN` rather than retrying immediately.
