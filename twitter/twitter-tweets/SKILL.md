# twitter-tweets

Paginates through a public Twitter/X user's tweet timeline.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/twitter
node twitter-tweets/scripts/twitter-tweets.mjs <username> [maxTweets] [--cursor <cursor>] [--replies] [--retweets]
```

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| username | Yes | — | Twitter/X username (with or without @) |
| maxTweets | No | 50 | Maximum number of tweets to fetch |
| --cursor | No | — | Resume pagination from a cursor value |
| --replies | No | false | Include reply tweets |
| --retweets | No | false | Include retweet entries |

## Examples

```bash
# Get 50 tweets from NASA
node twitter-tweets/scripts/twitter-tweets.mjs NASA 50

# Get 100 tweets including replies
node twitter-tweets/scripts/twitter-tweets.mjs elonmusk 100 --replies

# Resume from cursor (for pagination)
node twitter-tweets/scripts/twitter-tweets.mjs NASA 50 --cursor "DAABCgABF..."
```

## Output

```json
{
  "username": "NASA",
  "userId": "11348282",
  "tweets": [
    {
      "id": "...",
      "url": "https://x.com/NASA/status/...",
      "text": "...",
      "hashtags": [],
      "urls": [],
      "mentions": [],
      "media": [],
      "createdAt": "...",
      "likeCount": 5000,
      "retweetCount": 500,
      "replyCount": 100,
      "viewCount": 100000,
      "isRetweet": false,
      "isReply": false
    }
  ],
  "meta": {
    "tweetsReturned": 50,
    "hasMore": true,
    "nextCursor": "DAABCgABF...",
    "includeReplies": false,
    "includeRetweets": false
  }
}
```
