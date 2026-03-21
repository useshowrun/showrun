# Facebook Pages Scraper

Scrapes public Facebook page information including name, category, follower count, contact info (website, email, phone), and profile/cover photos.

## Strategy

1. Navigate to `facebook.com/<page>/about_contact_and_basic_info` — the structured contact info page
2. Extract Relay/GraphQL SSR fragments for profile pic, cover photo, page ID (via `profilePic160.uri` from flat `__isProfile` data entries)
3. Extract structured contact data from DOM using text section parsing:
   - Section headers: "Categories", "Contact info", "Address", "Websites and social links"
   - Links parsed for redirect URLs (via `l.facebook.com/l.php?u=...`), `mailto:`, `tel:`
4. Extract follower count via regex on body text ("51M followers")
5. Optionally fetch `about_details` page for bio/mission text

### Why `about_contact_and_basic_info`?

The main `/about` page is generic but the `/about_contact_and_basic_info` URL:
- Has structured text sections for Categories, Contact info, Address, Websites
- Contains redirect links for external websites (`l.facebook.com/l.php?u=...`)
- No CSS class selectors needed — pure text and link parsing

### Relay Data (SSR JSON fragments)

Facebook embeds two types of useful relay data:
- `adp_ProfileCometHeaderQueryRelayPreloader` — contains `user.profile_header_renderer` with page name, cover photo, user ID
- Flat entries with `__isProfile: "User"` — contain `profilePic160.uri` for the profile picture

These are decoded from `<script type="application/json">` tags via `RelayPrefetchedStreamCache` entries.

### External Link Parsing

Facebook wraps all outbound links as: `https://l.facebook.com/l.php?u=<encoded_url>&...`
The `u` parameter contains the real URL (URL-encoded). Decode it to get actual destination.

## Usage

```bash
# Basic page info
node facebook-pages.mjs natgeo
node facebook-pages.mjs nasa
node facebook-pages.mjs starbucks

# With bio (fetches about_details page additionally)
node facebook-pages.mjs nasa --bio

# With recent posts
node facebook-pages.mjs natgeo --posts --max 3

# From URL
node facebook-pages.mjs "https://www.facebook.com/natgeo"

# With authentication (enables more data)
FB_COOKIES='[{"name":"c_user","value":"..."},{"name":"xs","value":"..."}]' node facebook-pages.mjs natgeo
```

## Output

```json
{
  "username": "natgeo",
  "id": "100044623170418",
  "name": "National Geographic",
  "categories": ["Media/news company"],
  "category": "Media/news company",
  "followerCount": 51000000,
  "followerText": "51M followers",
  "website": "http://www.nationalgeographic.com/",
  "email": null,
  "phone": null,
  "address": null,
  "instagram": null,
  "twitter": null,
  "linkedin": null,
  "youtube": null,
  "tiktok": null,
  "socialLinks": null,
  "isVerified": false,
  "profilePicUrl": "https://scontent.xx.fbcdn.net/...",
  "coverPhotoUrl": "https://scontent.xx.fbcdn.net/...",
  "pageUrl": "https://www.facebook.com/natgeo",
  "authenticated": false
}
```

## Selector Stability

- **Zero CSS class selectors** — all data from DOM text parsing and link href attribute
- Uses text content matching (section headers like "Categories", "Contact info")
- Link-based extraction via `href` attributes and URL query parameters
- Profile pic / cover photo from SSR JSON (relay data) — stable data path
- `profilePic160` key is from relay data (not DOM CSS class)

## Known Limitations

- Facebook limits data for logged-out users — contact info may be restricted for some pages
- Category extraction depends on the "Categories" section text header being present
- Bio extraction from `/about_details` is best-effort; structure varies by page type
- `isVerified` — not always available in relay data without authentication
- `creationDate` / `formerNames` — only available with authentication or if Facebook includes in SSR

## Files

- `scripts/facebook-pages.mjs` — main scraper script
- `../../lib/utils.mjs` — shared utilities (createFbBrowser, extractRelayData, etc.)
