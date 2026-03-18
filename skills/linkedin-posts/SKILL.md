# linkedin-posts

View LinkedIn posts in detail, read comments, see reactions, and interact — like, react, comment, all from the terminal.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/anthropics/claude-code) skill (only for `auth` step)

## Setup

One-time authentication — extracts session cookies from any open LinkedIn tab:

```bash
node scripts/linkedin-posts.mjs auth
```

## Usage

### View your home feed

```bash
node scripts/linkedin-posts.mjs my-feed
node scripts/linkedin-posts.mjs my-feed --count=20 --start=0
```

### Fetch a specific user's posts

```bash
node scripts/linkedin-posts.mjs feed emrahyalaz
node scripts/linkedin-posts.mjs feed emrahyalaz --count=20
```

### View full post details

```bash
# By activity ID
node scripts/linkedin-posts.mjs details 7437485807881453568

# By full URN
node scripts/linkedin-posts.mjs details urn:li:activity:7437485807881453568

# By LinkedIn URL
node scripts/linkedin-posts.mjs details https://linkedin.com/feed/update/urn:li:activity:7437485807881453568/
```

### View comments on a post

```bash
node scripts/linkedin-posts.mjs comments 7437485807881453568
node scripts/linkedin-posts.mjs comments 7437485807881453568 --count=20 --start=0
```

### View who reacted

```bash
node scripts/linkedin-posts.mjs reactions 7437485807881453568
```

### React to a post

```bash
# Like (default)
node scripts/linkedin-posts.mjs like 7437485807881453568

# Other reactions
node scripts/linkedin-posts.mjs like 7437485807881453568 --type=PRAISE
node scripts/linkedin-posts.mjs like 7437485807881453568 --type=EMPATHY
```

Reaction types: `LIKE`, `PRAISE`, `EMPATHY`, `INTEREST`, `APPRECIATION`, `ENTERTAINMENT`

### Remove your reaction

```bash
node scripts/linkedin-posts.mjs unlike 7437485807881453568
```

### Comment on a post

```bash
node scripts/linkedin-posts.mjs comment 7437485807881453568 "Great post! Thanks for sharing."
```

### Like or unlike a comment

```bash
# Get comment IDs from the comments command first
node scripts/linkedin-posts.mjs comments 7437485807881453568

# Like a comment (use the numeric comment ID from the commentUrn)
node scripts/linkedin-posts.mjs like-comment 7437485807881453568 7437585224600834049

# Unlike a comment
node scripts/linkedin-posts.mjs unlike-comment 7437485807881453568 7437585224600834049
```

### Reply to a comment

```bash
node scripts/linkedin-posts.mjs reply 7437485807881453568 7437585224600834049 "Great point!"
```

### Repost (instant)

```bash
node scripts/linkedin-posts.mjs repost 7437485807881453568
```

### Repost with your thoughts

```bash
node scripts/linkedin-posts.mjs repost-with-thoughts 7437485807881453568 "This is an incredible development!"
```

### Show help

```bash
node scripts/linkedin-posts.mjs
```

## How it works

1. **`auth`** — Extracts LinkedIn cookies via CDP `Network.getCookies`.

2. **`my-feed`** — Calls `voyagerFeedDashMainFeed` GraphQL query to fetch your personalized LinkedIn home feed. Filters out ads/promotions.

3. **`feed`** — Calls `identity/profileUpdatesV2` with `q=memberShareFeed` to fetch a specific user's posts. Returns text, engagement metrics, and activity URNs.

3. **`details`** — Calls `feed/updates/<activityUrn>` for the full post including author info, text, linked articles, reshare data, and engagement breakdown.

4. **`comments`** — Calls `voyagerSocialDashComments` GraphQL endpoint with the post's `socialDetailUrn`. Returns comment text, author, like count, and reply count. Supports pagination.

5. **`reactions`** — Calls `voyagerSocialDashReactions` GraphQL endpoint to list who reacted, with their name, headline, and reaction type.

6. **`like`** — POST to `voyagerSocialDashReactions?threadUrn=<activityUrn>` with `{"reactionType":"LIKE"}`. Supports all 6 LinkedIn reaction types.

7. **`unlike`** — Calls the `voyagerSocialDashReactions` GraphQL mutation to remove your reaction.

8. **`comment`** — POST to `voyagerSocialDashComments` with the comment text and thread URN.

9. **`like-comment`** / **`unlike-comment`** — Same reaction GraphQL mutations as posts, but with a comment-specific `threadUrn` format: `urn:li:comment:(activity:<activityId>,<commentId>)`.

10. **`reply`** — POST to `voyagerSocialDashComments` with both `threadUrn` (activity) and `parentCommentUrn` (the comment being replied to).

11. **`repost`** — Calls `voyagerFeedDashReposts` GraphQL mutation with the original post's `rootContentUrn` (share URN). Fetches post details first to resolve the share URN.

12. **`repost-with-thoughts`** — POST to `feed/shares` with commentary text and `resharedUpdate` reference to the original share URN.

## Data storage

```
~/.local/share/showrun/data/linkedin-posts/
├── session.json                           # Auth cookies & CSRF token
├── profiles.json                          # Cached profile URN lookups
└── cache/
    ├── feed-<vanityName>.json             # User's posts
    ├── post-<activityId>.json             # Single post details
    ├── comments-<activityId>.json         # Post comments
    └── reactions-<activityId>.json        # Post reactions
```

## Session expiry

If you see `Session expired`, open LinkedIn in Chrome and re-run:

```bash
node scripts/linkedin-posts.mjs auth
```
