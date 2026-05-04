---
name: pitchbook-mna-comps
description: "Fetch M&A comparable transactions for a company."
---

# pitchbook-mna-comps

Fetch M&A comparable transactions for a company.

## Usage

```bash
node scripts/pitchbook-mna-comps.mjs comps <pbId>
```

Use `pitchbook-search` to find the company ID first.

## Examples

```bash
node scripts/pitchbook-mna-comps.mjs comps 149504-14
node scripts/pitchbook-mna-comps.mjs comps 46488-07
```

## Output

Returns comparable M&A transactions with company names and IDs. Results cached to `~/.local/share/showrun/data/pitchbook/cache/mna-comps-<pbId>.json`.
