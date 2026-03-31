# pitchbook-deal-feed

Fetch recent deals from Pitchbook's deal feed with filters for deal type, verticals, locations, and asset class.

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

```bash
node scripts/pitchbook-deal-feed.mjs feed [options]
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--limit=N` | 10 | Number of deals to fetch |
| `--days=N` | 365 | Trailing range in days |
| `--asset-class=CODE` | (none) | Asset class filter — auto-populates deal types |
| `--deal-types=PRESET` | (none) | Deal type preset or raw codes |
| `--verticals=CODE,...` | (none) | Industry vertical codes |
| `--locations=CODE,...` | (none) | Location codes |

### Examples

```bash
# Early-stage VC deals in the last 2 weeks
node scripts/pitchbook-deal-feed.mjs feed --deal-types=vc-early --days=14 --limit=50

# All VC deals in AI/ML
node scripts/pitchbook-deal-feed.mjs feed --asset-class=VENTURE_CAPITAL --verticals=AIML --days=30

# Seed rounds in the Bay Area
node scripts/pitchbook-deal-feed.mjs feed --deal-types=vc-seed --locations=sgBayArea --days=30

# M&A deals in Europe
node scripts/pitchbook-deal-feed.mjs feed --asset-class=MNA --locations=gEu --days=90

# Specific deal types by raw codes
node scripts/pitchbook-deal-feed.mjs feed --deal-types=SEED,EVC,EVC_A,A --locations=gUS --days=30
```

## Deal type presets

The `--deal-types` flag accepts presets that expand to the correct API codes:

| Preset | Description |
|--------|-------------|
| `vc-all` | All Venture Capital deal types |
| `vc-early` | Pre-seed through Series A (accelerators, angels, seed, early VC) |
| `vc-late` | Series B+ and later stage |
| `vc-seed` | Seed and pre-seed only |
| `vc-series-a` | Series A only |
| `mna-all` | All M&A deal types |
| `pe-all` | All Private Equity deal types |

You can also pass raw deal type codes (comma-separated). When `--asset-class` is set but no `--deal-types`, the script auto-populates all deal type codes for that asset class — matching the PitchBook UI behavior.

## Filter codes reference

All filter codes (176 deal types, 59 verticals, 435 locations) are in [`filter-codes.json`](filter-codes.json). Grep it for specific codes:

```bash
# Find a vertical code
grep -i "fintech" pitchbook-deal-feed/filter-codes.json

# Find a location code
grep -i "california" pitchbook-deal-feed/filter-codes.json
```

### Quick reference — common verticals

`AIML` (AI/ML), `FT` (FinTech), `SAAS` (SaaS), `SEC` (Cybersecurity), `DTLHL` (Digital Health), `HT` (HealthTech), `ECOMM` (E-Commerce), `CT` (CleanTech), `ET` (EdTech), `FDC` (FoodTech), `MOBILE` (Mobile)

### Quick reference — common locations

`gUS` (United States), `gEu` (Europe), `gAs` (Asia), `sCA` (California), `sNY` (New York), `sTX` (Texas), `sgBayArea` (Bay Area), `sgNewYorkMetro` (NYC Metro), `cUK` (United Kingdom), `cIND` (India)

### Quick reference — asset classes

`VENTURE_CAPITAL`, `MNA`, `PRIVATE_EQUITY`

## How it works

**`feed`** — POSTs to `web-api/dashboard-platform-service/v3/private/data-sourcing/recent-deals` with filter parameters. Returns an array of deal objects with:
- `company.pbId` — Pitchbook company ID
- `company.name` — company name
- `dealSynopsis` — brief description of the deal
- `lastFinancingDate` — date of last financing
- `lastFinancingSize` — size of last financing round (object with `amount`, `currency`, `nativeAmount`, `nativeCurrency`)
- `totalRaised` — total amount raised
- `dealType` — display name (e.g. "Early Stage VC", "Seed Round", "Series A")

## Output handling (important for agents)

Deal feed results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-deal-feed.mjs feed --limit=10 > /tmp/pb-deals.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/deal-feed-*.json
```

**Never dump full deal results into the conversation.**

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                         # Auth headers & cookies
└── cache/
    └── deal-feed-<timestamp>.json       # Cached deal feed results
```

## Session expiry

If you see `Session expired`, re-authenticate: `node ../pitchbook-login/scripts/pitchbook-login.mjs interactive`
