# Pinterest Scraper Skills

Scrapes Pinterest pins by keyword search. No login required for public search.

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Search](pinterest-search/SKILL.md) | `pinterest-search/scripts/pinterest-search.mjs` | Search Pinterest for pins by keyword |

## Data Available Without Login

- Pin images (multiple sizes: 170x, 236x, 474x, 736x, orig)
- Pin description and auto-generated alt text
- Pinner username and full name
- Board name and pin count
- External link and domain
- Reaction counts
- Created date
- Pin URL

## Authentication

Pinterest shows a "login to see more" banner but still returns data for anonymous users.
For more data, set `PT_COOKIES` env var to a JSON array of Pinterest cookies.

## Package Setup

```bash
# node_modules symlink already set up
ls node_modules/camoufox-js  # should exist
```
