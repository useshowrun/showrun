# metaculus-questions

Community forecast predictions from Metaculus — especially for long-horizon, technical, or scientific questions where Metaculus's forecaster community is stronger than prediction markets. Covers binary, continuous, multiple-choice, and date questions. Uses the official `/api/posts/` endpoint.

Metaculus wraps each forecasting question in a "Post" — posts carry the title/description/tournament metadata while the nested `question` carries the aggregated community prediction.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)
- Free Metaculus account + API token (anonymous API access disabled in early 2026)

## Setup — token REQUIRED

Metaculus disabled anonymous API access in early 2026. As of 2026-04-10 every path under `/api/` and `/api2/` returns:

```
HTTP 403
Permission Error: The API is only available to authenticated users. Please create an account and use your API token to access the API.
```

Get a free token at **https://www.metaculus.com/accounts/settings/** (section "API Access"). Provide it via either:

```bash
export METACULUS_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" > ~/.local/share/showrun/data/metaculus/token.txt
```

The script sends `Authorization: Token <token>` on every request. Metaculus throttles to 1000 req/hour.

The two offline commands (`view-cache`, `search-cache`) work without a token against whatever has already been fetched into the local index.

## Usage

```bash
# Listings (live)
node scripts/metaculus-questions.mjs latest [N]              # newest open, default N=20
node scripts/metaculus-questions.mjs top [N]                 # most-forecasted open
node scripts/metaculus-questions.mjs search <keyword>        # live keyword search (up to 120)

# Detail (live)
node scripts/metaculus-questions.mjs question <id>           # one post with CP + criteria

# Tournaments / projects
node scripts/metaculus-questions.mjs tournament <slug> [N]   # posts in one tournament by slug
node scripts/metaculus-questions.mjs tournaments             # slugs seen in local index

# Offline (no network / no token)
node scripts/metaculus-questions.mjs view-cache <id>         # cached question detail
node scripts/metaculus-questions.mjs search-cache <keyword>  # grep local index.jsonl
```

## Output format

```
- [binary] Will <title>...? (Q#<id>)
    community=42%  metaculus=?   close=2026-12-31  forecasts=123  status=open
    https://www.metaculus.com/questions/<id>/<slug>/
    <truncated description, ~300 chars>
```

- `community=` is the latest aggregated community prediction. For `binary` questions it's rendered as a percentage; for `numeric` / `date` it's unscaled via `question.scaling.range_min/range_max` and shown as a number or YYYY-MM-DD; for `multiple_choice` it's the top center as a percent.
- `metaculus=` is the (non-public-by-default) `metaculus_prediction` aggregation if present — usually `?` because it's restricted to admins/certain projects.
- For `resolved` posts, the `community=` field is replaced with `resolution=YES/NO/<value>`.

## Data layout

All state lives under `~/.local/share/showrun/data/metaculus/`:

- `token.txt` — your API token (optional; `METACULUS_TOKEN` env var takes precedence)
- `cache/latest.json` — last `latest` fetch
- `cache/top.json` — last `top` fetch
- `cache/search-<slug>.json` — one per live keyword search
- `cache/tournament-<slug>.json` — one per `tournament` fetch
- `cache/question-<id>.json` — per-question detail
- `cache/index.jsonl` — append-only log of every unique post seen, deduped by post `id`. Used by `search-cache` and `tournaments`.

## API notes (from Metaculus OpenAPI spec)

- **Primary endpoint**: `GET /api/posts/`
- **Detail**: `GET /api/posts/{id}/`
- Legacy `/api2/questions/` still forwards to the same handler.
- Documented query params actually used:
  - `statuses` — one of `upcoming`, `open`, `closed`, `resolved` (repeatable)
  - `forecast_type` — `binary`, `numeric`, `date`, `multiple_choice`, `conditional`, `group_of_questions`, `notebook`
  - `tournaments` — tournament/project slug (repeatable)
  - `order_by` — one of `published_at`, `forecasts_count`, `vote_score`, `comment_count`, `scheduled_close_time`, `scheduled_resolve_time`, `hotness`, `weekly_movement`, etc. Prefix with `-` for DESC.
  - `with_cp=true` — required to include community predictions in list responses
  - `limit` / `offset`
- **`search=` is NOT in the OpenAPI spec.** Server's Django REST framework still honors `?search=` on `/api/posts/`. If Metaculus removes it, fall back to `search-cache`.
- **There is no `GET /api/projects/` or `GET /api/tournaments/` listing endpoint.** The `tournaments` command walks the local `index.jsonl`.

## Schema notes

Each post's community prediction lives at:

```
post.question.aggregations.recency_weighted.latest.centers[0]     # preferred
post.question.aggregations.unweighted.latest.centers[0]           # fallback
```

- For `type == 'binary'`, `centers[0]` is a probability in `[0, 1]`.
- For `type == 'numeric'` / `'date'`, `centers[0]` is a normalised value in `[0, 1]`; unscale via `post.question.scaling.range_min` and `range_max` (linear). `zero_point`-based log-scaled questions are rendered with the same linear formula as a best effort.
- For `type == 'multiple_choice'`, `centers` is one probability per option; the skill only prints the top one.

Other useful fields: `post.title`, `post.slug`, `post.resolved`, `post.status`, `post.scheduled_close_time`, `post.forecasts_count`, `post.nr_forecasters`, `post.description`, `post.question.resolution`, `post.question.resolution_criteria`, `post.projects.default_project.slug` / `tournament` / `category` / `topic`.

## Known pitfalls

- **Token is required.** Every command except `view-cache` and `search-cache` hits the network and will fail fast with a clear error if no token is configured.
- **`metaculus_prediction` is usually null** for public posts — admin-only aggregation.
- **No server-side search is officially documented.** `search` leans on the undocumented `?search=` query param.
- **Tournament listing is local-only.** Run `tournaments` to see what the local index has collected.
- **Continuous-question unscaling is linear.** For questions with `scaling.zero_point != 0` (log-spaced continuous ranges) the rendered number may be off by a factor.
- **1000 req/hour throttle.** `search` paginates at 500ms between requests and caps at ~120 results.
