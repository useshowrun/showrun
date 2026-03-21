# Facebook Posts Scraper

Scrape posts and profile data from public Facebook pages using browser automation.

## Prerequisites

```bash
cd facebook && npm install
```

## Usage

```bash
node facebook-posts/scripts/facebook-posts.mjs <username_or_url> [maxPosts]
```

### Examples

```bash
# By username
node facebook-posts/scripts/facebook-posts.mjs natgeo 5

# By URL
node facebook-posts/scripts/facebook-posts.mjs https://www.facebook.com/cern 10

# With FB cookies for authenticated access (more posts)
FB_COOKIES='[{"name":"c_user","value":"..."},...]' node facebook-posts/scripts/facebook-posts.mjs nasa 20
```

## Output Format

```json
{
  "username": "natgeo",
  "pageId": "100044623170418",
  "name": "National Geographic",
  "profileUrl": "https://www.facebook.com/natgeo",
  "profilePicUrl": "https://...",
  "coverPhotoUrl": "https://...",
  "bio": "Inspiring the explorer in everyone 🌎",
  "website": "http://natgeo.com/",
  "followerCount": 51000000,
  "followingCount": null,
  "categoryName": null,
  "isVerified": false,
  "posts": [
    {
      "postId": "1508935883937170",
      "storyId": "UzpfS...",
      "url": "https://www.facebook.com/natgeo/posts/pfbid...",
      "text": "Full post text with hashtags and URLs...",
      "hashtags": ["#NatGeo33"],
      "externalLinks": ["https://on.natgeo.com/05IzhI"],
      "createdAt": "2026-03-20T16:00:00.000Z",
      "author": {
        "id": "100044623170418",
        "name": "National Geographic",
        "shortName": "National Geographic",
        "profileUrl": "https://www.facebook.com/natgeo"
      },
      "attachments": [
        {
          "type": "photo",
          "id": "1508935753937183",
          "url": "https://www.facebook.com/photo/?fbid=...",
          "imageUri": "https://scontent.xx.fbcdn.net/...",
          "width": 1080,
          "height": 1350,
          "altText": "May be an image of..."
        }
      ],
      "feedback": {
        "reactionCount": 56,
        "commentCount": 2,
        "shareCount": 13,
        "reactionBreakdown": {
          "like": 49,
          "love": 4,
          "care": 1,
          "haha": 1,
          "wow": 1
        },
        "i18nReactionCount": "56"
      },
      "privacy": null,
      "isPinned": false,
      "isSponsored": false
    }
  ],
  "postsCount": 1,
  "hasMorePosts": true,
  "nextCursor": "Cg8Ob...",
  "isAuthenticated": false,
  "scrapedAt": "2026-03-20T16:09:33.575Z"
}
```

## Architecture

### How It Works

1. **Navigate to `/username/posts`** — This path shows the profile with 1 embedded post in the SSR HTML, even for logged-out users.

2. **Parse Relay SSR fragments** — Facebook embeds server-rendered data in `<script type="application/json">` tags as `RelayPrefetchedStreamCache.next` calls. These contain:
   - Profile data (name, bio, cover photo, profile pic)
   - Up to 1 post with full text, attachments, and reaction counts
   - Pagination cursor for fetching more posts

3. **Extract fallback data** — Follower counts are extracted from the DOM text as a reliable fallback.

4. **Attempt GraphQL API** — Using the logged-out session tokens (LSD token), attempts to fetch more posts via Facebook's GraphQL endpoint. This is rate-limited for logged-out requests.

5. **Authenticated mode** — Provide `FB_COOKIES` env var (JSON array of cookies) for full feed access.

### Key Data Sources

| Source | Data Available |
|--------|---------------|
| Relay SSR (`adp_ProfileCometHeaderQuery`) | Name, profile pic, cover photo, page URL |
| Relay SSR (`adp_ProfileCometTimelineFeedQuery`) | 1 post with text, attachments, reactions |
| Relay SSR (`adp_ProfilePlusCometLoggedOutRoot`) | Bio, website, page tiles |
| DOM text | Follower count (e.g., "51M followers") |
| GraphQL API (logged-out) | Rate-limited; may get more posts with valid LSD token |
| GraphQL API (authenticated) | Full feed with pagination |

### Relay SSR Data Structure

The post data is in the `adp_ProfileCometTimelineFeedQueryRelayPreloader_*` entry:

```
result.data.user.timeline_list_feed_units.edges[].node
  ├── post_id (numeric)
  ├── comet_sections
  │   ├── content.story.comet_sections.message.story.message.text (post text)
  │   ├── timestamp.story.creation_time (unix timestamp)
  │   ├── timestamp.story.url (canonical pfbid URL)
  │   └── feedback.story.story_ufi_container.story.feedback_context
  │       └── feedback_target_with_context
  │           ├── url (canonical post URL)
  │           └── comet_ufi_summary_and_actions_renderer.feedback
  │               ├── reaction_count.count
  │               ├── comment_rendering_instance.comments.total_count
  │               ├── share_count.count
  │               └── top_reactions.edges[].{reaction_count, node.localized_name}
  └── attachments[].styles.attachment.media
      ├── photo_image.uri (image URL)
      ├── viewer_image.{width, height}
      └── accessibility_caption (alt text)
```

### Limitations Without Login

- **Max 1 post** per request from SSR data (Facebook limits logged-out feed to 1 post)
- **GraphQL API** is rate-limited for logged-out requests
- **Profile-only data** (bio, follower count) is always fully available
- For more posts, provide `FB_COOKIES` with valid Facebook session cookies

### Authenticated Mode (FB_COOKIES)

Export cookies from a logged-in Facebook session and pass as JSON:

```bash
# Export from browser developer tools → Application → Cookies → facebook.com
# Format: array of {name, value, domain, path, ...} cookie objects
FB_COOKIES='[{"name":"c_user","value":"USER_ID"},{"name":"xs","value":"SESSION_TOKEN"},...]' \
  node facebook-posts/scripts/facebook-posts.mjs natgeo 20
```

Required cookies: `c_user`, `xs`, `datr`, `fr`, `sb`

### Anti-Bot Notes

Facebook detects headless browsers. camoufox-js (Firefox-based anti-detect) helps bypass:
- Browser fingerprinting
- Headless detection
- User-agent checks

Rate limiting: wait at least 10-15 seconds between requests for different pages.
