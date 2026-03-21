# Skill: yelp-search

Search Yelp for businesses by keyword and location using the homepage typeahead GQL strategy.

## Script

```
node scripts/yelp-search.mjs [options]
```

## Options (env vars)

| Variable | Description | Default |
|----------|-------------|---------|
| `QUERY` | Search query (e.g., "coffee", "pizza") | **required** |
| `LOCATION` | Location string (e.g., "San Francisco, CA") | **required** |
| `MAX_RESULTS` | Max number of results to return (1–20) | `10` |
| `INCLUDE_DETAIL` | Set to `1` to load each biz page for full GQL data | — |
| `SOCKS5_PROXY` | Residential proxy (required to bypass DataDome) | `127.0.0.1:11091` |
| `MAX_RETRIES` | Retry attempts on failure | `3` |

## Output format

```
RESULT:{"businesses": [...], "total": N, "returned": N, "query": "...", "location": "...", "searchMethod": "typeahead-gql"}
```

Each business (without INCLUDE_DETAIL):
```json
{
  "rank": 1,
  "name": "Sightglass Coffee",
  "slug": "sightglass-coffee-san-francisco-7",
  "url": "https://www.yelp.com/biz/sightglass-coffee-san-francisco-7",
  "address": "270 Seventh St, San Francisco",
  "rating": null,
  "reviewCount": null,
  "priceRange": null,
  "categories": [],
  "isSponsored": false,
  "thumbnailUrl": null
}
```

With INCLUDE_DETAIL=1, each business includes full GQL data (same format as yelp-business).

## Anti-bot notes (updated 2026-03-21)

### Strategy change: typeahead-based search

Yelp's `/search` page is persistently blocked by DataDome for non-browser IPs and
even residential proxies that have made too many requests. The IP-level block is
triggered by the `/search` endpoint fingerprint and persists for hours.

**New approach:** Instead of navigating to `/search`, this skill:
1. Loads the Yelp homepage (passes DataDome JS challenge via camoufox)
2. Sets the location field via JS
3. Types the query character by character in the search box
4. Each keystroke triggers `searchSuggestFrontend` GQL calls
5. Collects `type:"business"` entries (have `/biz/` redirect URLs)
6. Optionally loads each business page for full detail

### Known limitations

- Returns **typeahead suggestions** (~5-10 businesses), not full paginated search
- Results are the most relevant matches for the query+location based on Yelp's typeahead algorithm
- May include non-obvious matches (typeahead returns popular businesses even if category differs)
- For broader search coverage, Yelp Fusion API requires an API key
- If same residential IP sends many requests quickly, DataDome flags it for hours
  → Recommend 5+ minute cooldown between sessions on the same IP

### IP management
- Requires residential SOCKS5 proxy
- DataDome blocks IPs that send too many requests in a short window
- The block is temporary (~30min to few hours)
- Recommend running max 2-3 searches per hour on the same proxy IP
