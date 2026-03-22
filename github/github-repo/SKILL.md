# github-repo

Get full metadata for a GitHub repository. Optionally fetches README, recent issues, releases, and top contributors.

## Usage

```bash
node github-repo.mjs <owner/repo-or-url> [options]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<owner/repo-or-url>` | Repository identifier (required) — accepts `owner/repo`, GitHub URL |

## Options

| Option | Description |
|--------|-------------|
| `--include-readme` | Fetch and decode README (truncated to 5000 chars) |
| `--include-issues` | Fetch recent open issues (up to 25, excluding PRs) |
| `--include-releases` | Fetch recent releases (up to 10) |
| `--include-contributors` | Fetch top contributors (up to 25) |
| `--all` | Include all optional data |

## Examples

```bash
# Basic repo info
node github-repo.mjs facebook/react

# Full details with everything
node github-repo.mjs torvalds/linux --all

# With README and issues from a URL
node github-repo.mjs https://github.com/microsoft/vscode --include-readme --include-issues

# Just releases
node github-repo.mjs microsoft/vscode --include-releases
```

## Output

```json
{
  "id": 10270250,
  "fullName": "facebook/react",
  "name": "react",
  "owner": { "login": "facebook", "type": "Organization", "avatarUrl": "..." },
  "description": "The library for web and native user interfaces.",
  "url": "https://github.com/facebook/react",
  "homepage": "https://react.dev",
  "stars": 230000,
  "forks": 47000,
  "watchers": 230000,
  "openIssues": 900,
  "size": 222000,
  "language": "JavaScript",
  "topics": ["react", "javascript", "frontend", "ui"],
  "license": { "name": "MIT License", "spdxId": "MIT" },
  "isPrivate": false,
  "isFork": false,
  "isArchived": false,
  "isTemplate": false,
  "defaultBranch": "main",
  "createdAt": "2013-05-24T16:15:54Z",
  "updatedAt": "2024-01-15T12:00:00Z",
  "pushedAt": "2024-01-15T11:59:00Z",
  "readme": "# React\n\nThe library for web and native user interfaces...",
  "recentIssues": [
    {
      "id": 123456,
      "number": 28000,
      "title": "Bug: ...",
      "state": "open",
      "url": "https://github.com/facebook/react/issues/28000",
      "author": "someuser",
      "labels": ["bug", "needs triage"],
      "comments": 5,
      "createdAt": "2024-01-10T10:00:00Z",
      "body": "..."
    }
  ],
  "latestRelease": {
    "id": 789,
    "tagName": "v18.3.0",
    "name": "18.3.0",
    "isDraft": false,
    "isPrerelease": false,
    "url": "...",
    "publishedAt": "2024-01-01T00:00:00Z",
    "body": "## Changes..."
  },
  "releases": [...],
  "topContributors": [
    { "login": "gaearon", "contributions": 3500, "avatarUrl": "...", "type": "User" }
  ]
}
```

## Data Source

GitHub REST API: `GET https://api.github.com/repos/{owner}/{repo}`
