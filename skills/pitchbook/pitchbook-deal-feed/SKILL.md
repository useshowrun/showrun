# pitchbook-deal-feed

Fetch recent deals from Pitchbook's deal feed with optional filters for verticals, deal types, and locations.

## Prerequisites

- Node.js 22+
- [chrome-cdp](../../chrome-cdp) skill (for `auth`)
- `curl` with HTTP/2 support — verify with `curl --version` (look for `HTTP2`)
- Valid session (run login first)

## Setup

One-time authentication — see [pitchbook-login](../pitchbook-login/SKILL.md) for all methods. Preferred:

```bash
node ../pitchbook-login/scripts/pitchbook-login.mjs auth    # CDP auto-login
```

Or capture via CDP from an already-logged-in tab:

```bash
node scripts/pitchbook-deal-feed.mjs auth
```

## Usage

### Fetch recent deals

```bash
node scripts/pitchbook-deal-feed.mjs feed [--limit=10] [--days=365] [--verticals=...] [--locations=...]
```

**Examples:**
```bash
node scripts/pitchbook-deal-feed.mjs feed
node scripts/pitchbook-deal-feed.mjs feed --limit=5 --days=30
node scripts/pitchbook-deal-feed.mjs feed --limit=5 --verticals=AIML
```

### Show help

```bash
node scripts/pitchbook-deal-feed.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`feed`** — POSTs to `web-api/dashboard-platform-service/v3/private/data-sourcing/recent-deals` via curl with filter parameters. Returns an array of deal objects. Each deal includes:
   - `company.pbId` — Pitchbook company ID
   - `company.name` — company name
   - `dealSynopsis` — brief description of the deal
   - `lastFinancingDate` — date of last financing
   - `lastFinancingSize` — size of last financing round
   - `totalRaised` — total amount raised
   - `dealType` — e.g. `SERIES_A`, `SERIES_B`

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                         # Auth headers & cookies
└── cache/
    └── deal-feed-<timestamp>.json       # Cached deal feed results
```

## Output handling (important for agents)

Deal feed results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-deal-feed.mjs feed --limit=10 > /tmp/pb-deals.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/deal-feed-*.json
```

The console summary (printed to stderr) shows a brief list of deals. For the full response, read the cache file — but only the lines you need. **Never dump full deal results into the conversation.**

## Filter values

The `--verticals` and `--locations` (optional, free-text country/region) flags accept Pitchbook internal codes. Common values:

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

### Deal types (--deal-types)

Deal type filtering is not supported via the dashboard API — the `--deal-types` flag is accepted but Pitchbook's dashboard endpoints ignore it. To filter by deal type, use the Advanced Search skill with criteria set in the web UI.

## Session expiry

If you see `Session expired`, re-authenticate. Fastest: `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`. See [pitchbook-login](../pitchbook-login/SKILL.md) for fallbacks.
