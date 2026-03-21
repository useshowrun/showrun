# Facebook Agent Browser Skills

Scrape Facebook pages, posts, and profile data using browser automation.

**Note:** Facebook shows limited data to logged-out users (~1 post per request). Provide `FB_COOKIES` for full authenticated access.

## Prerequisites

### Node.js 22+
Required for ES modules. Check with `node --version`.

### Install Dependencies
```bash
cd facebook && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Posts](facebook-posts/SKILL.md) | `facebook-posts/scripts/facebook-posts.mjs` | Scrape posts + profile data from any public Facebook page |
| [Pages](facebook-pages/SKILL.md) | `facebook-pages/scripts/facebook-pages.mjs` | Page info: name, category, followers, contact info, photos |
| [Ad Library](facebook-ad-library/SKILL.md) | `facebook-ad-library/scripts/facebook-ad-library.mjs` | Search public Ad Library by keyword/country/status |

## Typical Workflow

```
1. Scrape page posts (logged-out)  →  node facebook-posts/scripts/facebook-posts.mjs natgeo 5
2. Scrape with authentication      →  FB_COOKIES='[...]' node facebook-posts/scripts/facebook-posts.mjs natgeo 20
```

## API Architecture

### How It Works

Facebook uses a Relay/GraphQL SSR (Server-Side Rendering) system called "Comet". When you navigate to a Facebook page, the server pre-renders data into `<script type="application/json">` tags as `RelayPrefetchedStreamCache.next` calls.

Key technique:
1. Launch camoufox browser to load `facebook.com/<username>/posts`
2. Parse all embedded Relay SSR JSON fragments
3. Extract profile data from `adp_ProfileCometHeaderQuery*` and `adp_ProfilePlusCometLoggedOut*` fragments
4. Extract post data from `adp_ProfileCometTimelineFeedQuery*` fragment
5. Optionally call Facebook's GraphQL API with logged-out session tokens for more posts

### Data Available Without Login

**Profile:**
- `name`, `username`, `pageId`
- `profilePicUrl`, `coverPhotoUrl`
- `bio`, `website`
- `followerCount` (from DOM text)
- `isVerified`

**Posts (1 per request from SSR):**
- `postId`, `url` (canonical pfbid format)
- `text` (full post text)
- `hashtags`, `externalLinks`
- `createdAt` (ISO timestamp)
- `attachments` (photo URL, dimensions, alt text)
- `feedback` (reactions, comments, shares with reaction type breakdown)
- `author` info

### Limitations

- **1 post max** from SSR without login (Facebook limits this)
- **GraphQL API** rate-limited for logged-out requests  
- **Private pages** — no data available
- Authenticate with `FB_COOKIES` for full feed access (see [facebook-posts SKILL.md](facebook-posts/SKILL.md))

## Output Format

All scripts write `RESULT:{json}` to stdout. Logs go to stderr.

## Anti-Bot Notes

Facebook uses sophisticated bot detection. camoufox-js handles:
- Firefox fingerprint (not Chrome — harder to detect)
- Browser humanization
- Randomized timings

Wait at least 10-15 seconds between requests for different pages.
