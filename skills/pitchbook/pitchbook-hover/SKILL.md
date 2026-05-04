---
name: pitchbook-hover
description: "Quick company summary from Pitchbook. Much faster than a full profile (1 endpoint vs 6)."
---

# pitchbook-hover

Quick company summary from Pitchbook. Much faster than a full profile (1 endpoint vs 6).

## Usage

```bash
node scripts/pitchbook-hover.mjs get <pbId>
```

Use `pitchbook-search` to find the company ID first.

**Examples:**
```bash
node scripts/pitchbook-hover.mjs get 149504-14
```

## Output

Returns company name, description, location, industry, verticals, investors, and status. Results cached to `~/.local/share/showrun/data/pitchbook/cache/hover-<pbId>.json`.
