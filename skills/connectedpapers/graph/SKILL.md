# connectedpapers-graph

Explore academic paper graphs on Connected Papers — build a graph of related papers around a seed paper, and find prior work (what shaped a field) or derivative work (where a paper was taken up). Use this whenever the user mentions Connected Papers, paper graphs, citation networks, or literature review around a seed paper.

Fetches Connected Papers graphs via the public frontend API at `rest.prod.connectedpapers.com`. No auth, no token, no Chrome CDP — stdlib-only Node.js.

Each graph contains ~40 most-related papers around a seed, scored by bibliographic coupling and co-citation. The response includes full Semantic Scholar metadata per node (title, authors, venue, DOI, arXiv ID, abstract, TL;DR, citation count, publication date, fields of study) plus weighted edges, common references, and common citations. This is what powers "prior work" and "derivative work" views on connectedpapers.com — both are derived client-side from the same graph payload.

## Prerequisites

- Node.js 22+ (built-in fetch + zlib, no dependencies)

## Setup

None. The public `/graph_no_build/` endpoint returns the cached graph for anyone who asks. Connected Papers only gates **building new graphs** and longer search results behind premium; all cached reads are free.

## Paper identifiers

`<paper>` accepts:

- **40-hex Semantic Scholar ID** — the canonical form, e.g. `204e3073870fae3d05bcbc2f6a8e263d9b72e776` (Attention is All You Need)
- **Multi-paper chain** — join S2 IDs with `+` for a combined graph, e.g. `<id1>+<id2>`
- **Free text** (title, DOI, arXiv ID) — resolved through `/autocomplete`, first match wins. A short phrase from the title works best; very long titles can miss.

Use `search` first if you need to see candidates before committing to a specific paper.

## Usage

```bash
# Search by title / keywords
node scripts/connectedpapers.mjs search "attention is all you need"
node scripts/connectedpapers.mjs search "diffusion models" --limit=20 --json

# Build or fetch a graph around one paper (cached server-side; instant for popular papers)
node scripts/connectedpapers.mjs graph 204e3073870fae3d05bcbc2f6a8e263d9b72e776
node scripts/connectedpapers.mjs graph "attention is all you need" --limit=30
node scripts/connectedpapers.mjs graph <id> --fresh           # bypass local + server cache
node scripts/connectedpapers.mjs graph <id> --json            # full payload (nodes+edges+commons)

# Multi-paper combined graph
node scripts/connectedpapers.mjs graph <id1>+<id2>+<id3>

# Origin paper metadata only
node scripts/connectedpapers.mjs paper 204e3073870fae3d05bcbc2f6a8e263d9b72e776

# Prior work (common_references — papers most-cited by the graph)
node scripts/connectedpapers.mjs prior <paper> --limit=20
node scripts/connectedpapers.mjs prior <paper> --json

# Derivative work (common_citations — papers that cite the most graph nodes)
node scripts/connectedpapers.mjs derivative <paper> --limit=20
node scripts/connectedpapers.mjs deriv <paper>                # alias

# Version history (which corpus dates have cached graphs)
node scripts/connectedpapers.mjs versions <paper>
```

## Output format — graph

```
# <origin title>
  <authors> (<year>)
  venue=<venue>  citations=<N>  refs=<N>
  doi=<doi>  arxiv=<arxivId>

Graph: <N> nodes, <N> edges
Corpus date: <YYYY-MM-DD>

Top <limit> related nodes by citation count:
- <title> (<year>) — <authors>
    <venue>  |  citations=<N> refs=<N>
    id=<s2id>  arXiv:<id>  doi:<doi>
...
```

## Data layout

All state under `~/.local/share/showrun/data/connectedpapers/`:

- `cache/graph-<s2id>.json` — decoded graph per origin paper (full `nodes`, `edges`, `common_citations`, `common_references`, `common_authors`, `parameters`, `path_lengths`)
- `cache/search-<slug>.json` — one per keyword search

## Graph JSON shape (for `--json` consumers)

```
{
  nodes: { "<s2id>": { id, corpusid, title, authors[{ids,name}], year, fieldsOfStudy[],
                       venue, journalName, journalVolume, journalPages, doi, pmid, magId,
                       arxivId, externalIds, abstract, tldr{text,model}, isOpenAccess,
                       publicationDate, url, citations_length, references_length,
                       path, path_length, pos{x,y}, number_of_authors, ... }, ... },
  edges: [ ["<from_id>", "<to_id>", weight], ... ],          // weight = bibliographic-coupling score
  common_references: { "0": {...paper}, "1": {...}, ... },   // most-referenced-by-graph
  common_citations:  { "0": {...paper}, "1": {...}, ... },   // most-citing-of-graph
  common_authors: { ... },
  parameters: { paper_id, total_nodes, num_commons, max_load, num_neighbors,
                spring_iterations, params_version },
  path_lengths: { "<s2id>": int, ... },
  start_id: "<origin s2id>",
  current_corpus_date: "YYYY-MM-DD",
  creation_time: ISO8601,
  uuid: hex
}
```

## API notes

- **Primary**: `GET /graph_no_build/<s2id[+<s2id>...]>` — returns CPGR binary, `cache-control: public, max-age=86400`.
- **Fresh**: `GET /fresh_graph_no_build/<s2id>` — same shape, bypasses the 24h cache.
- **Autocomplete**: `GET /autocomplete/<url-encoded-query>` — returns `{matches:[{id,title,authorsYear}]}`.
- **Versions**: `GET /versions/<s2id>/1` — returns `{graph_versions:[{uuid,creation_time,corpus_date,valid_until,is_visual}]}`.
- The origin ID must be lowercase 40-hex. Uppercase hex returns `400 Origin must be 40-hex s2ids separated by \`+\``.

### CPGR binary format (little-endian)

```
offset  size  field
0       4     magic "CPGR"
4       4     uint32 status   (1=OK 2=LONG_PAPER 3=IN_PROGRESS 4=NOT_RUN
                               5=ADDED_TO_QUEUE 6=ERROR 7=OVERLOADED
                               8=IN_QUEUE 9=NOT_IN_API)
8       4     uint32 data_length
12      data  for status=1: zlib-deflated UTF-8 JSON
              for status=3: uint32 progress (0–100)
trailing      optional uint32 uuid_len + uuid bytes (appended to payload as .uuid hex)
```

## Known pitfalls

- **Graph not ready** — new or rarely-viewed papers may return `status=NOT_RUN`, `IN_QUEUE`, or `ADDED_TO_QUEUE`. Visit `https://www.connectedpapers.com/main/<s2id>` once in a browser to trigger a build, then retry.
- **Long free-text queries miss** — autocomplete prefix-matches short phrases well but stumbles on 5+ word titles. If `No paper found matching: ...`, shorten the query or use `search` first.
- **Corpus date, not today** — nodes carry citation counts from the graph's `current_corpus_date`, typically 30–60 days stale.
- **DOI / arXiv IDs aren't accepted directly** — the endpoint requires S2 IDs.
- **No paid API key is used.** If Connected Papers throttles anonymous access in the future, responses will switch to `HTTP 429`.
