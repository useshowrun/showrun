---
name: pitchbook-investors
description: "Fetch active investors from Pitchbook."
---

# pitchbook-investors

Fetch active investors from Pitchbook.

## Usage

```bash
node scripts/pitchbook-investors.mjs active [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--days=N` | 365 | Trailing range in days |
| `--verticals=CODE,...` | — | Industry verticals |
| `--locations=CODE,...` | — | Location codes |

## Examples

```bash
node scripts/pitchbook-investors.mjs active
node scripts/pitchbook-investors.mjs active --days=90
node scripts/pitchbook-investors.mjs active --days=90 --verticals=AIML
node scripts/pitchbook-investors.mjs active --verticals=FT --locations=gUS
```

## Common filter codes

**Verticals:** `AIML` (AI/ML), `FT` (FinTech), `SAAS` (SaaS), `SEC` (Cybersecurity), `DTLHL` (Digital Health), `HT` (HealthTech), `ECOMM` (E-Commerce), `CT` (CleanTech), `ET` (EdTech)

**Locations:** `gUS` (United States), `gEu` (Europe), `gAs` (Asia), `sCA` (California), `sNY` (New York), `sgBayArea` (Bay Area), `cUK` (UK), `cIND` (India)

## Output

Returns investor name, investment count, and last investment date. Results cached to `~/.local/share/showrun/data/pitchbook/cache/active-investors-<timestamp>.json`.
