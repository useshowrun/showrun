# similarweb-market

Industry/market analysis from SimilarWeb: website rankings by industry, market leaders, rising/declining players, and industry benchmarks.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- A SimilarWeb Pro account (logged in at pro.similarweb.com)

## Setup

If you already have a `similarweb-website` session, auth will reuse it automatically:

```bash
node similarweb-market.mjs auth
```

Otherwise, open SimilarWeb Pro in Chrome, log in, then run auth.

## Usage

```bash
# List all 216 industries
node similarweb-market.mjs industries
node similarweb-market.mjs industries finance     # filter by keyword

# Top websites in an industry by traffic share
node similarweb-market.mjs leaders AI_Chatbots_and_Tools
node similarweb-market.mjs leaders "E-commerce and Shopping" --country=840 --count=50
node similarweb-market.mjs leaders All --count=10

# Filter by traffic source
node similarweb-market.mjs leaders AI_Chatbots_and_Tools --source=Desktop
node similarweb-market.mjs leaders AI_Chatbots_and_Tools --source=Mobile

# Custom date range
node similarweb-market.mjs leaders AI_Chatbots_and_Tools --from=2025-12 --to=2026-02

# Sub-industry analysis
node similarweb-market.mjs leaders "Computers Electronics and Technology > Programming and Developer Software"

# Rising and declining websites in a market
node similarweb-market.mjs trends AI_Chatbots_and_Tools
node similarweb-market.mjs trends Finance --country=840 --count=15

# Industry benchmarks: averages, medians, market concentration
node similarweb-market.mjs benchmarks AI_Chatbots_and_Tools
node similarweb-market.mjs benchmarks "News and Media" --country=826
```

## Account tier

All commands work on the free (Basic) SimilarWeb account, **but `leaders`, `trends`, and `benchmarks` are silently paywalled**.

**Silent paywall — `leaders`**: The API returns `domains[]` of whatever length you requested (default 50), but **only positions 1–5 are real**. Indexes `[5..]` ship back with `domain: "grid.upgrade"` and fake metrics. `totalDomains` shows the true industry size (e.g. 70) while free tier sees 5 names. Verified across `--country=999` and `--country=840`.

**Silent paywall — `trends`**: `rising[]` and `declining[]` are almost entirely `grid.upgrade` placeholders on free. For AI_Chatbots_and_Tools, only 1 of 10 rising domains and 0 of 10 declining domains were real.

**Silent paywall — `benchmarks`**: The script computes averages, medians, and concentration locally from `leaders` output. On free tier, `grid.upgrade` placeholders are included in the math, so **all benchmarks are numerically meaningless** — treat them as useless until upgraded.

**Country filter is NOT enforced on `leaders`** (verified `--country=840` returned data), though the result still has placeholder-padded lists past position 5.

Detection pattern: filter out any item whose `domain` contains `grid.upgrade` before trusting the data.

## How it works

1. **auth** -- Reuses the `similarweb-website` session if available, otherwise extracts cookies from a Chrome tab open to pro.similarweb.com.

2. **industries** -- Calls `GET /api/startupSettings` and extracts the industry tree. Lists all 216 industries with sub-industries. Accepts an optional filter keyword.

3. **leaders** -- Calls `GET /api/Market/Leaders/Table` with industry and country params. Returns top websites ranked by traffic share, with engagement metrics (visits, bounce rate, pages/visit, duration), unique users, global and industry rank, device split, and month-over-month change.

4. **trends** -- Uses the same Market Leaders API sorted by month-over-month change. Returns the fastest-rising websites (biggest positive MoM change) and fastest-declining websites (biggest negative MoM change) in the industry.

5. **benchmarks** -- Computes industry-wide averages and medians from the leaders data: total market visits, avg/median bounce rate, pages/visit, visit duration, device split, and market concentration (top 1/3/10 share).

## Filters

### Traffic source (`--source`)
- `Total` — All traffic (default)
- `Desktop` — Desktop-only traffic
- `Mobile` — Mobile web traffic only

### Date range (`--from`, `--to`)
- Format: `YYYY-MM` (e.g., `--from=2025-12 --to=2026-02`)
- Default: last 3 complete months
- Note: SimilarWeb data lags ~1 month; the allowed date range is limited by your plan

### Page-level tabs (Search, Social, etc.)
The tabs visible in the SimilarWeb UI (Search, Social, Display, Referral, Direct, Email) are **client-side re-sorts** of the same dataset — the API returns all data in one call. The `--source` flag (Total/Desktop/Mobile) is the only server-side traffic filter.

## Industry formats

Industries can be specified in several ways:
- Underscore format: `AI_Chatbots_and_Tools`
- Space format (quoted): `"AI Chatbots and Tools"` (auto-converted)
- Sub-industry with `~`: `Computers_Electronics_and_Technology~Programming_and_Developer_Software`
- Sub-industry with `>`: `"Computers Electronics and Technology > Programming and Developer Software"`
- All industries: `All`

## Data storage

```
~/.local/share/showrun/data/similarweb-market/
  session.json                                              # Auth cookies
  cache/
    ai_chatbots_and_tools-leaders-999-total.json            # Cached command outputs
    ai_chatbots_and_tools-leaders-999-desktop.json
    ai_chatbots_and_tools-trends-999-total.json
    ai_chatbots_and_tools-benchmarks-999-total.json
```

## Session expiry

SimilarWeb sessions last days to weeks. If you get 401/403 errors, re-run:

```bash
node similarweb-market.mjs auth
```
