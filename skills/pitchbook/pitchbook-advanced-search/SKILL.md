# pitchbook-advanced-search

Run advanced/screener searches on Pitchbook with programmatic filter criteria. Takes ~40 seconds (multi-step API flow with rate-limit delays).

## Usage

### Run a filtered search

```bash
node scripts/pitchbook-advanced-search.mjs search \
  --type=COMPANIES \
  --criteria='[{"field":"company.location.codes","op":"collection","body":{"value":["gUS"],"requestType":"COLLECTION","updateType":"SET_VALUE"}}]'
```

Without `--criteria`, the search returns ALL entities (11M+ companies). Always pass filters for useful results.

### Discover available filter fields

```bash
node scripts/pitchbook-advanced-search.mjs criteria-schema --type=COMPANIES
```

Dumps the full criteria field tree (JSON) to `cache/criteria-schema-<TYPE>-<searchId>.json`. Use this to learn field paths like `company.dateFounded`, `company.financial.revenue`, `company.ownershipStatus`.

### Fetch results for an existing search

```bash
node scripts/pitchbook-advanced-search.mjs results <searchId> [--page=1] [--page-size=25] [--tab=companies|deals|investors]
```

### Sort results

Add `--sort=<columnId> --sort-order=DESC|ASC` to `search` or `results`. Default is `lastFinancingDate DESC` (most recent raise first).

```bash
# Sort by total raised, highest first
node scripts/pitchbook-advanced-search.mjs search --criteria='[...]' --sort=vcRaised --sort-order=DESC
```

Common sort columns: `lastFinancingDate`, `lastFinancingSize`, `vcRaised` (total raised), `lastFinancingValuation`, `employees`, `yearFounded`. See `filter-codes.json` → `sorting` for the full list.

### List all sortable columns for a search

```bash
node scripts/pitchbook-advanced-search.mjs columns <searchId>
```

### Get result count

```bash
node scripts/pitchbook-advanced-search.mjs count <searchId>
```

## Grouping convention

Many collection filters have group codes (e.g. location `gUS`, financingStatus `BACKING`, businessStatus `BUSINESS_STATUS`, deal.newTypes `BYSTG`/`BYSER`/`BYRN`). When the PitchBook frontend selects a group, it sends the group code AND every child code together.

**Rule: to match the UI, send the group code plus all its children.** Passing only the group code often works too, but expanding matches what the web app does. See `filter-codes.json` → `_groupingConvention` for details.

## `--criteria` format

Array of `{field, op, body}` objects — one entry per filter. `field` is a dot-path (from `criteria-schema`), `op` is the URL operation segment, `body` is the raw request body. Known ops and body shapes are documented in [`filter-codes.json`](filter-codes.json).

**Quick reference (common ops):**
- `collection` — array-valued filters (locations, statuses, deal types)
- `industry-query` — tree filter for industries + verticals + keywords + emerging spaces (only for `company.industryQueryCriteria`)

For filter types not yet documented, inspect the PitchBook screener UI via Chrome DevTools Network tab — apply the filter manually and copy the request body shape.

## Examples

**US-only companies:**
```bash
--criteria='[{"field":"company.location.codes","op":"collection","body":{"value":["gUS"],"requestType":"COLLECTION","updateType":"SET_VALUE"}}]'
```

**Keyword "devtools" OR SaaS vertical:**
```bash
--criteria='[{"field":"company.industryQueryCriteria","op":"industry-query","body":{"value":{"queryMode":"OR","expandedKeywordsEnabled":false,"industryQueryItem":{"type":"OR","queryItemDiscriminator":"LOGICAL_OPERATION","queryItems":[{"type":"KEYWORD","code":"devtools","queryItemDiscriminator":"TERM_ITEM","primaryIndustry":false},{"type":"VERTICAL","code":"SAAS","queryItemDiscriminator":"TERM_ITEM","primaryIndustry":false}]}},"requestType":"INDUSTRY_QUERY","updateType":"SET_VALUE"}}]'
```

**Pre-Series B only (deal types):**
```bash
--criteria='[{"field":"deal.newTypes","op":"collection","body":{"value":["PAI","POF","EC","SeedA","Cap","SEED","ANG","ANG_A","ANG_B","ANG_C","ANG_D","ANG_E","ANG_F","ANG_G","ANG_H","ANG_I","ANG_J","ANG_K","ANG_1","ANG_2","ANG_3","ANG_ND","EVC","EVC_A","EVC_B","EVC_1","EVC_2","EVC_3","EVC_ND","SRSEED","A","RN1","RN2"],"requestType":"COLLECTION","updateType":"SET_VALUE"}}]'
```

(See `filter-codes.json` → `dealNewTypes._presets` for `pre-series-b`, `series-b-plus`, `seed-only`.)

Filters combine with AND at the top level. Nested boolean trees are supported inside `industry-query` via LOGICAL_OPERATION (see `filter-codes.json`).

## Notes

- The `searchId` is in the Pitchbook URL: `https://my.pitchbook.com/search/companies?searchId=s637561838`
- If session expires mid-flow, re-authenticate and use `results <searchId>` to resume — no need to re-run the full search.
- For a new filter type: run `criteria-schema` to find the field path, then inspect the UI network tab for the body shape.

## Output

Returns company name, industry, and location per result. Results cached to `~/.local/share/showrun/data/pitchbook/cache/advanced-search-<searchId>-p<page>.json`.
