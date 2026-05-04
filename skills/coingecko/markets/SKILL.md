---
name: coingecko-markets
description: "CoinGecko crypto market-data API — top coins by market cap, search by name/symbol, per-coin details and historical price charts, global market overview (total market cap, BTC dominance, dominance breakdown). Free public tier, no auth. Yahoo Finance crypto-section replacement."
---

# coingecko-markets

CoinGecko crypto market-data API wrapper — every coin tracked by CoinGecko (10K+ active assets), top-by-market-cap rankings, per-coin price + market data, historical price series, and global crypto-market overview. Free public tier, no API key. The canonical open replacement for Yahoo Finance's crypto section.

Wraps `https://api.coingecko.com/api/v3`.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication on the free public tier. CoinGecko throttles aggressive callers; the script self-throttles to ~24 req/min (under the ~30/min free-tier ceiling). Heavy users can sign up for a paid Pro key — but this skill targets the free public tier exclusively.

## Usage

```bash
# Top coins by market cap (with 24h + 7d % change)
node scripts/coingecko.mjs top --limit=10
node scripts/coingecko.mjs top --limit=50 --vs=eur

# Search by name or symbol
node scripts/coingecko.mjs search "arbitrum" --limit=5
node scripts/coingecko.mjs search "doge"

# Full coin details (price, ATH, market cap, supply, description)
node scripts/coingecko.mjs view bitcoin
node scripts/coingecko.mjs view ethereum
node scripts/coingecko.mjs view solana

# Historical price (with ASCII chart)
node scripts/coingecko.mjs history bitcoin --days=90
node scripts/coingecko.mjs history ethereum --days=365 --vs=usd

# Global market overview
node scripts/coingecko.mjs global
```

## Output format

```
# CoinGecko — top 5 coins by market cap  (vs USD)

   #     Symbol    Price          24h       7d        Market cap     Volume24h
      1  BTC            $80,269    +2.09%    +4.79%        $1.61T     $55.88B  Bitcoin
      2  ETH          $2,359.07    +1.40%    +3.64%      $284.73B     $24.67B  Ethereum
      3  USDT         $0.999829    +0.00%    -0.02%      $189.55B     $87.88B  Tether
```

```
# CoinGecko — Bitcoin  (BTC)  rank #1
   genesis:    2009-01-03    homepage: http://www.bitcoin.org

   price:        $80,266     ATH $126,080 (2025-10-06)
   24h change:   +2.09%
   7d change:    +4.79%
   30d change:   +19.16%
   1y change:    -15.97%
   market cap:   $1.61T    fdv: $1.61T
   24h volume:   $55.88B
   circulating:  20,023,521    total: 20,023,521    max: 21,000,000
```

## Data layout

All state under `~/.local/share/showrun/data/coingecko/cache/`:

- `top-{vs}-{limit}.json` — top-by-mcap (5 min TTL)
- `view-{coin-id}.json` — single-coin details (5 min TTL)
- `history-{coin-id}-{vs}-{days}d.json` — historical chart (5 min TTL)
- `search-{slug}.json` — search results (24 h TTL)
- `global.json` — global market overview (5 min TTL)

Price data is cached for 5 minutes only (it moves). Search results are cached 24 h.

## Coin IDs

CoinGecko uses **slug-form IDs** (lowercase, hyphenated): `bitcoin`, `ethereum`, `solana`, `arbitrum`, `binancecoin`, `the-open-network`. Use `search` to find the canonical ID for any name/symbol.

## API notes

- **Base**: `https://api.coingecko.com/api/v3/`
- **Top by mcap**: `GET /coins/markets?vs_currency=usd&order=market_cap_desc&per_page=N&page=1&price_change_percentage=24h,7d` — pass `vs_currency=` for any of: `usd`, `eur`, `gbp`, `jpy`, `btc`, `eth`, etc.
- **Search**: `GET /search?query=foo` — returns `{ coins: [{id, symbol, name, market_cap_rank}] }`.
- **Coin details**: `GET /coins/{id}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`
- **Historical chart**: `GET /coins/{id}/market_chart?vs_currency=usd&days=N` — returns `{ prices: [[ts, price], ...], market_caps: [...], total_volumes: [...] }`. `days` ∈ 1, 7, 14, 30, 90, 180, 365, max.
- **Global**: `GET /global` — returns total market cap, dominance breakdown by symbol.
- **Rate limit**: ~10–30 req/min on free tier (CoinGecko doesn't publish exact numbers; `429 Too Many Requests` on excess).
- **Reference**: <https://www.coingecko.com/en/api/documentation>

## Known pitfalls

- **Slug IDs ≠ symbols.** `view btc` does **not** work; the ID is `bitcoin`. Always run `search "btc"` first to resolve the ID.
- **Free-tier rate limit is unstable.** CoinGecko publicly says ~10–30 req/min but in practice it varies by hour. Script does up to 3 retries with backoff on 429/503.
- **Symbol collisions.** Multiple projects share symbols (e.g., several coins use `MOON`). The `top`/`view` commands disambiguate by ID; `search` shows all matches with their ranks.
- **Stablecoins look "stable" but small movements matter.** USDT showing `+0.00%` actually means rounding to 2 decimals — the underlying number can drift 0.1–0.3 % from peg, which is operationally significant for arbitrage.
- **Historical-chart granularity changes with `days`.** `days=1` returns minutely; `days=7` 5-min; `days=30+` daily. The script downsamples to ~30 buckets for the ASCII chart regardless.
- **`fdv` (fully-diluted valuation)** uses `max_supply * price`. For tokens with no fixed cap (like ETH), CoinGecko reports `null` — script renders as `-`.
- **Pre-IPO tokens / unlisted-on-CG assets are missing.** Coverage is broad but not exhaustive. For comprehensive coverage you'd cross-reference DefiLlama (a future skill).
