# salesnav-lead-search

Run ad-hoc Sales Navigator lead searches with all 33+ filter types, fetch full profiles, and export results as JSON.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp skill] (only for `auth` step)
- LinkedIn Sales Navigator subscription

## Setup

One-time auth -- extracts session cookies from an open Sales Navigator tab:

```bash
node salesnav-lead-search.mjs auth
```

## Usage

### Search leads

```bash
# Basic search with title and company size
node salesnav-lead-search.mjs search --title="CTO" --headcount="E,F,G"

# Multi-filter search
node salesnav-lead-search.mjs search --company="Microsoft" --seniority="VP,CXO" --region="San Francisco Bay Area"

# Keyword search with industry and experience
node salesnav-lead-search.mjs search --keyword="machine learning" --industry="Technology" --years-experience="6-10"

# Exclusions
node salesnav-lead-search.mjs search --title="VP Engineering" --company="Stripe" --exclude-company="Google"

# Toggle filters (recently changed jobs, posted on LinkedIn)
node salesnav-lead-search.mjs search --changed-jobs --seniority="CXO" --headcount="G,H,I"

# Postal code with radius
node salesnav-lead-search.mjs search --postal-code="94105" --radius=25 --title="Engineering Manager"

# Pagination
node salesnav-lead-search.mjs search --title="CTO" --start=25 --count=25
```

### Show all filters

```bash
node salesnav-lead-search.mjs filters
```

### Fetch full profiles

```bash
# By Sales Nav profile IDs (comma-separated, max 25 per batch)
node salesnav-lead-search.mjs profiles ACwAABJVBJEB1234,ACwAABJVBJEB5678

# Also accepts URN formats
node salesnav-lead-search.mjs profiles "urn:li:fsd_profile:ACoAABJVBJEB..."
```

### Search + fetch profiles in one step

```bash
# Searches all pages, then fetches full profile data for every result
node salesnav-lead-search.mjs search-profiles --title="VP Engineering" --headcount="D,E"

# Limit max results
node salesnav-lead-search.mjs search-profiles --title="CTO" --headcount="E,F" --max=50
```

## All 33+ Filter Types

### Company group
| Flag | Filter Type | Notes |
|------|-------------|-------|
| `--company="Microsoft"` | CURRENT_COMPANY | typeahead, multi, supports `--exclude-company` |
| `--headcount="B,C,D"` | COMPANY_HEADCOUNT | B=1-10, C=11-50, D=51-200, E=201-500, F=501-1000, G=1001-5000, H=5001-10000, I=10001+ |
| `--past-company="Google"` | PAST_COMPANY | typeahead, multi, supports `--exclude-past-company` |
| `--company-type="PUBLIC"` | COMPANY_TYPE | multi |
| `--company-hq="United States"` | COMPANY_HEADQUARTERS | typeahead, multi, supports `--exclude-company-hq` |

### Role group
| Flag | Filter Type | Notes |
|------|-------------|-------|
| `--function="Engineering"` | FUNCTION | multi |
| `--title="CTO,VP Engineering"` | CURRENT_TITLE | multi |
| `--seniority="VP,CXO"` | SENIORITY_LEVEL | multi |
| `--past-title="Software Engineer"` | PAST_TITLE | multi |
| `--years-at-company="1-2,3-5"` | YEARS_AT_CURRENT_COMPANY | multi |
| `--years-in-position="1-2,3-5"` | YEARS_IN_CURRENT_POSITION | multi |

### Personal group
| Flag | Filter Type | Notes |
|------|-------------|-------|
| `--region="San Francisco Bay Area"` | REGION | typeahead, multi, supports `--exclude-region` |
| `--postal-code="94105"` | POSTAL_CODE | use with `--radius=25` |
| `--industry="Technology"` | INDUSTRY | multi |
| `--first-name="John"` | FIRST_NAME | text |
| `--last-name="Smith"` | LAST_NAME | text |
| `--profile-language="en,es"` | PROFILE_LANGUAGE | multi |
| `--years-experience="5-10"` | YEARS_OF_EXPERIENCE | multi |
| `--group="..."` | GROUP | multi |
| `--school="Stanford"` | SCHOOL | multi |

### Buyer Intent group
| Flag | Filter Type | Notes |
|------|-------------|-------|
| `--follows-company` | FOLLOWS_YOUR_COMPANY | toggle |
| `--viewed-profile` | VIEWED_YOUR_PROFILE | toggle |

### Best Path In group
| Flag | Filter Type | Notes |
|------|-------------|-------|
| `--relationship="F,S"` | RELATIONSHIP | F=1st, S=2nd |
| `--connection-of="..."` | CONNECTION_OF | typeahead |
| `--past-colleague` | PAST_COLLEAGUE | toggle |
| `--shared-experiences` | WITH_SHARED_EXPERIENCES | toggle |

### Recent Updates group
| Flag | Filter Type | Notes |
|------|-------------|-------|
| `--changed-jobs` | RECENTLY_CHANGED_JOBS | toggle |
| `--posted-on-linkedin` | POSTED_ON_LINKEDIN | toggle |

### Workflow group
| Flag | Filter Type | Notes |
|------|-------------|-------|
| `--persona="..."` | PERSONA | typeahead |
| `--account-list="..."` | ACCOUNT_LIST | multi |
| `--lead-list="..."` | LEAD_LIST | multi |
| `--in-crm="..."` | LEADS_IN_CRM | multi |
| `--interacted-with="..."` | LEAD_INTERACTIONS | multi |
| `--saved="..."` | SAVED_LEADS_AND_ACCOUNTS | multi |

## How it works

1. **auth** -- Uses CDP to find an open Sales Navigator tab in Chrome, extracts `li_at` + `JSESSIONID` cookies, saves them to `session.json`.
2. **search** -- Builds a RESTLI query string from CLI flags with the correct filter format (`type:FILTER_TYPE,values:List((id:...,text:...,selectionType:INCLUDED|EXCLUDED))`), calls `salesApiLeadSearch` with `decorationId=LeadSearchResult-16`.
3. **filters** -- Prints all 33+ filter types with usage examples.
4. **profiles** -- Calls `salesApiProfiles` in batches of 25 with the full decoration string to fetch positions, education, skills, contact info, etc.
5. **search-profiles** -- Combines search (with full pagination and 3-5s rate-limit delays) and profile fetch into one command.

## Data storage

```
~/.local/share/showrun/data/salesnav-lead-search/
  session.json                          Auth cookies + CSRF token
  cache/
    search-<slug>-<timestamp>.json      Search results
    profiles-<timestamp>.json           Profile data
    search-profiles-<slug>-<ts>.json    Combined search+profile data
```

## Session expiry

If you get 401/403 errors, re-run:

```bash
node salesnav-lead-search.mjs auth
```

Sessions typically last several hours. Keep a Sales Navigator tab open in Chrome for re-auth.
