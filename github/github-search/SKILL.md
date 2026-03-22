# github-search

Search GitHub for repositories or users by keyword. Returns ranked results with metadata.

## Usage

```bash
node github-search.mjs <query> [options]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<query>` | Search keyword or GitHub search query (required) |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--type repos\|users` | `repos` | What to search for |
| `--sort stars\|forks\|updated\|best-match` | `stars` | Sort order |
| `--max N` | `30` | Maximum results (max: 100) |
| `--lang <language>` | — | Filter by programming language (repos only) |

## Examples

```bash
# Search for popular React repos
node github-search.mjs "react"

# Machine learning repos in Python
node github-search.mjs "machine learning" --lang python --max 20

# Vim config repos sorted by recent activity
node github-search.mjs "vim config" --sort updated

# Search for users
node github-search.mjs "linus torvalds" --type users

# GitHub search syntax
node github-search.mjs "react stars:>10000 language:javascript"
```

## Output

```json
{
  "query": "react",
  "type": "repos",
  "sort": "stars",
  "totalCount": 542000,
  "incompleteResults": false,
  "returnedCount": 30,
  "results": [
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
      "topics": ["declarative", "frontend", "javascript", "library", "react", "ui"],
      "license": { "name": "MIT License", "spdxId": "MIT" },
      "isPrivate": false,
      "isFork": false,
      "isArchived": false,
      "isTemplate": false,
      "defaultBranch": "main",
      "createdAt": "2013-05-24T16:15:54Z",
      "updatedAt": "2024-01-15T12:00:00Z",
      "pushedAt": "2024-01-15T11:59:00Z",
      "score": 1.0
    }
  ]
}
```

## Data Source

GitHub Search API: `GET https://api.github.com/search/repositories?q=<query>&sort=stars&per_page=30`
