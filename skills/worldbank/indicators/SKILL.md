---
name: worldbank-indicators
description: "World Bank Open Data API — 22K+ economic / development / demographic indicators across 200+ countries. Free, no auth. Search indicators by name, fetch country-level time series (GDP, inflation, population, CO2, education, health, etc.), compare values across peer countries. Sovereign / cross-country macro companion to FRED."
---

# worldbank-indicators

World Bank Open Data API wrapper — 22 000+ indicators × 200+ countries × 60+ years of data. Macro, demographic, environmental, education, health, infrastructure. Free, no auth, no API key. The canonical open source for cross-country sovereign data; complements FRED (which is U.S.-centric).

Wraps `https://api.worldbank.org/v2`.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. The script self-throttles to ~4 req/sec (World Bank has no published limit but is polite-friendly).

## Usage

```bash
# Find an indicator by keyword (default scope: ~1500 World Development Indicators)
node scripts/worldbank.mjs search "gdp" --limit=10
node scripts/worldbank.mjs search "unemployment"
node scripts/worldbank.mjs search "co2 emissions" --all          # full 22K-indicator catalog

# Indicator metadata (definition, units, source)
node scripts/worldbank.mjs view NY.GDP.MKTP.CD
node scripts/worldbank.mjs view SP.POP.TOTL

# Time series for one country × one indicator (with ASCII chart)
node scripts/worldbank.mjs fetch USA NY.GDP.MKTP.CD --from=2000 --to=2024
node scripts/worldbank.mjs fetch BRA FP.CPI.TOTL.ZG --from=2010
node scripts/worldbank.mjs fetch DEU EN.GHG.CO2.PC.CE.AR5

# Cross-country peer comparison for one indicator (latest available within ±5y)
node scripts/worldbank.mjs compare SP.POP.TOTL USA,CHN,DEU,JPN,IND --year=2023
node scripts/worldbank.mjs compare NY.GDP.PCAP.CD USA,DEU,JPN,KOR,GBR,FRA --year=2023

# List countries (filterable by region or income group)
node scripts/worldbank.mjs countries
node scripts/worldbank.mjs countries --income="High income"
node scripts/worldbank.mjs countries --region="Europe & Central Asia"
```

## Output format

```
# World Bank — GDP (current US$)
   country: United States (USA)    indicator: NY.GDP.MKTP.CD
   range:   2020 → 2024    n=5    min=21.06T  max=28.75T

   2020        21.06T  █
   2021        23.32T  ████████████
   2022        25.60T  ████████████████████████
   2023        27.29T  ████████████████████████████████
   2024        28.75T  ████████████████████████████████████████
```

```
# World Bank compare — Population, total
   indicator: SP.POP.TOTL    target year: 2023 (latest available within ±5y)

   India                                 1.44B    (2023)
   China                                 1.41B    (2023)
   United States                       336.81M    (2023)
   Japan                               124.52M    (2023)
   Germany                              83.29M    (2023)
```

## Common indicator IDs to start

| ID                  | What                                          |
|---------------------|-----------------------------------------------|
| `NY.GDP.MKTP.CD`    | Nominal GDP, current US$                       |
| `NY.GDP.PCAP.CD`    | GDP per capita, current US$                    |
| `NY.GDP.MKTP.KD.ZG` | Real GDP growth, %                             |
| `FP.CPI.TOTL.ZG`    | Inflation (CPI), annual %                      |
| `SL.UEM.TOTL.ZS`    | Unemployment, % of labor force                 |
| `SP.POP.TOTL`       | Population, total                              |
| `SP.POP.GROW`       | Population growth, annual %                    |
| `SP.URB.TOTL.IN.ZS` | Urban population, % of total                   |
| `EN.GHG.CO2.PC.CE.AR5` | CO2 emissions per capita (current series)   |
| `SE.SEC.ENRR`       | School enrollment, secondary, % gross          |
| `SH.DYN.MORT`       | Mortality rate, under-5 (per 1 000 live births)|
| `IT.NET.USER.ZS`    | Internet users, % of population                |
| `MS.MIL.XPND.GD.ZS` | Military expenditure, % of GDP                 |
| `BX.KLT.DINV.WD.GD.ZS` | FDI net inflows, % of GDP                   |
| `IC.BUS.EASE.XQ`    | Ease of doing business score                   |

`search` for anything else.

## Country codes

World Bank accepts both ISO3 (`USA`, `DEU`, `BRA`) and ISO2 (`US`, `DE`, `BR`). The skill normalizes both. `countries` lists all 200+ codes with regions and income classifications.

## Data layout

All state under `~/.local/share/showrun/data/worldbank/cache/`:

- `indicators-catalog-{wdi|all}.json` — full indicator catalog (7-day TTL)
- `fetch-{country}-{indicator}-{from}-{to}.json` — country × indicator series (24 h TTL)
- `countries.json` — country list (7-day TTL)

## API notes

- **Base**: `https://api.worldbank.org/v2/`
- **Time series**: `GET /country/{country}/indicator/{indicator}?date=YYYY:YYYY&format=json&per_page=100[&page=N]`
  - **Multi-country**: separate codes with `;` in the path: `/country/USA;CHN;DEU/indicator/...`
  - **Date range**: colon-separated, **must not be URL-encoded** (`%3A` is rejected). Script post-processes the URL to strip the encoding.
- **Indicator catalog**: `GET /indicator?source=2` — World Development Indicators (~1500 entries). Without `source=`, returns all 22K+ indicators across all sources.
- **Country list**: `GET /country?per_page=300`. Aggregates (regions, income groups) have `region.id == 'NA'` — script filters them out by default.
- **Response shape**: `[meta, data]` array. `meta` has pagination (`page`, `pages`, `per_page`, `total`). Errors return `[{ message: [{ id, key, value }] }]` — script unwraps and throws cleanly.
- **Reference**: <https://data.worldbank.org/about/api>

## Known pitfalls

- **Indicator IDs are surprisingly cryptic.** `NY.GDP.MKTP.CD` instead of `gdp_usd_current`. Always run `search` to discover IDs before `fetch`.
- **Indicators get deprecated.** `EN.ATM.CO2E.PC` was the canonical CO2-per-capita series for years; it's now archived in favor of `EN.GHG.CO2.PC.CE.AR5`. Skill returns a clean error message when an indicator is gone.
- **Latest data lags.** Most macro indicators have a 1–2 year reporting lag. `compare --year=2024` typically falls back to 2022/2023 values per country.
- **Aggregates ≠ countries.** Codes like `WLD` (World), `EUU` (European Union), `OED` (OECD members) work in `fetch`/`compare` but `countries` filters them out by default. Pass `--aggregates` to include them (not yet wired; check the data file directly).
- **Default search scope is WDI.** WDI is ~1500 curated headline indicators (GDP, inflation, etc.). Use `--all` to search the full 22K catalog if you need niche indicators (sectoral, doing-business, ASPIRE social-protection, etc.).
- **`%3A` in date params kills the API.** This is a documented quirk; the skill un-encodes the colon in `date=YYYY:YYYY`. If you see `HTTP 400` from a custom call, check your URL encoding.
- **Country aggregate vs. WDI source.** Some indicators only exist for some sources. If `fetch USA <obscure-indicator>` returns "no data," the indicator may exist only at aggregate level — try `fetch WLD <indicator>` or check `view <indicator>`.
