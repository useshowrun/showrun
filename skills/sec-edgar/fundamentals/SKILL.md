# sec-edgar-fundamentals

SEC EDGAR XBRL Financial Data API wrapper — every numeric line item ever reported by a U.S. public company (revenue, EPS, assets, cash flow, etc.) plus cross-sectional peer comparisons. Free, no auth, no API key. Direct replacement for Yahoo Finance / Bloomberg fundamentals.

Wraps three public XBRL endpoints under `https://data.sec.gov/api/xbrl/`:

- **companyfacts** — every concept × period × unit for one company (one big file)
- **companyconcept** — time series of one concept for one company
- **frames** — cross-sectional slice: one concept across all reporting filers for one period

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. SEC **does require a contact `User-Agent`** — script sends `showrun-sec-edgar/1.0 (<contact-email>)`, defaulting to `showrun-skills@showrun.co`. Set `SEC_EDGAR_CONTACT=you@example.com` to attribute traffic to your own email. SEC rate-limits to **10 req/sec** — script self-throttles to ~9.

## Usage

```bash
# Headline financials (latest annual values)
node scripts/sec-edgar-fundamentals.mjs summary AAPL
node scripts/sec-edgar-fundamentals.mjs summary MSFT

# List every available XBRL concept for a company (sorted by # data points)
node scripts/sec-edgar-fundamentals.mjs concepts MSFT

# Time series of one concept
node scripts/sec-edgar-fundamentals.mjs series AAPL Revenues --form=10-K --limit=6
node scripts/sec-edgar-fundamentals.mjs series TSLA NetIncomeLoss --limit=12
node scripts/sec-edgar-fundamentals.mjs series NVDA EarningsPerShareDiluted --unit=USD/shares

# Full companyfacts JSON (5–50 MB; cache or save to file)
node scripts/sec-edgar-fundamentals.mjs facts AAPL
node scripts/sec-edgar-fundamentals.mjs facts AAPL --save=./aapl-facts.json

# Cross-sectional: who reported the largest Revenues in CY2024Q4
node scripts/sec-edgar-fundamentals.mjs peer Revenues --period=CY2024Q4 --top=10
node scripts/sec-edgar-fundamentals.mjs peer Assets --period=CY2024Q4I --top=20
```

## Output format

```
# SEC EDGAR summary — Apple Inc.  (CIK 0000320193)

   Revenue (ASC 606)             416.16B USD   CY2025      (10-K)
   Gross profit                  195.20B USD   CY2025      (10-K)
   Operating income              133.05B USD   CY2025      (10-K)
   Net income                    112.01B USD   CY2025      (10-K)
   EPS (diluted)                    7.46 USD/shares  CY2025  (10-K)
   Total assets                  359.24B USD   2025FY      (10-K)
   Stockholders equity            73.73B USD   2025FY      (10-K)
   Cash & equivalents             35.93B USD   2025FY      (10-K)
   Long-term debt                 90.68B USD   2025FY      (10-K)
   Operating cash flow           111.48B USD   CY2025      (10-K)
```

```
# SEC EDGAR frames — Revenues  (us-gaap/Revenues, unit=USD, CY2024Q4)
   454 filers — top 10 by value

       81.49B  CIK 0001140859 CENCORA, INC.
       62.15B  CIK 0000909832 COSTCO WHOLESALE CORP /NEW
       55.26B  CIK 0000721371 Cardinal Health, Inc.
       ...
```

## Frame period syntax

Frames take a calendar-period code in the URL (and `--period=` flag):

| Code           | Meaning                                            |
|----------------|----------------------------------------------------|
| `CY2024`       | Calendar year 2024 (annual durations)              |
| `CY2024Q1`     | Calendar Q1 2024 (3-month duration)                |
| `CY2024Q4`     | Calendar Q4 2024 (3-month duration)                |
| `CY2024Q4I`    | Calendar **instant** at end of Q4 2024 (snapshots) |

Use `Q*I` for balance-sheet items (assets, liabilities, cash) since those are point-in-time. Use `Q*` (no `I`) for income/cash-flow items, which are durations.

## Data layout

All state under `~/.local/share/showrun/data/sec-edgar/cache/`:

- `tickers.json` — ticker → CIK map (24 h TTL)
- `companyfacts-CIK{10}.json` — full XBRL dump for one company (24 h TTL)
- `companyconcept-CIK{10}-{taxonomy}-{concept}.json` — single concept time series (24 h TTL)
- `frames-{taxonomy}-{concept}-{unit}-{period}.json` — frame snapshot (immutable)

## API notes

- **companyfacts**: `GET /api/xbrl/companyfacts/CIK{10}.json`
  - Response: `{ cik, entityName, facts: { 'us-gaap': { Concept: { label, description, units: { USD: [{start, end, val, accn, fy, fp, form, filed, frame}, ...] } } }, 'dei': {...}, 'ifrs-full': {...} } }`
  - `units` keys are usually `USD`, `shares`, `USD/shares`, `pure` (ratios).
- **companyconcept**: `GET /api/xbrl/companyconcept/CIK{10}/{taxonomy}/{Concept}.json` — same shape but only one concept.
- **frames**: `GET /api/xbrl/frames/{taxonomy}/{Concept}/{unit}/{period}.json` — `{ taxonomy, tag, ccp, label, description, pts, data: [{accn, cik, entityName, loc, end, val, ...}] }`. `pts` = filer count.
- **Reference**: <https://www.sec.gov/edgar/sec-api-documentation>

## Known pitfalls

- **Concept names are taxonomy-specific.** The big two are `us-gaap` (default) and `ifrs-full` (foreign filers, IFRS). Apple, Microsoft, etc. use `us-gaap`. SAP, Toyota, etc. use `ifrs-full`. Use `concepts <ticker>` to discover what's available.
- **Multiple concepts can mean "Revenue."** Pre-ASC-606 filers used `Revenues`; post-2018 filers use `RevenueFromContractWithCustomerExcludingAssessedTax`. The `summary` command displays both when present (the older one freezes, the newer one is current).
- **Frame periods only contain *calendar*-aligned filings.** A `CY2024Q4` frame for `Revenues` includes Microsoft (fiscal Q2 = calendar Q4) only if MSFT *also* reported a calendar Q4 value — most do not. Apple's fiscal year ends in September, so its annual figure shows up in `CY2024` frames *only* when it falls on calendar boundaries. `peer` is for peer benchmarking within a calendar window, not exhaustive.
- **`facts` responses are large.** AAPL is ~8 MB, GE is ~50 MB. Default behavior caches but doesn't print. Use `--save=PATH` to copy elsewhere.
- **Filing duplicates.** XBRL filings re-state historical numbers; the script de-duplicates `series` by `(end, fp, form)` keeping the latest-filed version. Use `concepts` to inspect raw point counts.
- **`fp` (fiscal period)** is `FY` for annual, `Q1`/`Q2`/`Q3` for quarterlies. `Q4` is uncommon — most companies report Q4 inside the 10-K (`fp=FY`) instead of a separate 10-Q.
