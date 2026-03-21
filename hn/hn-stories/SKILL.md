# Hacker News Stories Scraper

Fetch stories, comments, and jobs from Hacker News using the official Firebase API and Algolia search.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/hn

# Top stories (default)
node hn-stories/scripts/hn-stories.mjs --max 30

# New stories
node hn-stories/scripts/hn-stories.mjs --type new --max 20

# Best stories
node hn-stories/scripts/hn-stories.mjs --type best --max 50

# Ask HN
node hn-stories/scripts/hn-stories.mjs --type ask --max 15

# Show HN
node hn-stories/scripts/hn-stories.mjs --type show --max 15

# Job postings (from HN)
node hn-stories/scripts/hn-stories.mjs --type job --max 20

# Search by keyword
node hn-stories/scripts/hn-stories.mjs --query "openai" --max 20

# Search by date (most recent first)
node hn-stories/scripts/hn-stories.mjs --query "rust" --sort date --max 30

# Filter by score
node hn-stories/scripts/hn-stories.mjs --type top --min-score 500 --max 10

# Include comments (top-level)
node hn-stories/scripts/hn-stories.mjs --type ask --max 5 --comments --max-comments 5

# Filter by date range
node hn-stories/scripts/hn-stories.mjs --query "machine learning" --since 2026-01-01 --until 2026-03-01 --max 20
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--type <type>` | `top` | Story feed: `top`, `new`, `best`, `ask`, `show`, `job` |
| `--max <N>` | 30 | Max stories to return |
| `--query <text>` | (none) | Keyword search (Algolia API) |
| `--sort relevance\|date` | `relevance` | Sort for search results |
| `--tags <tag>` | `story` | Algolia tag filter: `story`, `comment`, `ask_hn`, `show_hn`, `job` |
| `--comments` | false | Include top-level comments for each story |
| `--max-comments <N>` | 10 | Max comments per story |
| `--min-score <N>` | (none) | Minimum score/points filter |
| `--since <YYYY-MM-DD>` | (none) | Filter stories after this date |
| `--until <YYYY-MM-DD>` | (none) | Filter stories before this date |

## Output Format

```json
{
  "type": "search",
  "query": "openai",
  "sort": "relevance",
  "filters": { "minScore": null, "since": null, "until": null },
  "totalLoaded": 20,
  "stories": [
    {
      "id": 47460525,
      "type": "story",
      "title": "OpenCode – Open source AI coding agent",
      "url": "https://opencode.ai/",
      "hnUrl": "https://news.ycombinator.com/item?id=47460525",
      "externalUrl": "https://opencode.ai/",
      "author": "rbanffy",
      "score": 873,
      "commentCount": 399,
      "commentIds": [47462013, 47463880, "..."],
      "text": null,
      "createdAt": "2026-03-20T21:03:52.000Z",
      "timestamp": 1774040632,
      "dead": false,
      "deleted": false,
      "comments": [
        {
          "id": 47462013,
          "parent": 47460525,
          "author": "logicprog",
          "text": "OpenCode was the first open source agent I used...",
          "createdAt": "2026-03-20T23:13:53.000Z",
          "timestamp": 1774048033,
          "replyCount": 26
        }
      ]
    }
  ],
  "scrapedAt": "2026-03-21T12:00:00.000Z"
}
```

## Data Schema

| Field | Description |
|-------|-------------|
| `id` | HN item ID (numeric) |
| `type` | `story`, `comment`, `job`, `ask`, `show` |
| `title` | Story/job title |
| `url` | Direct URL (external or HN item page for Ask/Show HN) |
| `hnUrl` | HN discussion page URL |
| `externalUrl` | External URL (null for Ask/Show HN stories) |
| `author` | Story author's HN username |
| `score` | Upvote points |
| `commentCount` | Total comment count (includes all nested replies) |
| `commentIds` | Array of top-level comment IDs |
| `text` | Story text (for Ask/Show HN and jobs) — HTML stripped |
| `createdAt` | ISO timestamp |
| `dead` | True if story was killed by HN moderation |
| `deleted` | True if story was deleted |
| `comments` | Array of comment objects (when `--comments` flag is used) |

## Technical Notes

- **No authentication needed** — both APIs are fully public
- **No rate limits** for reasonable use (HN Firebase API is official)
- **Parallel fetching** with 10-15 concurrent connections for speed
- **No browser required** — pure HTTP/HTTPS with Node.js built-ins
- Firebase API data is authoritative; Algolia adds full-text search
- `--comments` only fetches top-level comments (not nested replies)
- For Ask/Show HN, the URL is the HN discussion page (no external URL)
- Job posts from `/job` type don't have scores (always 1)
