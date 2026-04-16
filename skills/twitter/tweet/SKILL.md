# twitter-tweet

Twitter/X tweet operations: fetch, post, delete, like, retweet, bookmark, and discover similar posts.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with x.com logged in (for `auth` command)
- [chrome-cdp](../../chrome-cdp) skill installed

## Setup

One-time authentication -- requires an active x.com session in Chrome:

    node scripts/twitter-tweet.mjs auth

## Usage

### Get a single tweet

    node scripts/twitter-tweet.mjs get <tweet_id>

Returns: full tweet with text (t.co links expanded), author info, metrics (replies, retweets, likes, quotes, bookmarks, views), media, quoted tweet, and reply context.

### Batch get tweets

    node scripts/twitter-tweet.mjs get-many <id1,id2,...>

Fetches multiple tweets in a single request. Pass comma-separated IDs.

### Get tweet thread and replies

    node scripts/twitter-tweet.mjs thread <tweet_id> [--cursor=X]

Returns the focal tweet, its parent thread, and replies. Supports pagination via `--cursor`.

### Post a tweet

    node scripts/twitter-tweet.mjs post <text> [--reply-to=tweet_id]

Creates a new tweet. Use `--reply-to` to reply to an existing tweet. The text is all positional arguments joined by spaces.

### Delete a tweet

    node scripts/twitter-tweet.mjs delete <tweet_id>

Deletes a tweet you own.

### Like / unlike

    node scripts/twitter-tweet.mjs like <tweet_id>
    node scripts/twitter-tweet.mjs unlike <tweet_id>

### Retweet / unretweet

    node scripts/twitter-tweet.mjs retweet <tweet_id>
    node scripts/twitter-tweet.mjs unretweet <tweet_id>

### Bookmark / unbookmark

    node scripts/twitter-tweet.mjs bookmark <tweet_id>
    node scripts/twitter-tweet.mjs unbookmark <tweet_id>

### List bookmarks

    node scripts/twitter-tweet.mjs bookmarks [--count=20] [--cursor=X]

Returns your bookmarked tweets with pagination.

### Who retweeted

    node scripts/twitter-tweet.mjs retweeters <tweet_id> [--count=20] [--cursor=X]

Returns a list of users who retweeted the tweet.

### Who liked

    node scripts/twitter-tweet.mjs likers <tweet_id> [--count=20] [--cursor=X]

Returns a list of users who liked the tweet.

### Similar posts

    node scripts/twitter-tweet.mjs similar <tweet_id>

Returns tweets similar to the given tweet.

## Rate limits

All limits reset every 15 minutes.

| Command | Endpoint | Limit/15min |
|---|---|---|
| `get` | GraphQL TweetResultByRestId | ~150 |
| `get-many` | GraphQL TweetResultsByRestIds | ~50 |
| `thread` | GraphQL TweetDetail | ~150 |
| `post` | GraphQL CreateTweet | ~50 |
| `delete` | GraphQL DeleteTweet | ~50 |
| `like` | GraphQL FavoriteTweet | ~50 |
| `unlike` | GraphQL UnfavoriteTweet | ~50 |
| `retweet` | GraphQL CreateRetweet | ~50 |
| `unretweet` | GraphQL DeleteRetweet | ~50 |
| `bookmark` | v2 timeline/bookmark | ~50 |
| `unbookmark` | GraphQL DeleteBookmark | ~50 |
| `bookmarks` | GraphQL Bookmarks | ~50 |
| `retweeters` | GraphQL Retweeters | ~75 |
| `likers` | GraphQL Favoriters | ~75 |
| `similar` | GraphQL SimilarPosts | ~50 |

## How it works

1. **`auth`** -- Connects to Chrome via CDP, finds an x.com tab, extracts all x.com/twitter.com cookies using `Network.getCookies`, reads the `ct0` CSRF token and `auth_token`, and extracts the logged-in user ID from the `twid` cookie. Saves session to disk.

2. **`get` / `get-many`** -- Calls `TweetResultByRestId` or `TweetResultsByRestIds` GraphQL endpoints. Formats the response: expands t.co links, extracts note tweets (long posts), handles quoted tweets and retweets recursively.

3. **`thread`** -- Calls the `TweetDetail` GraphQL endpoint with the focal tweet ID. Parses conversation thread entries and reply entries from the timeline response.

4. **`post`** -- Calls the `CreateTweet` GraphQL mutation. Supports replies via the `reply.in_reply_to_tweet_id` variable.

5. **`delete`** -- Calls the `DeleteTweet` GraphQL mutation.

6. **`like` / `unlike` / `retweet` / `unretweet`** -- Call `FavoriteTweet`, `UnfavoriteTweet`, `CreateRetweet`, `DeleteRetweet` GraphQL mutations.

7. **`bookmark`** -- Uses the v2 REST endpoint `POST /i/api/2/timeline/bookmark.json` with form-encoded body.

8. **`unbookmark`** -- Uses the `DeleteBookmark` GraphQL mutation.

9. **`bookmarks`** -- Calls the `Bookmarks` GraphQL endpoint with an extra `graphql_timeline_v2_bookmark_timeline` feature flag.

10. **`retweeters` / `likers`** -- Call the `Retweeters` / `Favoriters` GraphQL endpoints. Return user objects (not tweets).

11. **`similar`** -- Calls the `SimilarPosts` GraphQL endpoint.

## Data storage

    ~/.local/share/showrun/data/twitter/
    ├── session.json                     # Auth cookies (shared across twitter skills)
    └── cache/
        ├── tweet-<id>.json              # Single tweet
        ├── thread-<id>.json             # Thread + replies
        ├── bookmarks-<ts>.json          # Bookmark list
        ├── retweeters-<id>.json         # Retweeters list
        ├── likers-<id>.json             # Likers list
        └── similar-<id>.json            # Similar posts

## Session expiry

Twitter sessions typically last several weeks. If you get 401/403 errors, re-run `auth`.
