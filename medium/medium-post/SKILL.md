# medium-post

Fetch full metadata and content for a single Medium post by URL.

## Usage

```bash
node medium-post/scripts/medium-post.mjs <post-url> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<post-url>` | Full Medium post URL (required) |

**Supported URL formats:**
- `https://medium.com/@username/slug-1a7cf81e911b`
- `https://medium.com/publication/slug-1a7cf81e911b`
- `https://medium.com/p/1a7cf81e911b`
- `https://publication.medium.com/slug-1a7cf81e911b`
- `https://customdomain.com/slug-1a7cf81e911b`

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--include-content` | false | Include full post content (paywalled → excerpt only) |
| `--format text\|html` | text | Content output format |

## Examples

```bash
# Metadata only (fast)
node medium-post/scripts/medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b

# With full content as text
node medium-post/scripts/medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b --include-content

# With full content as HTML
node medium-post/scripts/medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b --include-content --format html
```

## Output Format

```json
{
  "postId": "1a7cf81e911b",
  "title": "Post Title",
  "subtitle": "A subtitle",
  "url": "https://medium.com/@user/post-title-1a7cf81e911b",
  "publishedAt": "2026-03-22T19:53:13.000Z",
  "updatedAt": "2026-03-22T19:53:13.000Z",
  "author": {
    "name": "Author Name",
    "username": "authorhandle",
    "bio": "Short bio text",
    "avatarUrl": "https://miro.medium.com/v2/resize:fill:96:96/...",
    "url": "https://medium.com/@authorhandle",
    "followerCount": 1234
  },
  "publication": {
    "id": "abc123",
    "name": "Publication Name",
    "slug": "publication-slug",
    "description": "...",
    "url": "https://medium.com/publication-slug"
  },
  "claps": 125,
  "voters": 25,
  "responses": 4,
  "readingTime": 4,
  "wordCount": 1016,
  "tags": [
    { "id": "javascript", "name": "JavaScript" }
  ],
  "excerpt": "First 300 chars of post content…",
  "coverImageUrl": "https://miro.medium.com/v2/resize:fit:1200/...",
  "isPaywalled": false,
  "contentFormat": "text",
  "contentInfo": {
    "isPaywalled": false,
    "paragraphCount": 42,
    "note": null
  },
  "content": "Full post content as plain text or HTML..."
}
```

## Notes

- **No auth required** — works for all public posts
- **Paywalled posts** — `isPaywalled: true`; only preview/excerpt available in `content`
- **Post ID** — extracted from URL (12 hex chars at end of slug, e.g. `1a7cf81e911b`)
- **Content format** — `text` renders paragraphs with Markdown-like structure; `html` renders `<p>/<h2>/<blockquote>/<pre>` tags
- **Images in content** — referenced as `[Image]` placeholder (Medium CDN URLs not embedded in paragraphs)
