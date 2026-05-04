---
name: gleif-entities
description: "Global Legal Entity Identifier (LEI) registry — the authoritative open dataset for \"who owns whom\" in the global economy. Free, no auth, no API key. Wraps the official GLEIF API at `https://api.gleif.org/api/v1`."
---

# gleif-entities

Global Legal Entity Identifier (LEI) registry — the authoritative open dataset for "who owns whom" in the global economy. Free, no auth, no API key. Wraps the official GLEIF API at `https://api.gleif.org/api/v1`.

The LEI system is the ISO-standard global identifier for legal entities (banks, public companies, funds, large private companies). Every LEI record carries the entity's legal name, registered + headquarters address, jurisdiction, status, and — most usefully — its **direct parent** and **ultimate parent** LEIs. PitchBook and Crunchbase paywall this; GLEIF publishes it as a public good.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication. The GLEIF API is open and rate-limit is generous (the script self-throttles to 5 req/sec).

## Usage

```bash
# Search by company name (case-insensitive substring on legalName)
node scripts/gleif.mjs lookup "Apple" --limit=5
node scripts/gleif.mjs lookup "Tesla"

# Direct LEI fetch (when you already have a 20-char LEI)
node scripts/gleif.mjs lookup HWUPKR0MPOU8FGXBT394

# Full record for one entity
node scripts/gleif.mjs view HWUPKR0MPOU8FGXBT394

# Ownership chain
node scripts/gleif.mjs parent <subsidiary-lei>             # direct parent
node scripts/gleif.mjs parent <subsidiary-lei> --ultimate  # top of the tree

# Direct subsidiaries
node scripts/gleif.mjs children HWUPKR0MPOU8FGXBT394 --limit=20

# Recursive ownership tree (children-of-children)
node scripts/gleif.mjs tree HWUPKR0MPOU8FGXBT394 --depth=2 --limit=10
```

## Output format

```
# GLEIF entity — HWUPKR0MPOU8FGXBT394
   name:        Apple Inc.
   other names: Apple Computer, Inc.
   category:    GENERAL    legal form: H1UM
   status:      ACTIVE    registration: ISSUED
   HQ:          One Apple Park Way, Cupertino, US-CA, 95014, US
   legal addr:  C/O C T Corporation System, 330 N. Brand Blvd, Suite 700, Glendale, US-CA, 91203, US
   jurisdiction: US-CA
   first registered: 2012-06-06    last updated: 2026-03-03    next renewal: 2027-03-08

   relationships available:
     direct-parent:    no
     ultimate-parent:  no
     direct-children:  yes
     ultimate-children:yes
```

```
# GLEIF ownership tree — HWUPKR0MPOU8FGXBT394  (depth=1, max 8 children/level)

   HWUPKR0MPOU8FGXBT394  Apple Inc.  [US]
     2549008YU9EOMHFUA249  APPLE OPERATIONS INDIA PRIVATE LIMITED  [IN]
     549300YX4S1LLSMK2627  APPLE ENERGY LLC  [US]
     5493006LHHR4CLPX4Q79  BRAEBURN CAPITAL, INC.  [US]
     549300G81RQKP7XW2N18  APPLE OPERATIONS INTERNATIONAL LIMITED  [IE]
       549300QKDHYRRQH2MB86  APPLE (UK) LIMITED  [GB]
       54930027SQL2KPSDBM58  APPLE DISTRIBUTION INTERNATIONAL LIMITED  [IE]
       ...
```

## Data layout

All state under `~/.local/share/showrun/data/gleif/cache/`:

- `lookup-{lei}.json` — last `lookup <lei>` invocation
- `search-{slug}-{limit}.json` — last `lookup <name>` (search) invocation
- `view-{lei}.json` — last `view` invocation
- `parent-direct-parent-{lei}.json` / `parent-ultimate-parent-{lei}.json`
- `children-{lei}-{limit}.json`
- `tree-{lei}-d{depth}-l{limit}.json`

## API notes

- **Base URL**: `https://api.gleif.org/api/v1` — JSON:API format (`Accept: application/vnd.api+json`).
- **Search**: `GET /lei-records?filter[entity.legalName]={name}&page[size]={N}` — case-insensitive substring on legalName; pagination via `page[number]` / `page[size]`.
- **Fetch one**: `GET /lei-records/{lei}` — single record.
- **Relationships**: `GET /lei-records/{lei}/{rel}` where `rel` ∈ {`direct-parent`, `ultimate-parent`, `direct-children`, `ultimate-children`, `relationship-records`}.
  - `404` means no relationship record on file (script returns null and prints a friendly message).
  - `direct-parent`/`ultimate-parent` return at most one record (or null).
  - `direct-children` returns paginated array; default page size is 10, request more via `page[size]=`.
- **LEI format**: 20 characters, [A–Z 0–9]^18 plus a 2-digit check digit. The script accepts mixed-case and uppercases internally.
- **Reference**: <https://www.gleif.org/en/lei-data/gleif-api>

## Known pitfalls

- **Not every entity has an LEI.** Banks, public-company subsidiaries, large private cos, and most fund/SPV entities do; a sole-proprietor coffee shop does not. If `lookup "<name>"` returns no matches, the entity may simply not need one for regulated transactions.
- **"No parent" can mean two things.** GLEIF distinguishes "entity reports it has no parent" (independent / top-of-tree) from "entity hasn't reported a parent" (relationship not yet filed). The script can't distinguish — both render as the friendly "no parent record on file" message. Cross-check via the `relationships` block in `view`.
- **Children ≤ trees.** `direct-children` only includes subsidiaries that *themselves* have LEIs. Many subsidiaries don't, especially small foreign branches. The tree understates total ownership.
- **Names are loosely standardized.** `lookup "Apple"` returns 350+ matches because GLEIF indexes legal-name substrings worldwide ("APPLE INDUSTRIES", "APPLE INFRASTRUCTURE"). Use a more specific phrase or pass the LEI directly when you know it.
- **Renewal lapses.** An entity in `LAPSED` registration status hasn't renewed its annual filing — the data is still valid but stale. Filter on `status=ACTIVE` if you only want current entities.
