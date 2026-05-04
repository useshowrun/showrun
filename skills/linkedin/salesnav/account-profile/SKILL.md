---
name: salesnav-account-profile
description: "Fetch comprehensive Sales Navigator account/company profiles including Account IQ, employee insights, alerts, and relationship maps."
---

# salesnav-account-profile

Fetch comprehensive Sales Navigator account/company profiles including Account IQ, employee insights, alerts, and relationship maps.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp skill] (only for `auth` step)
- LinkedIn Sales Navigator subscription

## Setup

One-time auth — extract session cookies from Chrome:

```bash
node salesnav-account-profile.mjs auth
```

Requires a Chrome tab open to `linkedin.com/sales`.

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

1. **auth** — Uses CDP to extract cookies and CSRF token from an open Sales Navigator tab in Chrome.
2. **view** — Calls all sub-endpoints in parallel (basic company data, Account IQ, employee insights, alerts, similar companies, notes, personas, relationship maps) and merges into one JSON. Use `--sections` to fetch only specific sections.
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
  session.json                  Auth cookies + CSRF token
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
