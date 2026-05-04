---
name: wikipedia-stats-wikidata
description: "Wikidata lookups — entity-by-Q-id (with free-text `wbsearchentities` fallback), arbitrary SPARQL queries against the public endpoint, and SPARQL-from-file for multi-line queries. Free, no auth, no API key required."
---

# wikipedia-stats-wikidata

Wikidata lookups — entity-by-Q-id (with free-text `wbsearchentities` fallback), arbitrary SPARQL queries against the public endpoint, and SPARQL-from-file for multi-line queries. Free, no auth, no API key required.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. Wikimedia **does require a descriptive `User-Agent` header** on every request, otherwise it serves `403`. The script sends `wikipedia-wikidata-skill/1.0 (researcher; node; eyup@showrun.co)`.

## Usage

```bash
# Fetch a Wikidata entity by Q-id (or by free-text — first hit is fetched)
node scripts/wikipedia-wikidata.mjs entity Q117178637          # Anthropic
node scripts/wikipedia-wikidata.mjs entity "Mistral AI"        # search → fetch first hit

# Run an arbitrary SPARQL query
node scripts/wikipedia-wikidata.mjs sparql "SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q4830453 ; wdt:P571 ?inc . FILTER(YEAR(?inc) = 2021) . SERVICE wikibase:label { bd:serviceParam wikibase:language 'en' } } LIMIT 10"

# Or load it from a file (more readable for multi-line queries)
node scripts/wikipedia-wikidata.mjs sparql-file ./query.rq
```

## Output format

```
# Wikidata entity — Q117178637  Anthropic
   description: American AI safety and research company
   claims: 31 properties
   sitelinks: 27 (...)
   notable claims:
     P31 (instance of): Q6881511
     P571 (inception): +2021-01-01T00:00:00Z
     P856 (website): https://www.anthropic.com/
```

## Data layout

All state under `~/.local/share/showrun/data/wikipedia-stats/cache/`:

- `entity-<Q-id>.json`
- `sparql-<slug>-<base64-prefix>.json`

Cached responses are reused indefinitely. Delete the file to force a refresh.

## API notes

- **Wikidata SPARQL**: `GET https://query.wikidata.org/sparql?query=<urlencoded>&format=json`. Hard 60-second query timeout server-side.
- **Wikidata entity JSON**: `GET https://www.wikidata.org/wiki/Special:EntityData/{Q-id}.json` — full entity dump. Heavy — entities like `Q5` (human) are megabytes.
- **Free-text resolution**: `GET https://www.wikidata.org/w/api.php?action=wbsearchentities&search=...&language=en&format=json&limit=5` — used internally by `entity` when the argument isn't already a Q-id.
- **Required `User-Agent`**: Wikimedia's [User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) rejects clients with no UA or generic `python-requests/...`.

## Known pitfalls

- **SPARQL has a 60-second server-side timeout.** Always add `LIMIT N` and the `wikibase:label` SERVICE block for human-readable labels.
- **Wikidata Q-ids are not stable across renames** but are stable across label edits — once assigned, the Q-id never changes.
- **Entity JSON is large.** Highly-edited entities (countries, common-noun concepts) can be tens of MB. Scope your reads with SPARQL when possible.
