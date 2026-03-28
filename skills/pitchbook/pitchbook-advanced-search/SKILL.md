# pitchbook-advanced-search

Run advanced/screener searches on Pitchbook via a multi-step API flow. This skill automates the Pitchbook Advanced Search (screener) which requires creating a search session, running it, and then fetching paginated results.

## Commands

**Note:** The `search` command runs a default unfiltered search (11M+ companies). To search with filters, set criteria in the Pitchbook web UI first, copy the search ID from the URL, then use `results <searchId>` to fetch results programmatically.

### `auth`
Capture Pitchbook session cookies from a running Chrome instance via CDP.

```bash
node scripts/pitchbook-advanced-search.mjs auth
```

### `search`
Run a full default search. Executes the complete 6-step API flow: create session, run search, get metadata, get view, get count, fetch results.

```bash
node scripts/pitchbook-advanced-search.mjs search [--type=COMPANIES|DEALS|INVESTORS] [--page=1] [--page-size=25]
```

**Flags:**
- `--type` — Search type: `COMPANIES` (default), `DEALS`, or `INVESTORS`
- `--page` — Result page number (default: 1)
- `--page-size` — Results per page (default: 25, max: 250)

### `count`
Get the total result count for an existing search session.

```bash
node scripts/pitchbook-advanced-search.mjs count <searchId>
```

### `results`
Fetch paginated results for an existing search session. Useful when you have set up search criteria in the Pitchbook UI and want to pull results programmatically.

```bash
node scripts/pitchbook-advanced-search.mjs results <searchId> [--page=1] [--page-size=25] [--tab=companies|deals|investors]
```

**Flags:**
- `--page` — Result page number (default: 1)
- `--page-size` — Results per page (default: 25, max: 250)
- `--tab` — Result tab: `companies` (default), `deals`, or `investors`

## Multi-Step API Flow

The advanced search requires 6 sequential API calls with delays between each:

1. **Create search session** — `POST /searches?ignoreUserPreferences=true` with `entryPointKey` and `searchType`. Returns a `searchId` (e.g., `s637561838`).
2. **Run the search** — `POST /searches/{searchId}/run?resetTrigger=AS_CRITERIA&resetFilters=true`. Triggers server-side execution.
3. **Get search metadata** — `GET /searches/{searchId}`. Returns tab info and active tab.
4. **Get view** — `GET /views/{searchId}.{tabType}`. Returns the `dataSetId` (e.g., `{searchId}.company.data_set`).
5. **Get result count** — `GET /tables/{dataSetId}/entities/count`. Returns total matching entities.
6. **Fetch results** — `POST /tables/{dataSetId}/data?page=N&pageSize=M`. Returns paginated `dataRows`.

Each step is separated by a 6-second delay (~36 seconds total) to respect rate limits.

**Session expiry warning:** The 6-step search flow takes ~36 seconds. If your session is close to expiring, it may expire mid-flow (e.g., steps 1-5 succeed but step 6 fails with 401). If this happens, re-authenticate and use the `results <searchId>` command to resume fetching from the already-created search — no need to re-run the full flow.

Note: `--type` uses uppercase (`COMPANIES`, `DEALS`, `INVESTORS`) while `--tab` uses lowercase (`companies`, `deals`, `investors`).

## Important Notes

- A default search with no criteria returns ALL entities in Pitchbook (11M+ companies). For filtered results, set up criteria in the Pitchbook UI first, then use the `results` command with the `searchId` from the URL.
- The `searchId` can be found in the Pitchbook URL when viewing an advanced search (e.g., `https://my.pitchbook.com/search/companies?searchId=s637561838`).
- Results are saved to the cache directory as `advanced-search-<searchId>-p<page>.json`.

## Search Types

| Type | entryPointKey | searchType | Tab |
|------|--------------|------------|-----|
| COMPANIES | COMPANY | COMPANIES | companies |
| DEALS | DEAL | DEALS | deals |
| INVESTORS | INVESTOR | INVESTORS | investors |

## Result Structure

Each result row contains:
- `entityId` — Numeric entity ID
- `pbId` — Pitchbook ID (e.g., `896863-42`)
- `columnValues` — Object with fields like `companyName`, `description`, `hqCity`, `hqCountry`, `primaryIndustryCode`, `vcRaised`, `financingStatusNote`

## Examples

```bash
# Authenticate first
node scripts/pitchbook-advanced-search.mjs auth

# Run a default company search
node scripts/pitchbook-advanced-search.mjs search

# Search for deals
node scripts/pitchbook-advanced-search.mjs search --type=DEALS --page-size=50

# Get count for an existing search
node scripts/pitchbook-advanced-search.mjs count s637561838

# Fetch page 2 of results for an existing search
node scripts/pitchbook-advanced-search.mjs results s637561838 --page=2 --page-size=100
```
