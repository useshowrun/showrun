# crunchbase-advanced-search

Search across all Crunchbase entity types (companies, people, investors, funding rounds, acquisitions, schools, events) with full filter support.

## Prerequisites

- Node.js 22+
- If CDP connection fails during `auth`, launch Chrome yourself with `https://www.crunchbase.com` as the initial URL (see chrome-cdp agent guidance)
- If Chrome is already running via CDP but no Crunchbase tab is open: `node skills/chrome-cdp/scripts/cdp.mjs open https://www.crunchbase.com`
- If the user is not logged in to Crunchbase, ask them to log in in the Chrome window, then re-run `auth`

## Setup

```bash
node crunchbase-advanced-search.mjs auth
```

## Usage

```bash
# Search companies (default fields and sort)
node crunchbase-advanced-search.mjs search companies --count=10

# AI companies founded in the last year
node crunchbase-advanced-search.mjs search companies \
  --query='[{"type":"predicate","field_id":"categories","operator_id":"includes","values":["c4d8caf3-5fe7-359b-f9f2-2d708378e4ee"]},{"type":"predicate","field_id":"founded_on","operator_id":"gte","values":["365 days ago"]}]'

# Series A funding rounds over $10M
node crunchbase-advanced-search.mjs search funding_rounds \
  --query='[{"type":"predicate","field_id":"investment_type","operator_id":"includes","values":["series_a"]},{"type":"predicate","field_id":"money_raised","operator_id":"gte","values":[10000000]}]'

# Search investors
node crunchbase-advanced-search.mjs search investors --count=20

# Paginate using after-id from previous result
node crunchbase-advanced-search.mjs search companies --after-id=<last-uuid>

# List available fields
node crunchbase-advanced-search.mjs fields companies
```

## How it works

1. `auth` — Extracts cookies from your Chrome Crunchbase tab via CDP
2. `search` — POSTs to `/v4/data/searches/{collection_id}` with field_ids, query predicates, and pagination
3. `fields` — Fetches app metadata from `/v4/md/applications/crunchbase` to list all queryable fields

## Query filter format

Each filter is a predicate object:
```json
{
  "type": "predicate",
  "field_id": "categories",
  "operator_id": "includes",
  "values": ["artificial-intelligence"]
}
```

Available operators: `eq`, `not_eq`, `contains`, `not_contains`, `gte`, `lte`, `gt`, `lt`, `between`, `includes`, `not_includes`, `blank`, `not_blank`, `starts`, `domain_eq`

Date values support relative expressions: `"30 days ago"`, `"90 days ago"`, `"365 days ago"`, etc.

## Data storage

```
~/.local/share/showrun/data/crunchbase-advanced-search/
├── session.json     Auth cookies
└── cache/           Search result JSON files
```

## Session expiry

Sessions expire after ~24 hours. Re-run `auth` when you get 401/403 errors.
