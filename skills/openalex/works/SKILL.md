---
name: openalex-works
description: "OpenAlex scholarly-works API — 240M+ academic works, 90M authors, 110K institutions. Free, no auth. Search papers by title or full-text, look up authors and their citation stats, find papers from specific institutions, get individual work metadata + abstract. Replaces Web of Science / Scopus for most research-mapping use cases."
---

# openalex-works

OpenAlex scholarly-works API wrapper — 240M+ works, 90M authors, 110K institutions. Free, no auth, no API key. The canonical open replacement for Web of Science, Scopus, and Google Scholar (for those that need an API). Useful for R&D mapping, corporate-research output, citation analytics, and academic-industry linkage research.

Wraps `https://api.openalex.org`.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. OpenAlex prefers a contact email in `mailto=` for the polite pool (faster + more reliable). Set `OPENALEX_CONTACT=you@example.com` to identify your traffic; defaults to `showrun-skills@showrun.co`.

## Usage

```bash
# Search papers by title (default — best for "find this paper")
node scripts/openalex.mjs search "attention is all you need" --limit=5

# Switch search modes
node scripts/openalex.mjs search "transformer architecture" --full-text --limit=20
node scripts/openalex.mjs search "transformer architecture" --top-cited --limit=10
node scripts/openalex.mjs search "constitutional AI" --type=article --from=2022 --to=2024 --limit=15

# Author lookup — picks top match, lists alternatives below
node scripts/openalex.mjs author "Geoffrey Hinton" --limit=10
node scripts/openalex.mjs author "Yann LeCun" --id=A2208157607     # exact OpenAlex ID

# Institution lookup
node scripts/openalex.mjs institution "Stanford University" --limit=20
node scripts/openalex.mjs institution "Anthropic" --id=I4387930290

# Citation / productivity stats for an author or institution
node scripts/openalex.mjs stats "Geoffrey Hinton"
node scripts/openalex.mjs stats "MIT"

# Single work details (OpenAlex ID, DOI, or full URL)
node scripts/openalex.mjs view W2964246983
node scripts/openalex.mjs view 10.1038/s41586-020-2649-2
```

## Output format

```
# OpenAlex search — "attention is all you need"  (title-search, relevance-sort)
   matches: 185    showing 3

   2025  W2626778328   cited: 6532  Attention Is All You Need
              Ashish Vaswani, Noam Shazeer, Niki Parmar, +5  —  (no venue)
```

```
# OpenAlex author — Geoffrey E. Hinton  (A5108093963)
   total works: 384    total citations: 446,685    h-index: 137
   showing top 3 by citations:

   2015  W2919115771   cited:80092  Deep learning
              Nature
   ...

   4 other candidate(s) for "Geoffrey Hinton" — pass --id=<id> to switch:
     A5110248343  works=36   cit=28693   Geoffrey E. Hinton  [?]
```

## Data layout

All state under `~/.local/share/showrun/data/openalex/cache/`:

- `search-{slug}-{mode}-{sort}-{from}-{to}-{type}-{limit}.json`
- `author-{slug}-{limit}.json`
- `inst-{slug}-{limit}.json`

Cache TTL is 24 h (OpenAlex updates daily).

## API notes

- **Base**: `https://api.openalex.org/{endpoint}` — `endpoint` ∈ {`works`, `authors`, `institutions`, `concepts`, `sources`, `publishers`, `funders`}.
- **Search modes**:
  - `?search=foo` — searches title + abstract + fulltext, weighted relevance
  - `?filter=display_name.search:foo` — title-only search (this skill's default for `search`)
- **Filters**: comma-separated. Common ones used here:
  - `from_publication_date:YYYY-MM-DD`, `to_publication_date:YYYY-MM-DD`
  - `type:article|book|book-chapter|dissertation|preprint|...`
  - `author.id:A123`, `institutions.id:I123`
- **Sort**: `relevance_score:desc` (default for searches), `cited_by_count:desc`, `publication_date:desc`.
- **IDs**: works are `W{number}`, authors `A{number}`, institutions `I{number}`. Full URI is `https://openalex.org/{id}`. Skill accepts the short form. DOIs prefixed with `doi:` (or starting with `10.`) work for `view`.
- **Mailto**: append `&mailto=you@example.com` to put your traffic in OpenAlex's polite pool — faster, no impact on rate limits.
- **Rate limit**: 100 000 calls/day per IP, 10 calls/sec — script self-throttles to 5/s.
- **Reference**: <https://docs.openalex.org/>

## Known pitfalls

- **Citation counts are conservative.** OpenAlex tracks formal-citation links from the corpus it has parsed. Counts are typically 30–60 % of Google Scholar (which also catches grey-lit citations). Useful for ranking, less so for absolute counts.
- **Publication-year for some works is wrong.** OpenAlex sometimes mis-tags re-issues (the canonical Vaswani Transformer paper currently shows `2025` due to a derived version). Cross-check against the `view` output's primary location.
- **Author ambiguity is real.** "Geoffrey Hinton" matches 5 candidates (the real one + namesakes + parser errors). Skill picks the top match by relevance and shows alternatives as a footer; pass `--id=A...` to switch.
- **Institution coverage is uneven.** Industrial labs (Anthropic, OpenAI, DeepMind) often have institution records with 0 publications because they don't push to scholarly-indexed venues. Use `view` on a known work to find what institution OpenAlex assigned.
- **`--full-text` searches are slower and noisier.** They surface papers that *mention* a phrase, not papers *about* it. Default title-search is usually what you want.
- **Abstracts are stored as inverted-index** (positions per word) not raw text. The `view` command reconstructs the text — order is correct but punctuation may be missing.
