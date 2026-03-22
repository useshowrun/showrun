# github

Scraper skills for GitHub. Fetches repository metadata, user/org profiles, and search results using the official GitHub REST API — no browser, no bot protection, pure HTTP.

## Skills

| Skill | Description |
|-------|-------------|
| [github-search](./github-search/SKILL.md) | Search GitHub repos or users by keyword |
| [github-repo](./github-repo/SKILL.md) | Get full repository details: metadata, README, issues, releases, contributors |
| [github-user](./github-user/SKILL.md) | Get user/org profile + their public repos |

## Data Sources

| Source | URL | Notes |
|--------|-----|-------|
| GitHub REST API | `https://api.github.com` | All endpoints; public data, no auth required |
| Search repos | `/search/repositories?q=<query>` | Up to 100 results per query |
| Search users | `/search/users?q=<query>` | Up to 100 results per query |
| Repo details | `/repos/{owner}/{repo}` | Full metadata |
| README | `/repos/{owner}/{repo}/readme` | Base64 encoded, decoded in output |
| Topics | `/repos/{owner}/{repo}/topics` | Repo topics/tags |
| Issues | `/repos/{owner}/{repo}/issues` | Open issues (excluding PRs) |
| Releases | `/repos/{owner}/{repo}/releases` | Version releases |
| Contributors | `/repos/{owner}/{repo}/contributors` | Top contributors by commit count |
| User profile | `/users/{username}` | Public user data |
| Org profile | `/orgs/{org}` | Organization-specific data |
| User repos | `/users/{username}/repos` | User's public repositories |

## Authentication

Set `GITHUB_TOKEN` environment variable for higher rate limits:

```bash
export GITHUB_TOKEN=ghp_your_token_here
```

| Mode | Rate Limit |
|------|-----------|
| Unauthenticated | 60 requests/hour |
| Authenticated | 5,000 requests/hour |

## Notes

- **No authentication required** for public data
- **No browser needed** — pure HTTP GET requests to the REST API
- **Rate limit aware** — emits warning when running low, clean error on exhaustion
- **Flexible input** — accepts `owner/repo`, full GitHub URLs, usernames, or org names
- README is truncated to 5000 characters to keep output manageable
