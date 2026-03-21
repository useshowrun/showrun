# Twitter/X Agent Browser Skills

Scrapes Twitter/X public data: profiles, tweets, and search results.
No login required for public accounts.

## Strategy

Twitter/X uses internal GraphQL APIs authenticated with:
1. A **Bearer token** (public, constant — embedded in Twitter's web app)
2. A **guest token** (automatically set as a cookie when you visit x.com)
3. A **CSRF token** (ct0 cookie, set alongside guest token)

We use camoufox (fingerprinted Firefox) to:
1. Load x.com → automatically receives guest token + cookies
2. Make authenticated GraphQL API calls from within the browser context
3. Intercept GraphQL XHR calls as a fallback if direct API calls fail

## Prerequisites

```bash
cd twitter && npm install
```

Requires: Node.js v22+, camoufox-js

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Profile](twitter-profile/SKILL.md) | `twitter-profile/scripts/twitter-profile.mjs` | Fetch user profile + recent tweets |
| [Tweets](twitter-tweets/SKILL.md) | `twitter-tweets/scripts/twitter-tweets.mjs` | Paginate user timeline with cursor support |
| [Search](twitter-search/SKILL.md) | `twitter-search/scripts/twitter-search.mjs` | Search tweets by keyword/hashtag/query |

## Quick Start

```bash
# Profile + tweets
node twitter-profile/scripts/twitter-profile.mjs NASA 20

# Just tweets (paginated)
node twitter-tweets/scripts/twitter-tweets.mjs elonmusk 100

# Search
node twitter-search/scripts/twitter-search.mjs "#AI" 30 --mode latest
```

## GraphQL Endpoints Used

| Operation | Endpoint | Purpose |
|-----------|----------|---------|
| UserByScreenName | `/graphql/{id}/UserByScreenName` | Fetch user profile |
| UserTweets | `/graphql/{id}/UserTweets` | Fetch user's tweet timeline |
| SearchTimeline | `/graphql/{id}/SearchTimeline` | Search tweets |
| TweetDetail | `/graphql/{id}/TweetDetail` | Single tweet + replies |

## Known Limitations

- **Protected accounts**: No tweets visible without login
- **Rate limiting**: Twitter applies guest rate limits; add delays between requests
- **Query IDs**: May change after Twitter deploys (update QUERY_IDS in lib/utils.mjs)
- **Media URLs**: Video variant URLs may expire after some time
- **Guest token**: Obtained automatically; persists for the browser session

## Output Format

All scripts write `RESULT:{json}` to stdout, logs to stderr.

## Updating Query IDs

If scripts stop working (HTTP 400 or empty results), the query IDs may have changed.
To find new IDs:
1. Open x.com in Chrome DevTools → Network tab
2. Filter by "graphql"
3. Find a UserByScreenName / UserTweets / SearchTimeline request
4. The queryId is the first path segment after `/graphql/`
5. Update `QUERY_IDS` in `lib/utils.mjs`
