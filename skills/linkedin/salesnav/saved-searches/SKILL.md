---
name: salesnav-saved-searches
description: "List, run, and delete Sales Navigator saved searches (both lead and account types)."
---

# salesnav-saved-searches

List, run, and delete Sales Navigator saved searches (both lead and account types).

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp skill] (only for `auth` step)
- LinkedIn Sales Navigator subscription

## Setup

One-time authentication (requires Chrome with Sales Navigator open):

```bash
node salesnav-saved-searches.mjs auth
```

## Usage

```bash
# List saved lead searches (default)
node salesnav-saved-searches.mjs list

# List saved account searches
node salesnav-saved-searches.mjs list --type=account

# Run a saved lead search
node salesnav-saved-searches.mjs run 12345

# Run a saved account search
node salesnav-saved-searches.mjs run 12345 --type=account

# Run with pagination
node salesnav-saved-searches.mjs run 12345 --count=50 --start=0

# Run saved lead search + fetch full profiles in one step
node salesnav-saved-searches.mjs run-profiles 12345

# Delete a saved search
node salesnav-saved-searches.mjs delete 12345
```

## How it works

1. **auth** — Connects to Chrome via CDP, extracts LinkedIn cookies and CSRF token from a Sales Navigator tab, saves them to `session.json`.
2. **list** — Calls `salesApiSavedSearchesV2` with `q=savedPeopleSearches` or `q=savedCompanySearches` to retrieve all saved searches with metadata (name, new hits count, filters, keywords).
3. **run** — Executes a saved search via `salesApiLeadSearch` (leads) or `salesApiAccountSearch` (accounts) using `q=savedSearchId`. Supports pagination with `--start` and `--count`.
4. **run-profiles** — Runs a saved lead search, then batch-fetches full profiles via `salesApiProfiles` (max 25 per batch) with the full decoration string (positions, education, skills, contact info, etc.).
5. **delete** — Sends a DELETE request to `salesApiSavedSearchesV2/<id>`.

## Data storage

```
~/.local/share/showrun/data/salesnav-saved-searches/
  session.json                          Auth cookies + CSRF token
  cache/
    saved-searches-lead.json            Cached list of saved lead searches
    saved-searches-account.json         Cached list of saved account searches
    run-lead-<id>.json                  Lead search results
    run-account-<id>.json               Account search results
    run-profiles-<id>.json              Lead search results with full profiles
```

## Session expiry

If you get a 401 or 403 error, re-run the auth command:

```bash
node salesnav-saved-searches.mjs auth
```

LinkedIn sessions typically last several hours. You must have a Sales Navigator tab open in Chrome when running `auth`.
