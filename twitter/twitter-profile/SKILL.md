# twitter-profile

Fetches a public Twitter/X user profile along with their recent tweets.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/twitter
node twitter-profile/scripts/twitter-profile.mjs <username> [maxTweets]
```

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| username | Yes | — | Twitter/X username (with or without @) |
| maxTweets | No | 20 | Maximum number of tweets to return |

## Examples

```bash
# Fetch NASA profile with 10 tweets
node twitter-profile/scripts/twitter-profile.mjs NASA 10

# Fetch with @ prefix (stripped automatically)
node twitter-profile/scripts/twitter-profile.mjs @elonmusk 20
```

## Output

```json
{
  "username": "NASA",
  "profile": {
    "id": "11348282",
    "username": "NASA",
    "name": "NASA",
    "bio": "Explore the universe...",
    "location": "Washington, D.C.",
    "website": "https://www.nasa.gov/",
    "createdAt": "Tue Sep 09 20:35:37 +0000 2008",
    "isVerified": false,
    "isBlueVerified": true,
    "profileImageUrl": "https://pbs.twimg.com/profile_images/...",
    "profileBannerUrl": "https://pbs.twimg.com/profile_banners/...",
    "followersCount": 88000000,
    "followingCount": 300,
    "tweetsCount": 69000,
    "listedCount": 90000,
    "likesCount": 4000,
    "mediaCount": 12000,
    "isProtected": false
  },
  "tweets": [
    {
      "id": "1234567890",
      "url": "https://x.com/NASA/status/1234567890",
      "text": "Tweet content here #Space",
      "hashtags": ["Space"],
      "urls": [],
      "mentions": [],
      "media": [
        {
          "type": "photo",
          "mediaUrl": "https://pbs.twimg.com/media/...",
          "width": 1920,
          "height": 1080,
          "altText": "..."
        }
      ],
      "language": "en",
      "createdAt": "Fri Mar 20 12:00:00 +0000 2026",
      "isRetweet": false,
      "isReply": false,
      "quoteCount": 5,
      "replyCount": 100,
      "retweetCount": 500,
      "likeCount": 5000,
      "viewCount": 100000,
      "bookmarkCount": 200,
      "author": {
        "id": "11348282",
        "username": "NASA",
        "name": "NASA",
        "isBlueVerified": true
      }
    }
  ],
  "meta": {
    "tweetsReturned": 20,
    "hasMore": true,
    "nextCursor": "..."
  }
}
```

## Limitations

- Only public profiles accessible without login
- Protected accounts return no tweets
- Rate limited by Twitter's guest token system
- Media videos include variant URLs (may expire)
