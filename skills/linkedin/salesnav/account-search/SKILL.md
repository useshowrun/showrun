---
name: salesnav-account-search
description: "Run ad-hoc Sales Navigator account/company searches with all 15+ filter types via the LinkedIn Sales API."
---

# salesnav-account-search

Run ad-hoc Sales Navigator account/company searches with all 15+ filter types via the LinkedIn Sales API.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled, and a logged-in `www.linkedin.com/sales/...` tab kept open
- [chrome-cdp skill]
- LinkedIn Sales Navigator subscription

Requests run **inside your Chrome tab** (via CDP), not from Node — this is what lets them past LinkedIn's `sales-api` edge. So a Sales Navigator tab must stay open for **every** command, not just `auth`. If no `/sales/` tab is open, open one (see chrome-cdp "Agent guidance"): `node skills/chrome-cdp/scripts/cdp.mjs open https://www.linkedin.com/sales/home`.

## Setup

One-time auth — open Sales Navigator in Chrome, then:

```bash
node salesnav-account-search.mjs auth
```

## Usage

### Search accounts

```bash
# Search by industry and headcount
node salesnav-account-search.mjs search --industry="Technology" --headcount="E,F,G"

# Search by revenue and headquarters
node salesnav-account-search.mjs search --revenue="3,4,5" --hq-region="United States"

# Search Fortune 500 companies with job openings
node salesnav-account-search.mjs search --fortune="1,2,3,4" --job-opportunities

# Free-text keyword search with pagination
node salesnav-account-search.mjs search --keyword="artificial intelligence" --count=50 --start=0

# Postal code search with radius
node salesnav-account-search.mjs search --hq-postal="94105" --radius=25

# Combine multiple filters
node salesnav-account-search.mjs search --industry="Technology" --headcount="F,G" --revenue="5,6" --activities="RFE"
```

### Show all filter types

```bash
node salesnav-account-search.mjs filters
```

## All Filter Types

**Company Attributes:**
| Flag | API Filter | Type | Values |
|------|-----------|------|--------|
| `--revenue` | ANNUAL_REVENUE | RANGE_DROPDOWN | 1=<$1M, 2=$1M-$10M, 3=$10M-$50M, 4=$50M-$100M, 5=$100M-$500M, 6=$500M-$1B, 7=$1B-$10B, 8=$10B+ |
| `--headcount` | COMPANY_HEADCOUNT | MULTI_SELECT | B=1-10, C=11-50, D=51-200, E=201-500, F=501-1000, G=1001-5000, H=5001-10000, I=10001+ |
| `--headcount-growth` | COMPANY_HEADCOUNT_GROWTH | RANGE_TEXT | "min-max" percentage (e.g. "5-20") |
| `--hq-region` | REGION | MULTI_SELECT | Region name text (e.g. "United States") |
| `--hq-postal` | POSTAL_CODE | MULTI_SELECT | Postal code with `--radius` in miles |
| `--industry` | INDUSTRY | MULTI_SELECT | Industry name text (e.g. "Technology") |
| `--followers` | NUM_OF_FOLLOWERS | MULTI_SELECT | NFR1=1-500, NFR2=501-1000, NFR3=1001-5000, NFR4=5001-10000, NFR5=10001+ |
| `--dept-headcount` | DEPARTMENT_HEADCOUNT | RANGE_TEXT | "min-max" (e.g. "10-50") |
| `--dept-growth` | DEPARTMENT_HEADCOUNT_GROWTH | RANGE_TEXT | "min-max" percentage |
| `--fortune` | FORTUNE | MULTI_SELECT | 1=Fortune50, 2=51-100, 3=101-250, 4=251-500 |

**Spotlights:**
| Flag | API Filter | Type | Values |
|------|-----------|------|--------|
| `--job-opportunities` | JOB_OPPORTUNITIES | TOGGLE | No value needed |
| `--activities` | ACCOUNT_ACTIVITIES | MULTI_SELECT | SLC=Senior leadership changes, RFE=Funding events |
| `--relationship` | RELATIONSHIP | MULTI_SELECT | F=First degree, S=Second degree, O=Third+ |

**Workflow:**
| Flag | API Filter | Type | Values |
|------|-----------|------|--------|
| `--in-crm` | ACCOUNTS_IN_CRM | TOGGLE | No value needed |
| `--saved` | SAVED_ACCOUNTS | TOGGLE | No value needed |
| `--account-list` | ACCOUNT_LIST | MULTI_SELECT | List ID(s) |

## How it works

1. **auth** — Uses CDP to find an open Sales Navigator tab, validates the session (`li_at` + `JSESSIONID`), and writes a marker `session.json`. Cookies stay in Chrome — every request runs in-page with `credentials:'include'`.
2. **search** — Builds a RESTLI filter query from CLI flags, calls `GET /sales-api/salesApiAccountSearch` in-page, returns company results with metadata.
3. **filters** — Prints all filter types with accepted values and usage examples.

## Data storage

```
~/.local/share/showrun/data/salesnav-account-search/
  session.json                 Session marker (cookies stay in Chrome)
  cache/
    search-<slug>-<ts>.json    Search result snapshots
```

## Session expiry

If you get 401/403 errors, re-run:

```bash
node salesnav-account-search.mjs auth
```
