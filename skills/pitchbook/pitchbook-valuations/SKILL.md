# pitchbook-valuations

Fetch recent deal multiples and valuation data from Pitchbook.

## Prerequisites

- Node.js 22+
- [chrome-cdp](https://github.com/pasky/chrome-cdp-skill) skill (auto-installed on first use)
- `curl` with HTTP/2 support — verify with `curl --version` (look for `HTTP2`)
- Valid session (run login first)

## Setup

One-time authentication — see [pitchbook-login](../pitchbook-login/SKILL.md) for all methods. Preferred:

```bash
node ../pitchbook-login/scripts/pitchbook-login.mjs interactive
```

## Usage

### Fetch deal multiples

```bash
node scripts/pitchbook-valuations.mjs multiples [--days=365] [--verticals=X] [--locations=X]
```

**Examples:**
```bash
node scripts/pitchbook-valuations.mjs multiples
node scripts/pitchbook-valuations.mjs multiples --days=730
node scripts/pitchbook-valuations.mjs multiples --verticals=SAAS
```

### Show help

```bash
node scripts/pitchbook-valuations.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`multiples`** — POSTs to `web-api/dashboard-platform-service/v2/private/valuations/recent-deal-multiples` via curl. Returns a `data` array with yearly deal multiples. Each entry includes:
   - `year` — calendar year
   - `dealCount` — number of deals
   - `capitalInvestedMedian` — median capital invested
   - `preMoneyValuationMedian` — median pre-money valuation
   - `postValuationMedian` — median post-money valuation
   - `valuationEbitdaMedian` — median EV/EBITDA multiple
   - `valuationRevenueMedian` — median EV/Revenue multiple

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                    # Auth headers & cookies
└── cache/
    └── valuations-<timestamp>.json # Cached valuation results
```

## Output handling (important for agents)

Results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-valuations.mjs multiples > /tmp/pb-valuations.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/valuations-*.json
```

The console summary (printed to stderr) shows a table of year, deal count, EV/EBITDA median, and EV/Revenue median. For the full response, read the cache file — but only the lines you need. **Never dump full results into the conversation.**

## Filter values

The `--verticals` and `--locations` (see location codes below) flags accept Pitchbook internal codes. Common values:

### Verticals (--verticals)

| Code | Description |
|------|-------------|
| AIML | Artificial Intelligence & Machine Learning |
| FT | FinTech |
| DTLHL | Digital Health |
| HT | HealthTech |
| SEC | Cybersecurity |
| SAAS | SaaS |
| ECOMM | E-Commerce |
| CT | CleanTech |
| CAE | Climate Tech |
| CUE | CloudTech & DevOps |
| ET | EdTech |
| AGTCH | AgTech |
| IT | InsurTech |
| RAD | Robotics and Drones |
| SPTEC | Space Technology |
| CCBC | Cryptocurrency/Blockchain |
| IOT | Internet of Things |
| LSCI | Life Sciences |
| MLT | Mobility Tech |
| MOBILE | Mobile |

Full list (59 codes): `3D`, `AT`, `ADC`, `AGTCH`, `AIML`, `AUDTCH`, `AGTRLT`, `ATNMSCRS`, `BAN`, `BAT`, `BD`, `CNBS`, `CHN`, `CT`, `CAE`, `CUE`, `CTN`, `CCBC`, `SEC`, `DTLHL`, `ECOMM`, `ET`, `EPHMRL`, `EOS`, `FTH`, `FT`, `FDC`, `GMN`, `HT`, `HRTCH`, `ITS`, `ISA`, `INFR`, `IT`, `IOT`, `LAE`, `LSCI`, `LOHAS`, `MNF`, `MT`, `MMI`, `MOBILE`, `MEE`, `MLT`, `MGT`, `NANO`, `OLA`, `ONCO`, `PCO`, `RAN`, `RSTCLG`, `RSI`, `RAD`, `SAAS`, `SPTEC`, `SYN`, `TMT`, `VRTLRLT`, `WQS`

Multiple verticals can be combined: `--verticals=AIML,FT,SEC`

**Note:** Using `--verticals=VC` or `--verticals=PE` will NOT work — these are not valid vertical codes. Verticals describe industry sectors, not investor types.

### Locations (--locations)

| Code | Description |
|------|-------------|
| gUS | United States (all) |
| gCA | Canada |
| gEU | Europe |
| gAS | Asia |
| gAF | Africa |
| gME | Middle East |
| gOC | Oceania |
| sCA | California |
| sNY | New York |
| sTX | Texas |
| sMA | Massachusetts |

Prefix convention: `g` = country/region group, `s` = US state, `sg` = sub-region (e.g., `sgBayArea`)

Example: `--locations=gUS` or `--locations=sCA,sNY`

### Asset class (--asset-class)

**Note:** The `--asset-class` flag is not supported by the valuations endpoint. It only applies to deal-feed and investors.

## Session expiry

If you see `Session expired`, re-authenticate. Fastest: `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`. See [pitchbook-login](../pitchbook-login/SKILL.md) for fallbacks.
