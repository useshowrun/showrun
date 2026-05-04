# patentsview-patents

USPTO PatentsView Search v1 API wrapper — every U.S. patent ever granted, with full inventor / assignee / CPC / abstract metadata. The canonical free source for U.S. patent data. Free API key required (instant signup; no quota beyond 45 req/min). Useful for R&D activity tracking, innovation indicators, hiring leading-indicators, and corporate competitive analysis.

Wraps `https://search.patentsview.org/api/v1/`. The same dataset that powers <https://patentsview.org/>.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)
- Free PatentsView API key

## Setup

Request a free key (typically issued within minutes by email): <https://patentsview.org/apis/keys>

Save in either of:

```bash
export PATENTSVIEW_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" > ~/.local/share/showrun/data/patentsview/token.txt
```

The key is sent as `X-Api-Key:` header. Rate limit: **45 req/min** — script self-throttles to ~37/min.

## Usage

```bash
# Search by patent title (phrase)
node scripts/patentsview.mjs search "neural network" --from=2024-01-01 --limit=20
node scripts/patentsview.mjs search "lithium battery" --from=2023-01-01 --limit=10

# Patents by assignee (company / institution)
node scripts/patentsview.mjs assignee "Anthropic" --limit=10
node scripts/patentsview.mjs assignee "OpenAI" --limit=20
node scripts/patentsview.mjs assignee "Apple" --from=2025-01-01 --limit=25

# Patents by inventor name
node scripts/patentsview.mjs inventor "Geoffrey Hinton" --limit=15
node scripts/patentsview.mjs inventor "Yoshua Bengio"

# Single patent details (8-digit utility patent ID)
node scripts/patentsview.mjs view 11111111
```

## Output format

```
# PatentsView — patents assigned to "Anthropic"
   total: 12    showing 5

   2025-08-12  12345678   Hierarchical attention layers for transformer models
              assignees: Anthropic PBC
   2025-04-22  12012345   Constitutional AI training pipeline
              assignees: Anthropic PBC
   ...
```

```
# Patent 11111111
   title:     A clever invention
   date:      2021-09-07    type: utility
   assignees: Some Big Co.
   inventors: Jane Doe | John Smith
   CPC:       G06N3/08 (Neural networks) | H04L9/00 (Cryptography)

   abstract:  A method and system for...
```

## Data layout

All state under `~/.local/share/showrun/data/patentsview/cache/`:

- `search-{slug}-{from}-{to}-{limit}.json`
- `assignee-{slug}-{from}-{limit}.json`
- `inventor-{slug}-{limit}.json`

Patents are immutable once granted, so cache TTL is 7 days.

## API notes

- **Base**: `POST https://search.patentsview.org/api/v1/{endpoint}/` — `endpoint` ∈ {`patent`, `assignee`, `inventor`, `cpc_class`, `location`, `g_brf_sum_text`, …}.
- **Auth**: `X-Api-Key: <key>` header on every request.
- **Body shape**:
  ```json
  {
    "q":  { "_and": [ { "_text_phrase": { "patent_title": "neural network" } },
                       { "_gte":          { "patent_date": "2024-01-01" } } ] },
    "f":  ["patent_id", "patent_title", "patent_date", "assignees.assignee_organization"],
    "o":  { "size": 25, "page": 1 },
    "s":  [{ "patent_date": "desc" }]
  }
  ```
- **Operators**: `_eq`, `_neq`, `_gt`, `_gte`, `_lt`, `_lte`, `_contains` (case-insensitive substring), `_text_phrase` (full-text phrase), `_text_any` (full-text any-word), `_begins`, `_and`, `_or`, `_not`.
- **Nested fields**: dotted paths like `assignees.assignee_organization`, `inventors.inventor_name_last`, `cpc_current.cpc_class_id`.
- **Response**: `{ patents: [...], total_hits, count }` for the patent endpoint.
- **Reference**: <https://patentsview.org/apis/api-endpoints/api-endpoints-search>

## Known pitfalls

- **Title-only search.** `search "<phrase>"` matches the patent *title* via `_text_phrase`, not the full text or claims. For abstract or claim search you'd need the `_text_phrase` operator on `patent_abstract` or `claims_text` (these endpoints exist but aren't wired up here yet).
- **`_contains` is substring, not fuzzy.** `assignee "Anthropic"` matches `Anthropic PBC`, `Anthropic, Inc.`, but not `ANTHROPIC` if assignees are case-sensitive in storage (they vary by year). Try multiple casings if hit count is suspiciously low.
- **Patent IDs come in two flavors.** Utility patents have 8-digit numeric IDs (e.g. `11111111`). Design patents have a leading `D` (e.g. `D923456`); plant patents `PP`. The `view` command takes whatever you pass as a string.
- **Assignee ≠ inventor's employer at filing time.** A patent can be assigned to the inventor's employer, a parent corp, a holding co, an investor, or remain unassigned. "Patents assigned to Anthropic" excludes patents *invented* at Anthropic but assigned elsewhere.
- **Filing date vs. grant date.** `patent_date` is the **grant** date — patents filed today will show up 1–4 years from now. For real-time R&D-velocity signals, you'd need application-level data (different endpoint, not yet wired up).
- **Backfill lag.** PatentsView refreshes weekly. Patents granted in the last 5–10 days may not be indexed yet.
- **Result cap.** PatentsView v1 caps page-size at 1000 and total reachable hits at 100 000 per query. The script enforces page size up to 1000.
