---
name: linkedin-company
description: "Fetch LinkedIn company page data from the terminal — overview, funding, locations, jobs, employees, and posts. No browser needed after initial auth."
---

# linkedin-company

Fetch LinkedIn company page data from the terminal — overview, funding, locations, jobs, employees, and posts. No browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/anthropics/claude-code) skill (only for `auth` step)

## Setup

One-time authentication — extracts session cookies from any open LinkedIn tab:

```bash
node scripts/linkedin-company.mjs auth
```

## Usage

### Fetch company info

```bash
# By universal name (URL slug)
node scripts/linkedin-company.mjs view google

# By LinkedIn URL
node scripts/linkedin-company.mjs view https://linkedin.com/company/google/

# By company ID
node scripts/linkedin-company.mjs view 1441
```

### Fetch job listings

```bash
node scripts/linkedin-company.mjs jobs google
node scripts/linkedin-company.mjs jobs google --count=25 --start=0
```

### Fetch employees and decision makers

```bash
node scripts/linkedin-company.mjs people google
node scripts/linkedin-company.mjs people google --count=12 --start=0
```

### Fetch company posts

```bash
node scripts/linkedin-company.mjs posts google
node scripts/linkedin-company.mjs posts google --count=10
```

### Show help

```bash
node scripts/linkedin-company.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts LinkedIn cookies using `Network.getCookies`, saves session to disk.

2. **`view`** — Calls `organization/companies` with `WebFullCompanyMain-35` decoration. Returns comprehensive company data:
   - Name, tagline, description, website
   - Industry, company type, founded year
   - Employee count, staff count range
   - Headquarters and all confirmed office locations
   - Specialties and associated hashtags
   - Funding data (rounds, amounts, lead investors — via Crunchbase integration)
   - Affiliated/subsidiary companies
   - Logo URL

3. **`jobs`** — Calls `voyagerJobsDashJobCards` with company filter. Returns job title, location, salary range (when available), and direct posting link. Supports pagination for companies with thousands of listings.

4. **`people`** — Uses `voyagerSearchDashClusters` with `ORGANIZATIONS_PEOPLE_ALUMNI` intent to list current employees (name, headline, location, profile URL). Also calls `voyagerIdentityDashProfiles?q=decisionMakers` to identify key decision makers at the company.

5. **`posts`** — Fetches the company's feed via GraphQL `voyagerFeedDashOrganizationalPageUpdates`. Returns post text with engagement metrics (likes, comments, shares).

## Data storage

```
~/.local/share/showrun/data/linkedin-company/
├── session.json                    # Auth cookies & CSRF token
└── cache/
    ├── company-<slug>.json         # Formatted company data
    ├── company-raw-<slug>.json     # Raw API response
    ├── jobs-<slug>.json            # Job listings
    ├── people-<slug>.json          # Employees & decision makers
    └── posts-<slug>.json           # Company posts
```

## Notes

- **Insights tab** requires LinkedIn Premium and is not available via the standard API.
- **Jobs** uses `geoId:92000000` (worldwide) by default. The raw endpoint supports location filtering.
- **People** results are influenced by your network — you'll see connections and 2nd-degree contacts first.

## Session expiry

If you see `Session expired`, open LinkedIn in Chrome and re-run:

```bash
node scripts/linkedin-company.mjs auth
```
