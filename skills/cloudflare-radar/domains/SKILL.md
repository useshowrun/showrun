---
name: cloudflare-radar-domains
description: "Traffic / DNS / routing intelligence from Cloudflare Radar — domain rankings, traffic trends, attack data, top categories, AS info — as a research-grade alternative to Similarweb. Uses the public Cloudflare API at `api.cloudflare.com/client/v4/radar`."
---

# cloudflare-radar-domains

Traffic / DNS / routing intelligence from Cloudflare Radar — domain rankings, traffic trends, attack data, top categories, AS info — as a research-grade alternative to Similarweb. Uses the public Cloudflare API at `api.cloudflare.com/client/v4/radar`.

Unlike Similarweb's modeled estimates, Radar numbers come from real CDN logs and are research-grade.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)
- Free Cloudflare account → API token with `Radar:Read` scope

## Setup

Free Cloudflare account → **My Profile → API Tokens → Create Token → "Radar Read" template** (or a custom token with `Radar:Read` permission).

Save the token in either of:

```bash
export CLOUDFLARE_API_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" > ~/.local/share/showrun/data/cloudflare-radar/token.txt
```

Each request sends `Authorization: Bearer <token>`. There is a Cloudflare global rate limit (1200 req/5min) that the script does not enforce — keep one-shot calls to <100/run.

## Usage

```bash
# Top global domains by Cloudflare DNS resolver popularity
node scripts/cloudflare-radar.mjs top                     # top 100 worldwide, last 7d
node scripts/cloudflare-radar.mjs top --location=US --limit=50
node scripts/cloudflare-radar.mjs top --date-range=30d

# Top domains in a specific industry vertical
node scripts/cloudflare-radar.mjs top --category=Gaming --limit=25
node scripts/cloudflare-radar.mjs categories             # list all category names

# Per-domain rank + trend
node scripts/cloudflare-radar.mjs domain itch.io
node scripts/cloudflare-radar.mjs domain steamcommunity.com --date-range=90d

# Domain summary card (categories, similar sites if available)
node scripts/cloudflare-radar.mjs details itch.io

# HTTP traffic share by country (one row per country, sorted by share)
node scripts/cloudflare-radar.mjs http-locations          # global last 7d
node scripts/cloudflare-radar.mjs http-locations --date-range=24h

# DNS resolver popularity by ASN
node scripts/cloudflare-radar.mjs as <asn>                # e.g. AS13335 (Cloudflare itself)

# Internet outage / quality events
node scripts/cloudflare-radar.mjs events                  # latest detected outages (last 7d)

# Raw passthrough — any GET endpoint under /radar/
node scripts/cloudflare-radar.mjs raw "/radar/datasets?dateRange=7d"
```

`--date-range` accepts: `1d`, `24h`, `7d`, `14d`, `28d`, `30d`, `90d`, `52w`.

`--location` accepts ISO 3166-1 alpha-2 codes: `US`, `GB`, `DE`, `JP`, `BR`, `IN`, `TR`, etc.

## Output format

```
# Cloudflare Radar — top domains  (location=GLOBAL, range=7d)
   1. google.com
   2. youtube.com
   3. facebook.com
   ...

# Cloudflare Radar — itch.io  (range=7d)
   bucket=top_50000  rank≈12,034  category=Games
   trend (last 7 buckets): +2.1%  flat→growing
```

## Data layout

All state under `~/.local/share/showrun/data/cloudflare-radar/`:

- `token.txt` — your API token (optional; `CLOUDFLARE_API_TOKEN` env wins)
- `cache/top-<location>-<range>-<limit>.json` — per `top` invocation
- `cache/domain-<domain>-<range>.json` — per `domain` invocation
- `cache/categories.json` — last `categories` fetch
- `cache/raw-<slug>.json` — last `raw` invocation

## API notes

- **Base**: `https://api.cloudflare.com/client/v4/radar/`
- **Documentation**: https://developers.cloudflare.com/radar/
- All Radar endpoints respond with `{result: {...}, success: bool, errors: [], messages: []}`. The script unwraps `result` and surfaces upstream errors verbatim.
- **No `radar/domains/<domain>` endpoint** exists for an individual rank lookup — instead, query `radar/ranking/top?limit=10000` and locate the domain client-side.
- **Bucketed ranks**: Cloudflare publishes ranks in *buckets* (`top_100`, `top_200`, ..., `top_1000000`) rather than continuous integers — accept this ambiguity in any downstream reasoning.

## Known pitfalls

- **Token scope.** A token without `Radar:Read` returns `403 Authentication error`.
- **Date-range string varies by endpoint.** A few endpoints accept only a subset of ranges; the script logs the rejection and falls back to `7d` once before giving up.
- **Bucketed ranks blur small-domain comparison.** A domain at rank 50,001 and rank 99,999 may both be reported as `top_100000` — useful for trend direction, weak for absolute comparison.
- **Free tier is generous but not infinite.** ~1200 req/5min global.
