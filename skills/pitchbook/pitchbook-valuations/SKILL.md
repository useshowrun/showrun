---
name: pitchbook-valuations
description: "Fetch deal valuation multiples from Pitchbook."
---

# pitchbook-valuations

Fetch deal valuation multiples from Pitchbook.

## Usage

```bash
node scripts/pitchbook-valuations.mjs multiples [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--days=N` | 365 | Trailing range in days |
| `--verticals=CODE,...` | — | Industry verticals |
| `--locations=CODE,...` | — | Location codes |

## Examples

```bash
node scripts/pitchbook-valuations.mjs multiples
node scripts/pitchbook-valuations.mjs multiples --days=730
node scripts/pitchbook-valuations.mjs multiples --verticals=SAAS
node scripts/pitchbook-valuations.mjs multiples --verticals=AIML --locations=gUS
```

## Common filter codes

**Verticals:** `AIML` (AI/ML), `FT` (FinTech), `SAAS` (SaaS), `SEC` (Cybersecurity), `DTLHL` (Digital Health), `HT` (HealthTech), `ECOMM` (E-Commerce), `CT` (CleanTech), `ET` (EdTech)

**Locations:** `gUS` (United States), `gEu` (Europe), `gAs` (Asia), `sCA` (California), `sNY` (New York), `sgBayArea` (Bay Area), `cUK` (UK), `cIND` (India)

## Output

Returns yearly table with deal count, EV/EBITDA, and EV/Revenue multiples. Results cached to `~/.local/share/showrun/data/pitchbook/cache/valuations-<timestamp>.json`.
