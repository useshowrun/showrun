# twitter-search

Searches Twitter/X for tweets matching a query, hashtag, or advanced search syntax.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/twitter
node twitter-search/scripts/twitter-search.mjs <query> [maxTweets] [--mode latest|top] [--cursor <cursor>]
```

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| query | Yes | — | Search query (hashtag, keyword, or advanced syntax) |
| maxTweets | No | 20 | Maximum number of tweets to return |
| --mode | No | latest | Sort mode: `latest` (chronological) or `top` (popular) |
| --cursor | No | — | Resume pagination from a cursor value |

## Advanced Query Syntax

Twitter supports these operators in the query:
- `#hashtag` — hashtag search
- `from:username` — tweets from a specific user
- `to:username` — replies to a specific user
- `"exact phrase"` — exact phrase match
- `-word` — exclude word
- `lang:en` — filter by language
- `min_faves:100` — minimum likes
- `min_retweets:50` — minimum retweets

## Examples

```bash
# Search by hashtag
node twitter-search/scripts/twitter-search.mjs "#SpaceX" 20

# Top tweets about OpenAI
node twitter-search/scripts/twitter-search.mjs "OpenAI" 10 --mode top

# Tweets from NASA
node twitter-search/scripts/twitter-search.mjs "from:NASA mars" 20

# Viral tweets about AI
node twitter-search/scripts/twitter-search.mjs "AI min_faves:1000" 30 --mode top
```

## Output

```json
{
  "query": "#SpaceX",
  "mode": "Latest",
  "tweets": [
    {
      "id": "...",
      "url": "https://x.com/user/status/...",
      "text": "Tweet text here #SpaceX",
      "hashtags": ["SpaceX"],
      "createdAt": "...",
      "likeCount": 500,
      "retweetCount": 100,
      "viewCount": 50000,
      "author": {
        "username": "...",
        "name": "...",
        "isBlueVerified": false
      },
      "media": [],
      "urls": [],
      "isRetweet": false
    }
  ],
  "meta": {
    "tweetsReturned": 20,
    "hasMore": true,
    "nextCursor": "..."
  }
}
```
