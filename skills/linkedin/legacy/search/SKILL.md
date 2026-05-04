---
name: linkedin-search
description: "Search LinkedIn for people, companies, groups, schools, events, products, or services by keyword."
---

# linkedin-search

Search LinkedIn for people, companies, groups, schools, events, products, or services by keyword.

## Prerequisites

- Node.js 22+
- If CDP connection fails during `auth`, launch Chrome yourself with `https://www.linkedin.com` as the initial URL (see chrome-cdp agent guidance)
- If Chrome is already running via CDP but no LinkedIn tab is open: `node skills/chrome-cdp/scripts/cdp.mjs open https://www.linkedin.com`
- If the user is not logged in to LinkedIn, ask them to log in in the Chrome window, then re-run `auth`

## Setup

```bash
node linkedin-search.mjs auth
```

## Usage

```bash
# Search people (default)
node linkedin-search.mjs search "machine learning"

# Search companies
node linkedin-search.mjs search "devtools" --type=COMPANIES

# Pagination
node linkedin-search.mjs search "site reliability engineer" --count=25 --page=2
```

Valid types: `PEOPLE`, `COMPANIES`, `GROUPS`, `SCHOOLS`, `EVENTS`, `PRODUCTS`, `SERVICES`, `POSTS`

## Output

For each result: name, headline/subtitle, location, profile/page URL, and connection degree (for people).

## Session expiry

Re-run `auth` on 401/403 errors.
