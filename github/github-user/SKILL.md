# github-user

Get the public profile for a GitHub user or organization, with optional repository listing.

## Usage

```bash
node github-user.mjs <username-or-url> [options]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<username-or-url>` | GitHub username or profile URL (required) |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--include-repos` | — | Fetch the user's public repositories |
| `--max-repos N` | `30` | Max repos to return (max: 100) |

## Examples

```bash
# Basic profile
node github-user.mjs torvalds

# Organization profile with their repos
node github-user.mjs microsoft --include-repos --max-repos 20

# From a GitHub URL
node github-user.mjs https://github.com/gaearon --include-repos
```

## Output

```json
{
  "login": "torvalds",
  "name": "Linus Torvalds",
  "type": "User",
  "avatarUrl": "https://avatars.githubusercontent.com/u/1024025",
  "url": "https://github.com/torvalds",
  "bio": "Just for fun",
  "company": null,
  "location": "Portland, OR",
  "email": null,
  "blog": null,
  "publicRepos": 8,
  "publicGists": 0,
  "followers": 230000,
  "following": 0,
  "createdAt": "2011-09-03T15:26:22Z",
  "repos": [
    {
      "id": 2325298,
      "fullName": "torvalds/linux",
      "name": "linux",
      "description": "Linux kernel source tree",
      "stars": 180000,
      "forks": 54000,
      "language": "C",
      ...
    }
  ]
}
```

For organizations, additional fields are included:
- `description` — org description
- `membersUrl` — URL to list members

## Data Source

GitHub REST API:
- `GET https://api.github.com/users/{username}` — user profile
- `GET https://api.github.com/orgs/{org}` — org-specific details
- `GET https://api.github.com/users/{username}/repos` — public repos
