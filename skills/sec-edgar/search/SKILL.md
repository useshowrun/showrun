---
name: sec-edgar-search
description: "SEC EDGAR full-text search — query the text of every SEC filing since 2001 (~30 M filings, 10 K to Form 4 to Form D). Free, no auth, no API key. Wraps EDGAR's official EFTS endpoint at `https://efts.sec.gov/LATEST/search-index`. The same engine that powers <https://efts.sec.gov/LATEST/search-index?q=>."
---

# sec-edgar-search

SEC EDGAR full-text search — query the text of every SEC filing since 2001 (~30 M filings, 10 K to Form 4 to Form D). Free, no auth, no API key. Wraps EDGAR's official EFTS endpoint at `https://efts.sec.gov/LATEST/search-index`. The same engine that powers <https://efts.sec.gov/LATEST/search-index?q=>.

This is the right endpoint when you need to *discover* filings by content (a phrase, a company name, a form type in a date window) — distinct from `sec-edgar-filings.mjs list` which is per-CIK only.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication. SEC **requires a contact `User-Agent`** — script sends `showrun-sec-edgar/1.0 (<contact-email>)`, defaulting to `showrun-skills@showrun.co`. Set `SEC_EDGAR_CONTACT=you@example.com` to attribute traffic to your own email. SEC rate-limits to **10 req/sec** — script self-throttles to ~9.

## Usage

```bash
# Phrase search — find filings containing a phrase
node scripts/sec-edgar-search.mjs query "artificial intelligence" --forms=10-K --from=2025-01-01 --to=2025-06-30 --limit=10
node scripts/sec-edgar-search.mjs query "going concern" --forms=10-K --from=2024-01-01 --limit=20
node scripts/sec-edgar-search.mjs query "ransomware" --forms=8-K --days=90 --limit=30

# Company-name search (works for private filers — Form D issuers, fund SPVs, etc.)
node scripts/sec-edgar-search.mjs company "OpenAI" --limit=20
node scripts/sec-edgar-search.mjs company "Stripe" --forms=D --limit=10

# Form D private placements (fundraising) — Crunchbase replacement
node scripts/sec-edgar-search.mjs rounds --from=2026-04-01 --limit=20
node scripts/sec-edgar-search.mjs rounds --company="anthropic" --limit=10

# Most recent filings of any form
node scripts/sec-edgar-search.mjs recent --form=8-K --days=2 --limit=20
node scripts/sec-edgar-search.mjs recent --form=S-1 --days=30 --limit=15
node scripts/sec-edgar-search.mjs recent --form=13F-HR --days=60 --limit=20
```

## Output format

```
# SEC EDGAR full-text search — "artificial intelligence"
   forms=10-K  from=2025-01-01  to=2025-06-30
   matches: 2,955    showing 5

   2025-05-29  10-K      0001641172-25-012903  Artificial Intelligence Technology Solutions Inc.  (AITX)  (CIK 0001498148)
      https://www.sec.gov/Archives/edgar/data/1498148/000164117225012903/0001641172-25-012903-index.htm
   2025-03-27  10-K      0001013762-25-003420  Linkhome Holdings Inc.  (LHAI)  (CIK 0002017758)
      ...
```

```
# SEC EDGAR — Form D (private placements)
   from=2026-04-01  to=-    matches: 6,292    showing 5

   2026-05-04  D         0002133230-26-000001  Qaimera Technologies, Inc.  (CIK 0002133230)
   2026-05-04  D         0002133071-26-000001  Mentat Biotechnology, Corp.  (CIK 0002133071)
   2026-05-04  D         0002132568-26-000001  Perplexity AI Insider Stock Acquisitions, LLC  (CIK 0002132568)
   ...
```

## Data layout

All state under `~/.local/share/showrun/data/sec-edgar/cache/`:

- `search-query-{phrase}-{forms}-{from}-{to}-{limit}.json`
- `search-company-{name}-{forms}-{limit}.json`
- `search-rounds-{company}-{from}-{to}-{limit}.json`
- `search-recent-{form}-{days}d-{limit}.json`

Each cache file holds the raw EFTS hits (one per matching document) plus the request params. Delete to force re-query.

## API notes

- **Endpoint**: `GET https://efts.sec.gov/LATEST/search-index`
- **Params**:
  - `q` — phrase (quoted phrases match as a unit; bare words AND)
  - `forms` — comma-sep form codes (`10-K`, `10-Q`, `8-K`, `D`, `4`, `13F-HR`, `S-1`, …)
  - `entityName` — fuzzy match on filer name (works for private filers)
  - `dateRange=custom`, `startdt=YYYY-MM-DD`, `enddt=YYYY-MM-DD`
  - `ciks` — comma-sep CIKs
  - `from` (offset), `hits` (page size, max 100, ignored by some queries)
- **Response**: standard ElasticSearch shape — `{ hits: { total: { value }, hits: [{ _id, _source: { adsh, ciks, display_names, form, file_date, ... } }] } }`.
- **Hard cap**: EFTS returns at most ~10 000 results per query; this script paginates up to 1 000 and dedupes by accession number.
- **Reference (informal)**: the EDGAR full-text search UI at <https://efts.sec.gov/LATEST/search-index?q=>.

## Known pitfalls

- **EFTS returns one hit per document file**, not per filing. A single 10-K with 12 exhibits returns 12 hits with the same accession. The script dedupes by `accession`, so `--limit=10` returns 10 *distinct filings*.
- **`hits=` param is sometimes ignored.** EFTS may return the default 100 even when `hits=5`. The script paginates and dedupes client-side, so the user-visible `--limit` is honored.
- **`entityName` is permissive but not fuzzy.** "OpenAI" matches `OpenAI`, `openai`, `OPENAI`, but *not* `Open AI`. Try multiple spellings if your first hit count is suspiciously low.
- **`forms=D` is the magic for fundraising data.** Every Reg D / Section 506(b)/(c) US private placement files Form D within 15 days. This is the dataset Crunchbase paywalls.
- **Form 4 is high-volume.** Insider trades file ~3 000 Form 4s per day across all public co's. `recent --form=4` saturates the 1 000-hit cap quickly; narrow with `--days=1`.
- **Pre-2001 filings are not in EFTS.** Use `sec-edgar-filings.mjs list` (Submissions API) for older filings — that endpoint goes back to ~1993.
- **Total-match counts can be approximate** at high values (`>10 000`). The displayed `matches: N` is EFTS's own reported total.
