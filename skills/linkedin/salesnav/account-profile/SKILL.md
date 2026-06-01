---
name: salesnav-account-profile
description: "Fetch comprehensive Sales Navigator account/company profiles including Account IQ, employee insights, alerts, and relationship maps."
---

# salesnav-account-profile

Fetch comprehensive Sales Navigator account/company profiles including Account IQ, employee insights, alerts, and relationship maps.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled, and a logged-in `www.linkedin.com/sales/...` tab kept open
- [chrome-cdp skill]
- LinkedIn Sales Navigator subscription

Requests run **inside your Chrome tab** (via CDP), not from Node — this is what lets them past LinkedIn's `sales-api` edge. So a Sales Navigator tab must stay open for **every** command, not just `auth`. If no `/sales/` tab is open, open one (see chrome-cdp "Agent guidance"): `node skills/chrome-cdp/scripts/cdp.mjs open https://www.linkedin.com/sales/home`.

## Setup

One-time auth — open Sales Navigator in Chrome, then:

```bash
node salesnav-account-profile.mjs auth
```

## Usage

```bash
# Full company profile (all sections)
node salesnav-account-profile.mjs view 1035

# Specific sections only
node salesnav-account-profile.mjs view 1035 --sections=basic,iq,employees,alerts

# AI-generated Account IQ dossier (strategic priorities, competitors, revenue)
node salesnav-account-profile.mjs account-iq 1035

# Employee insights (total + functional headcount)
node salesnav-account-profile.mjs employees 1035

# Relationship maps
node salesnav-account-profile.mjs relationship-map 1035

# Entity alerts and signals
node salesnav-account-profile.mjs alerts 1035

# Similar / also-viewed companies
node salesnav-account-profile.mjs similar 1035

# Notes on this account
node salesnav-account-profile.mjs notes 1035

# Buyer personas for this company
node salesnav-account-profile.mjs personas 1035
```

Company ID accepts numeric IDs (e.g., `1035`), `urn:li:fs_salesCompany:1035`, or `urn:li:organization:1035`.

## How it works

1. **auth** — Uses CDP to find an open Sales Navigator tab, validates the session (`li_at` + `JSESSIONID`), and writes a marker `session.json`. Cookies stay in Chrome — every request runs in-page with `credentials:'include'`.
2. **view** — Calls all sub-endpoints (basic company data, Account IQ, employee insights, alerts, similar companies, notes, personas, relationship maps) and merges into one JSON. Use `--sections` to fetch only specific sections. The basic company fetch is required; optional sections that fail (e.g. no Account IQ) are skipped with a warning. Sections are fetched sequentially since each in-page request blocks the next.
3. **account-iq** — Fetches the AI-generated Account IQ dossier with strategic priorities, competitive landscape, challenges, revenue details, and executive profiles. Returns null/warning for companies without IQ data.
4. **employees** — Fetches both TOTAL_HEADCOUNT and FUNCTIONAL_HEADCOUNT employee insight types.
5. **relationship-map** — Fetches relationship maps for the account.
6. **alerts** — Fetches entity alerts sorted by time.
7. **similar** — Fetches also-viewed/similar companies.
8. **notes** — Fetches all notes on the account.
9. **personas** — Fetches buyer personas configured for the company.

## Data storage

```
~/.local/share/showrun/data/salesnav-account-profile/
  session.json                  Session marker (cookies stay in Chrome)
  cache/
    company-<id>.json           Full view output (all sections)
    account-iq-<id>.json        Account IQ dossier
    employees-<id>.json         Employee insights
    relationship-map-<id>.json  Relationship maps
    alerts-<id>.json            Entity alerts
    similar-<id>.json           Similar companies
    notes-<id>.json             Account notes
    personas-<id>.json          Buyer personas
```

## Session expiry

If you get 401/403 errors, re-run `auth`:

```bash
node salesnav-account-profile.mjs auth
```
