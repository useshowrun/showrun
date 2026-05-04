---
name: pitchbook-market-maps
description: "Fetch published market maps from Pitchbook."
---

# pitchbook-market-maps

Fetch published market maps from Pitchbook.

## Usage

```bash
node scripts/pitchbook-market-maps.mjs list [--verticals=X] [--locations=X]
```

## Examples

```bash
node scripts/pitchbook-market-maps.mjs list
node scripts/pitchbook-market-maps.mjs list --verticals=AIML
```

## Common filter codes

**Verticals:** `AIML` (AI/ML), `FT` (FinTech), `SAAS` (SaaS), `SEC` (Cybersecurity), `DTLHL` (Digital Health), `HT` (HealthTech), `ECOMM` (E-Commerce), `CT` (CleanTech), `ET` (EdTech)

**Locations:** `gUS` (United States), `gEu` (Europe), `gAs` (Asia), `sCA` (California), `sNY` (New York)

## Output

Returns list of published market maps. Results cached to `~/.local/share/showrun/data/pitchbook/cache/market-maps-<timestamp>.json`.
