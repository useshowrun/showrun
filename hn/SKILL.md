# Hacker News Agent Browser Skills

Scrape stories, comments, and job listings from Hacker News.

## Key Insight

Hacker News has TWO free, no-auth APIs:
1. **Official Firebase API** (`hacker-news.firebaseio.com`) — exact story IDs for top/new/best/ask/show/job feeds, with full item details
2. **Algolia HN Search API** (`hn.algolia.com`) — full-text search with filtering by date, score, and type

Neither requires authentication. No bot detection.

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Stories](hn-stories/SKILL.md) | `hn-stories/scripts/hn-stories.mjs` | Fetch top/new/best/ask/show/job stories, search, include comments |

## Typical Workflow

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/hn

# Top stories
node hn-stories/scripts/hn-stories.mjs --max 30

# Search by keyword
node hn-stories/scripts/hn-stories.mjs --query "openai" --max 20

# Ask HN with comments
node hn-stories/scripts/hn-stories.mjs --type ask --max 10 --comments
```

## No Dependencies

Uses only Node.js built-in modules (`https`, `url`). No npm install needed.
