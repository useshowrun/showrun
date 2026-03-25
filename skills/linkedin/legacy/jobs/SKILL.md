# linkedin-jobs

Search LinkedIn jobs, view full details with premium insights, save/unsave jobs, and manage your saved job collections — all from the terminal.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/anthropics/claude-code) skill (only for `auth` step)

## Setup

One-time authentication — extracts session cookies from any open LinkedIn tab:

```bash
node scripts/linkedin-jobs.mjs auth
```

## Usage

### Search for jobs

```bash
# Basic keyword search
node scripts/linkedin-jobs.mjs search --keywords="software engineer"

# With location
node scripts/linkedin-jobs.mjs search --keywords="data scientist" --location="New York"

# With filters
node scripts/linkedin-jobs.mjs search --keywords="devops" --remote=2 --date-posted=r604800

# At a specific company (use company ID from linkedin-company)
node scripts/linkedin-jobs.mjs search --keywords="engineer" --company=1441
```

### View full job details

```bash
node scripts/linkedin-jobs.mjs details 4344479011
```

Returns job title, company, location, salary, full description, applicant insights (count, top degrees, top skills), company info, company insights (Premium), hiring team, and How You Fit analysis.

### Save / unsave a job

```bash
node scripts/linkedin-jobs.mjs save 4344479011
node scripts/linkedin-jobs.mjs unsave 4344479011
```

### List saved jobs

```bash
# Saved tab (default)
node scripts/linkedin-jobs.mjs saved

# Other tabs
node scripts/linkedin-jobs.mjs saved --tab=in-progress
node scripts/linkedin-jobs.mjs saved --tab=applied
node scripts/linkedin-jobs.mjs saved --tab=archived
```

### Show help

```bash
node scripts/linkedin-jobs.mjs
```

## Search filters

All filters from LinkedIn's "All Filters" panel are supported:

### Text & location
| Flag | Values | Description |
|------|--------|-------------|
| `--keywords` | free text | Search terms |
| `--location` | free text | Location name |
| `--sort` | `DD`, `R` | Most recent, Most relevant |
| `--count` | number | Results per page (default 25) |
| `--start` | number | Offset for pagination |

### Multi-value filters (comma-separated)
| Flag | Values | Description |
|------|--------|-------------|
| `--date-posted` | `r86400`, `r604800`, `r2592000` | Past 24h, week, month |
| `--experience` | `1`-`6` | 1=Internship 2=Entry 3=Associate 4=Mid-Senior 5=Director 6=Executive |
| `--job-type` | `F`,`P`,`C`,`T`,`V`,`I`,`O` | Full-time, Part-time, Contract, Temporary, Volunteer, Internship, Other |
| `--remote` | `1`, `2`, `3` | 1=On-site 2=Remote 3=Hybrid |
| `--company` | numeric IDs | Company ID(s) from linkedin-company |
| `--industry` | numeric IDs | 4=Software Dev, 6=Tech, 96=IT Services, 43=Finance, 24=Hardware |
| `--function` | codes | `eng`=Engineering, `it`=IT, `rsch`=Research, `qa`=QA, `cnsl`=Consulting, `anls`=Analyst, `edu`=Education |
| `--title` | numeric IDs | 9=SWE, 39=Senior SWE, 1586=Staff SWE, 30128=AI Engineer, 25206=MLE |
| `--salary` | `1`-`9` | 1=$40k+ 2=$60k+ 3=$80k+ 4=$100k+ 5=$120k+ 6=$140k+ 7=$160k+ 8=$180k+ 9=$200k+ |
| `--benefits` | numeric IDs | 1=Medical, 2=Vision, 3=Dental, 4=401k, 5=Pension, 7=Maternity, 8=Paternity, 9=Commuter |
| `--commitments` | numeric IDs | 1=DEI, 2=Environment, 3=Work-life, 4=Social impact, 5=Career growth |

### Toggle filters (no value needed)
| Flag | Description |
|------|-------------|
| `--easy-apply` | Easy Apply jobs only |
| `--under-10` | Under 10 applicants |
| `--in-network` | People in your network |
| `--verified` | Has verifications |
| `--fair-chance` | Fair Chance Employer |

## How it works

1. **`auth`** — Extracts LinkedIn cookies via CDP `Network.getCookies`.

2. **`search`** — Calls `voyagerJobsDashJobCards` with RESTLI query filters. Returns job title, company, location, salary range, and direct link.

3. **`details`** — Makes 7 parallel GraphQL calls to `voyagerJobsDashJobPostingDetailSections` for different card types:
   - `TOP_CARD` — title, company, location, workplace type
   - `JOB_DESCRIPTION_CARD` — full description text, posted date
   - `JOB_APPLICANT_INSIGHTS` — applicant count, top degrees, top skills (Premium)
   - `COMPANY_CARD` — company info, industry, size
   - `COMPANY_INSIGHTS_CARD` — headcount growth, hiring trends (Premium)
   - `HIRING_TEAM_CARD` — hiring team members with profile links
   - `SALARY_CARD` + `BENEFITS_CARD` — compensation and benefits data

4. **`save`/`unsave`** — POST to `voyagerFeedDashSaveStates` with `{"patch":{"$set":{"saved":true/false}}}`.

5. **`saved`** — Calls `voyagerSearchDashClusters` with `SEARCH_MY_ITEMS_JOB_SEEKER` intent variants for each tab (saved, in-progress, applied, archived).

## Data storage

```
~/.local/share/showrun/data/linkedin-jobs/
├── session.json                    # Auth cookies & CSRF token
└── cache/
    ├── search-<query>.json         # Search results
    ├── job-<id>.json               # Full job details
    ├── saved-jobs.json             # Saved jobs list
    ├── in-progress-jobs.json       # In-progress jobs
    ├── applied-jobs.json           # Applied jobs
    └── archived-jobs.json          # Archived jobs
```

## Session expiry

If you see `Session expired`, open LinkedIn in Chrome and re-run:

```bash
node scripts/linkedin-jobs.mjs auth
```
