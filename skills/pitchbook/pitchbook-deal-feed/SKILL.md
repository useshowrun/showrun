# pitchbook-deal-feed

Fetch recent deals from Pitchbook with filters.

## Usage

```bash
node scripts/pitchbook-deal-feed.mjs feed [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit=N` | 10 | Number of deals |
| `--days=N` | 365 | Trailing range in days |
| `--asset-class=CODE` | — | `VENTURE_CAPITAL`, `MNA`, or `PRIVATE_EQUITY` |
| `--deal-types=PRESET` | — | Preset or raw codes |
| `--verticals=CODE,...` | — | Industry verticals |
| `--locations=CODE,...` | — | Location codes |

## Examples

```bash
node scripts/pitchbook-deal-feed.mjs feed --limit=20
node scripts/pitchbook-deal-feed.mjs feed --asset-class=VENTURE_CAPITAL --days=30
node scripts/pitchbook-deal-feed.mjs feed --deal-types=vc-early --days=14 --limit=50
node scripts/pitchbook-deal-feed.mjs feed --asset-class=MNA --locations=gEu --days=90
```

## Deal type presets

| Preset | Description |
|--------|-------------|
| `vc-all` | All VC deal types |
| `vc-early` | Pre-seed through Series A |
| `vc-late` | Series B+ |
| `vc-seed` | Seed and pre-seed only |
| `mna-all` | All M&A deal types |
| `pe-all` | All Private Equity deal types |

## Common filter codes

**Verticals:** `AIML` (AI/ML), `FT` (FinTech), `SAAS` (SaaS), `SEC` (Cybersecurity), `DTLHL` (Digital Health), `HT` (HealthTech), `ECOMM` (E-Commerce), `CT` (CleanTech), `ET` (EdTech)

**Locations:** `gUS` (United States), `gEu` (Europe), `gAs` (Asia), `sCA` (California), `sNY` (New York), `sgBayArea` (Bay Area), `cUK` (UK), `cIND` (India)

Full filter codes in [`filter-codes.json`](filter-codes.json).

## Output

Returns deal company, type, date, and amount. Results cached to `~/.local/share/showrun/data/pitchbook/cache/deal-feed-<timestamp>.json`.
