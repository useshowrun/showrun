---
name: similarweb-free-market
description: "Web market / industry analysis from a SimilarWeb FREE account: list 200+ industry categories and rank the top + rising websites in any industry by traffic share, visits, engagement, and month-over-month change."
---

# similarweb-free-market

Industry/market analysis available to a **free / expired-trial** SimilarWeb account. This is the free-tier counterpart of `similarweb-market` (which needs a SimilarWeb Pro plan).

What the free tier gives you:
- The last **3 complete months** of data, **worldwide**.
- The combined **"All traffic"** channel only — per-channel industry rankings
  (Search, Social, Display, Referral, Direct, Email, Gen AI, Affiliates) are
  crown-locked behind a paid plan.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- A SimilarWeb account (free is fine), logged in at pro.similarweb.com

## Setup

Open SimilarWeb in Chrome and log in, then run:

```bash
node similarweb-free-market.mjs auth
```

## Usage

```bash
# List every industry category (216 of them)
node similarweb-free-market.mjs industries

# Filter the category list by substring
node similarweb-free-market.mjs industries music
node similarweb-free-market.mjs industries shopping

# Top + rising websites in an industry
node similarweb-free-market.mjs leaders Arts_and_Entertainment
node similarweb-free-market.mjs leaders Arts_and_Entertainment/Music
node similarweb-free-market.mjs leaders E-commerce_and_Shopping --count=50
```

## Commands

| Command | API endpoint | Returns |
|---|---|---|
| `auth` | CDP cookie extraction | Saves session cookies |
| `industries [search]` | `/api/categories` | All industry categories (top-level + subcategories), optionally substring-filtered |
| `leaders <industry>` | `/api/Market/Leaders/Table` | Per website: global & category rank, market share, avg monthly visits, unique visitors, bounce rate, pages/visit, visit duration, MoM change, desktop/mobile split. Includes `topPlayers` and `risingPlayers`. |

Industry keys are the `industry` values returned by the `industries` command —
either a top-level name (`Arts_and_Entertainment`) or `Parent/Sub`
(`Arts_and_Entertainment/Music`).

## Data storage

```
~/.local/share/showrun/data/similarweb-free-market/
  session.json                              # Auth cookies
  cache/
    industries.json
    Arts_and_Entertainment_Music-leaders.json
```

## Session expiry

SimilarWeb sessions last days to weeks. On 401/403 errors, re-run
`node similarweb-free-market.mjs auth` with an active SimilarWeb tab open in Chrome.
