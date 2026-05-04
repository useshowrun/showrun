---
name: pitchbook-company
description: "Fetch a full company profile from Pitchbook."
---

# pitchbook-company

Fetch a full company profile from Pitchbook.

## Usage

```bash
node scripts/pitchbook-company.mjs get <companyId> [--sections=generalInfo,dealHistory]
```

Use `pitchbook-search` to find the company ID first.

**Examples:**
```bash
node scripts/pitchbook-company.mjs get 149504-14
node scripts/pitchbook-company.mjs get 149504-14 --sections=generalInfo
node scripts/pitchbook-company.mjs get 149504-14 --sections=dealHistory,currentTeam
```

## Sections

`generalInfo`, `dealHistory`, `currentTeam`, `formerTeam`, `currentBoardMembers`, `formerBoardMembers`

Fetching all sections takes ~36 seconds (6 endpoints with rate-limit delays). Use `--sections` to fetch only what you need.

## Agent guidance

Profiles can be 500KB+. Always redirect output to a file and read cached results with truncation. Summarize findings — never dump raw JSON.

Results cached to `~/.local/share/showrun/data/pitchbook/cache/company-<id>.json`.
