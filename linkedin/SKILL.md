# LinkedIn Agent Browser Skills

Scrape public LinkedIn data: person profiles, company pages, and job listings.
No authentication required for public data (limited). Full data requires LinkedIn session cookies.

## Prerequisites

### Node.js 22+
```bash
nvm use 24
```

### Install Dependencies
```bash
cd linkedin && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Profile](linkedin-profile/SKILL.md) | `linkedin-profile/scripts/linkedin-profile.mjs` | Scrape a person's LinkedIn profile |
| [Company](linkedin-company/SKILL.md) | `linkedin-company/scripts/linkedin-company.mjs` | Scrape a LinkedIn company page |
| [Jobs](linkedin-jobs/SKILL.md) | `linkedin-jobs/scripts/linkedin-jobs.mjs` | Search LinkedIn job listings |

## Typical Workflow

```bash
# Person profile
node linkedin-profile/scripts/linkedin-profile.mjs williamhgates

# Company page
node linkedin-company/scripts/linkedin-company.mjs microsoft

# Job search
node linkedin-jobs/scripts/linkedin-jobs.mjs "software engineer" "United States" --max 25
node linkedin-jobs/scripts/linkedin-jobs.mjs "product manager" "Remote" --remote --max 10
```

## Authentication (Optional)

LinkedIn shows limited data to logged-out users:
- Person profiles: name, headline, location, about, up to 3 experience entries, education, recent articles
- Company pages: full company info (description, industry, size, headquarters, locations)
- Job search: all public job listings with title, company, location, posted date

For **full profile data** (skills, recommendations, connections, full experience list), you need cookies.

### Setting up cookies

1. Log into LinkedIn in your browser (Chrome/Firefox)
2. Export cookies via a browser extension (e.g. "Cookie-Editor")
3. Save as JSON array: `export LI_COOKIES='[{"name":"li_at","value":"...","domain":".linkedin.com",...}]'`
4. Run any script with that env var set

Required cookies: `li_at` (session token), `JSESSIONID` (CSRF token)

## Anti-bot Notes

- LinkedIn uses Cloudflare + bot detection but public pages work fine with camoufox
- Rate limiting: wait 2-3 seconds between requests (enforced automatically)
- Do NOT make rapid parallel requests — LinkedIn will rate-limit the IP
- Job search: 25 results per page; use --start N for pagination
- Person profiles: full profile available only after login (some section data limited)

## Output Format

All scripts write structured output to stdout as `RESULT:{json}`.
Logs go to stderr. Parse results by reading lines starting with `RESULT:` from stdout.

## Data Limitations (Logged-Out)

| Data | Without Login | With Login |
|------|--------------|------------|
| Person name | ✅ Full | ✅ Full |
| Person headline | ✅ Full | ✅ Full |
| Person about | ✅ Full | ✅ Full |
| Experience | ⚠️ First 3 entries | ✅ All |
| Education | ⚠️ Partial | ✅ All |
| Skills | ❌ Hidden | ✅ Available |
| Connections | ❌ Hidden | ✅ Mutual |
| Contact info | ❌ Hidden | ✅ Available |
| Company data | ✅ Full | ✅ Full |
| Job listings | ✅ All public | ✅ All public |
| Job description | ✅ Full | ✅ Full |
