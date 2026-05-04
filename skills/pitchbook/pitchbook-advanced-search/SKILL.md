---
name: pitchbook-advanced-search
description: "Run advanced/screener searches on Pitchbook. Takes ~36 seconds (6 API steps with rate-limit delays)."
---

# pitchbook-advanced-search

Run advanced/screener searches on Pitchbook. Takes ~36 seconds (6 API steps with rate-limit delays).

## Usage

### Run a default search

```bash
node scripts/pitchbook-advanced-search.mjs search [--type=COMPANIES|DEALS|INVESTORS] [--page=1] [--page-size=25]
```

### Fetch results for an existing search

If you set up filters in the Pitchbook UI, copy the `searchId` from the URL and fetch results:

```bash
node scripts/pitchbook-advanced-search.mjs results <searchId> [--page=1] [--page-size=25] [--tab=companies|deals|investors]
```

### Get result count

```bash
node scripts/pitchbook-advanced-search.mjs count <searchId>
```

## Examples

```bash
node scripts/pitchbook-advanced-search.mjs search
node scripts/pitchbook-advanced-search.mjs search --type=DEALS --page-size=50
node scripts/pitchbook-advanced-search.mjs results s637561838 --page=2 --page-size=100
```

## Notes

- A default search with no criteria returns ALL entities (11M+ companies). For filtered results, set criteria in the Pitchbook web UI first, then use `results <searchId>`.
- The `searchId` is in the Pitchbook URL: `https://my.pitchbook.com/search/companies?searchId=s637561838`
- If session expires mid-flow, re-authenticate and use `results <searchId>` to resume — no need to re-run the full search.

## Output

Returns company name, industry, and location per result. Results cached to `~/.local/share/showrun/data/pitchbook/cache/advanced-search-<searchId>-p<page>.json`.
