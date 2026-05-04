---
name: sec-edgar-filings
description: "SEC EDGAR Submissions API wrapper — the complete filing history of any U.S. public company (10-K, 10-Q, 8-K, S-1, Form 4 insider trades, 13F, etc.). Free, no auth, no API key. Works for every SEC filer back to ~1993."
---

# sec-edgar-filings

SEC EDGAR Submissions API wrapper — the complete filing history of any U.S. public company (10-K, 10-Q, 8-K, S-1, Form 4 insider trades, 13F, etc.). Free, no auth, no API key. Works for every SEC filer back to ~1993.

Wraps the public **Submissions API** at `https://data.sec.gov/submissions/CIK{10}.json`. The endpoint returns a per-company filings index (the most recent ~1 000 entries inline, plus older entries split across paginated files). One company → one CIK → one canonical filing history.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. SEC **does require a contact `User-Agent`** on every request, otherwise the call returns `403`. The script sends `showrun-sec-edgar/1.0 (<contact-email>)`, defaulting to `showrun-skills@showrun.co`. Set `SEC_EDGAR_CONTACT=you@example.com` in your environment to attribute traffic to your own email — SEC uses this to reach you if your traffic causes issues. SEC also rate-limits to **10 req/sec** per source — the script self-throttles to ~9 req/sec.

## Usage

```bash
# Resolve a ticker / name / CIK
node scripts/sec-edgar-filings.mjs lookup AAPL
node scripts/sec-edgar-filings.mjs lookup "Apple"
node scripts/sec-edgar-filings.mjs lookup 320193

# List filings (filter by form, date, count)
node scripts/sec-edgar-filings.mjs list AAPL --form=10-K --limit=10
node scripts/sec-edgar-filings.mjs list AAPL --forms=10-K,10-Q,8-K --from=2024-01-01 --limit=50
node scripts/sec-edgar-filings.mjs list MSFT --form=8-K --from=2025-01-01 --to=2025-12-31

# Filings in the last N days (any form, or filtered)
node scripts/sec-edgar-filings.mjs recent NVDA --days=30
node scripts/sec-edgar-filings.mjs recent NVDA --days=30 --form=8-K

# Form 4 insider transactions (shorthand)
node scripts/sec-edgar-filings.mjs insiders TSLA --limit=20

# Get URLs for one specific filing
node scripts/sec-edgar-filings.mjs view AAPL 0000320193-25-000079
```

## Output format

```
# SEC EDGAR filings — Apple Inc.  (CIK 0000320193)
   tickers: AAPL    SIC: 3571 Electronic Computers
   filter: form=10-K  from=-  to=-  limit=5

   2025-10-31  10-K       0000320193-25-000079  10-K
   2024-11-01  10-K       0000320193-24-000123  10-K
   2023-11-03  10-K       0000320193-23-000106  10-K
   ...
```

`view` prints the index-page URL and the primary-document URL:

```
# SEC EDGAR filing — Apple Inc.  (0000320193-25-000079)
   form:        10-K
   filing date: 2025-10-31    report date: 2025-09-27
   primary doc: https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm
   index page:  https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/0000320193-25-000079-index.htm
   XBRL:        yes    size: 9,392,337 bytes
```

## Data layout

All state under `~/.local/share/showrun/data/sec-edgar/cache/`:

- `tickers.json` — full ticker → CIK map (1.4 MB, refreshed every 24 h)
- `submissions-CIK{10}.json` — per-company submissions (refreshed every 1 h)
- `submissions-CIK{10}-submissions-{NNN}.json` — older filings page (immutable)
- `filings-list-{cik}-{forms}-{from}-{to}-{limit}.json` — last `list` invocation

## API notes

- **Submissions**: `GET https://data.sec.gov/submissions/CIK{10-digit-padded-cik}.json`
  - Response: `{ cik, name, tickers[], exchanges[], sic, sicDescription, filings: { recent: {...}, files: [...] } }`
  - `filings.recent` holds the most recent ~1 000 filings as **parallel arrays**: `accessionNumber[i]`, `filingDate[i]`, `form[i]`, `primaryDocument[i]`, `primaryDocDescription[i]`, `size[i]`, `isXBRL[i]`, `reportDate[i]`. Iterate by index.
  - `filings.files[]` references older paginated files at `https://data.sec.gov/submissions/{name}.json` — same parallel-array shape. Script auto-follows when `--limit` exceeds 1 000.
- **Ticker map**: `GET https://www.sec.gov/files/company_tickers.json` — `{ "0": {cik_str, ticker, title}, "1": {...}, ... }`. Public companies only.
- **Filing URLs**: index-page URL is `https://www.sec.gov/Archives/edgar/data/{cik-int-no-padding}/{accession-no-dashes}/{accession-with-dashes}-index.htm`. Primary doc is at the same path with the document filename.
- **Required `User-Agent`**: SEC's [fair-use policy](https://www.sec.gov/os/accessing-edgar-data) rejects requests without a contact-form UA.
- **Reference**: <https://www.sec.gov/edgar/sec-api-documentation>

## Known pitfalls

- **Tickers are public-companies-only.** Private filers (Form D, S-1 pre-IPO, fund SPVs) have CIKs but no ticker — `lookup AAPL` works, `lookup "Some VC SPV"` does not. Use `sec-edgar-search.mjs company "<name>"` instead, then pass the resulting CIK to `list`.
- **Form types are strings, not enums.** `10-K` ≠ `10-K/A` (amendments) ≠ `NT 10-K` (notice of late filing). The `--form=` filter is exact-match. Use `--forms=10-K,10-K/A` to include amendments.
- **Form 4 (insider trades) is filed by the *insider's* agent**, so the accession's filer-CIK prefix often doesn't match the company's CIK. The `insiders` shorthand still works because it filters the company's submissions index.
- **CIKs are integers but always 10-digit zero-padded** in URLs. `lookup` outputs the padded form; `view` accepts either. `0000320193` and `320193` resolve to the same company.
- **Submissions cache is 1 hour.** A filing made 5 minutes ago may not appear yet. Delete the cache file (`submissions-CIK*.json`) to force a refresh.
- **Older filings (>1 000) are fetched on demand.** `list AAPL --limit=2000` triggers extra requests; cap is 5 000 per call.
