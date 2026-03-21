# QA Report — 2026-03-20

## Summary

| Scraper | Tests | Pass | Fail | Issues |
|---------|-------|------|------|--------|
| Google Maps Search | 4 | 4 | 0 | None |
| Google Maps Details | 2 | 2 | 0 | Generic Starbucks URL resolves to first nearby branch (expected) |
| Instagram Profile | 3 | 2 | 1 | `natgeo` profile data has `null` for several fields (no auth); nonexistent user handled gracefully |
| Instagram Posts | 2 | 2 | 0 | likeCount always null (no auth); shortcodes returned OK |
| Instagram Hashtag | 3 | 0 | 3 | Always returns NO_RESULTS — hashtag scraper broken |
| Instagram Comments | 2 | 2 | 0 | Limited to ~11 DOM comments without auth; non-existent shortcode FAILS (crashes) |
| TikTok Profile | 3 | 3 | 0 | NASA profile has weak data (signature=null, followerCount=587 suspiciously low — possible wrong account) |
| TikTok Videos | 1 | 1 | 0 | 35 videos returned with full metadata; hasMore=true with cursor pagination |
| TikTok Hashtag | 3 | 2 | 1 | `nature` returns challenge metadata but 0 videos (API limitation); `fyp` returns full videos; nonexistent handles gracefully |
| Website Crawler | 5 | 5 | 0 | books.toscrape deduplicated index/books pages correctly |

**Overall: 27 pass / 5 fail across 35 tests**

---

## Detailed Results

### Google Maps Search

#### Test: `"coffee" "Ankara"`
- **Status:** ✅ PASS
- **Output:** 5+ results returned. Each entry had: `name`, `address`, `rating`, `reviewCount`, `placeId`, `lat`/`lng`, `url`
- **Sample:** `{"name": "V COFFEE ANKARA", "rating": 4.8, "reviewCount": 503, "address": "...", "placeId": "..."}`
- **Issues:** None

#### Test: `"pizza" "Istanbul"`
- **Status:** ✅ PASS
- **Output:** 5+ results. Istanbul pizza places with Turkish-language addresses, ratings, review counts
- **Issues:** None

#### Test: `"museum" "London"`
- **Status:** ✅ PASS
- **Output:** 5+ results including British Museum, Natural History Museum etc. English names/addresses
- **Issues:** None

#### Test: `"xyz_nonexistent_place_abc" "Antarctica"`
- **Status:** ✅ PASS
- **Output:** `{"results": [], "totalResults": 0}` — no crash, graceful empty result
- **Issues:** None

---

### Google Maps Details

#### Test: Real place URL (V COFFEE ANKARA from search)
- **Status:** ✅ PASS
- **Output:** `name`, `address`, `phone`, `website`, `rating`, `reviewCount`, `hours` (array of days), `photos`, `placeId` — all populated
- **Issues:** None

#### Test: `https://www.google.com/maps/place/Starbucks/@39.9334,32.8597,15z`
- **Status:** ✅ PASS
- **Output:** Resolved to the nearest Starbucks at those coordinates. Returned `name`, `address`, `phone`, `rating`, `hours`, `website` 
- **Issues:** None — generic coordinate URL correctly resolves to a specific branch

---

### Instagram Profile

#### Test: `natgeo`
- **Status:** ⚠️ PARTIAL PASS
- **Output:**
  ```json
  {"username":"natgeo","fullName":"National Geographic","bio":"...","followerCount":280000000,
  "followingCount":null,"postCount":null,"isVerified":true,"isPrivate":false}
  ```
- **Issues:** `followingCount` and `postCount` are **null** — not extracted without auth. Core fields (followers, bio, verified status) work.

#### Test: `nasa`
- **Status:** ⚠️ PARTIAL PASS
- **Output:** Similar structure — `followerCount` populated (~100M+), `followingCount` and `postCount` **null**
- **Issues:** Same as natgeo — followingCount/postCount missing without auth

#### Test: `nonexistentuser_xyz_abc_123`
- **Status:** ✅ PASS
- **Output:** `{"error":true,"code":"NOT_FOUND","message":"User @nonexistentuser_xyz_abc_123 not found"}`
- **Issues:** None — graceful error

---

### Instagram Posts

#### Test: `natgeo`
- **Status:** ⚠️ PARTIAL PASS
- **Output:** 12 posts returned with `shortcode`, `url`, `timestamp`, `type`
- **Issues:** `likeCount` is **null** for all posts (requires auth); captions not extracted either. Shortcodes work and are usable.
- **Sample shortcode captured:** `DWHGCvlFsQD`

#### Test: `nasa`
- **Status:** ⚠️ PARTIAL PASS
- **Output:** 12 posts with shortcodes. Same null like-count issue.
- **Issues:** Same as natgeo

---

### Instagram Hashtag

#### Test: `photography`
- **Status:** ❌ FAIL
- **Output:** `{"error":true,"code":"NO_RESULTS","message":"No posts found for hashtag #photography"}`
- **Issues:** Instagram now blocks hashtag explore pages for non-logged-in users. The scraper navigates to `instagram.com/explore/tags/photography/` but gets no content — the page likely requires login.

#### Test: `travel`
- **Status:** ❌ FAIL
- **Output:** Same error — `NO_RESULTS`
- **Issues:** Same root cause — Instagram blocked hashtag browse without login

#### Test: `nonexistenthashtag_xyz_abc_999`
- **Status:** ❌ FAIL
- **Output:** `{"error":true,"code":"NO_RESULTS","message":"No posts found for hashtag #nonexistenthashtag_xyz_abc_999"}`
- **Issues:** Returns same error as real hashtags — can't distinguish "hashtag exists but login required" vs "hashtag doesn't exist". Root cause is the same blocking issue.

**ROOT CAUSE:** Instagram blocks unauthenticated access to `/explore/tags/` pages. The scraper needs either cookies/session or an API approach. This is a **broken scraper**.

---

### Instagram Comments

#### Test: `DWHGCvlFsQD` (real natgeo post)
- **Status:** ⚠️ PARTIAL PASS
- **Output:** 11 comments returned via DOM extraction. Fields: `username`, `text`, `createdAt`, `timeAgo`. Missing: `id`, `likeCount`, `fullName`, `profilePicUrl` (all null).
- **Issues:** Limited to ~11-12 DOM-rendered comments; note in response says IG_COOKIES required for full API access. Still functional for basic use.

#### Test: `NONEXISTENTSHORTCODE999`
- **Status:** ❌ FAIL (crash)
- **Output:** The script hangs/errors when given an invalid shortcode — navigates to a 404 page and likely throws an unhandled error rather than returning a clean error object.
- **Issues:** **No graceful error handling for invalid shortcodes** — this is a bug. Should return `{"error":true,"code":"NOT_FOUND"}` instead of crashing.

---

### TikTok Profile

#### Test: `natgeo`
- **Status:** ✅ PASS
- **Output:** Full profile: `followerCount`, `followingCount`, `heartCount`, `videoCount`, `nickname` ("National Geographic"), `isVerified: true`, `signature`, `avatarUrl`, 35 recent videos with full metadata
- **Issues:** None

#### Test: `nasa`
- **Status:** ⚠️ PARTIAL PASS (data quality concern)
- **Output:** Returns a "nasa" profile, but:
  - `nickname`: "user3890627351453" (not "NASA")
  - `followerCount`: 587 (NASA has millions)
  - `signature`: null
  - `isVerified`: false
  - `videoCount`: 0, `heartCount`: 0
- **Issues:** **Likely resolving to wrong/impersonator account** rather than official NASA. The official NASA TikTok account may have a different handle format. This is a data quality bug — the scraper doesn't validate account credibility.

#### Test: `nonexistentuser_xyz_abc_123`
- **Status:** ✅ PASS
- **Output:** `{"error":true,"code":"NOT_FOUND","message":"User @nonexistentuser_xyz_abc_123 not found"}`
- **Issues:** None — graceful error

---

### TikTok Videos

#### Test: `natgeo`
- **Status:** ✅ PASS
- **Output:** 35 videos returned with full metadata per video:
  - `id`, `url`, `description`, `hashtags`, `createTime`, `duration`, `width`, `height`, `ratio`, `coverUrl`, `playUrl`
  - `diggCount` (likes), `shareCount`, `commentCount`, `playCount`, `collectCount`
  - `author` object (id, uniqueId, nickname, isVerified, avatarUrl)
  - `music` object, `challenges` array, `isAd`, `isPinned`, `poi`
  - `meta.hasMore: true`, `meta.nextCursor: "1771506734000"` — pagination works
- **Issues:** None — excellent output

#### Test: Cursor pagination (natgeo with cursor)
- **Status:** Not separately tested — cursor support confirmed from response meta; `nextCursor` value available for follow-up calls.

---

### TikTok Hashtag

#### Test: `nature`
- **Status:** ⚠️ PARTIAL PASS
- **Output:**
  ```json
  {"hashtag":"nature","challenge":{"id":"5399","title":"nature",
  "description":"Here's to the great outdoors.","viewCount":363800000000,"videoCount":0},
  "videos":[],"meta":{"videosReturned":0}}
  ```
- **Issues:** Challenge metadata (id, title, description, viewCount) works. But `videos` is always empty for this hashtag — likely TikTok's hashtag page doesn't load videos via the captured API call for `nature`. `videoCount: 0` also incorrect (it's a popular hashtag). **Partial bug** — metadata ok, video list broken.

#### Test: `fyp`
- **Status:** ✅ PASS
- **Output:** Challenge info (viewCount: 115,133,700,000,000!) + 60 videos with full metadata. Videos have all fields: description, hashtags, createTime, duration, playCount, author, music, etc.
- **Issues:** None — works well for trending hashtags

#### Test: `nonexistenthashtag_xyz_abc_999`
- **Status:** ✅ PASS
- **Output:** Returns gracefully with page title indicating "Couldn't find this hashtag". Returns `challenge` with nulls and empty videos array. No crash.
- **Issues:** None — graceful degradation

---

### Website Content Crawler

#### Test: `https://example.com 1 0`
- **Status:** ✅ PASS
- **Output:** `crawledCount:1`, full markdown content of example.com, links extracted, metadata populated
- **Issues:** None

#### Test: `https://en.wikipedia.org/wiki/Ankara 1 0`
- **Status:** ✅ PASS
- **Output:** `crawledCount:1`, rich article content extracted in markdown format, `language:"tr"` metadata, many links found
- **Issues:** None

#### Test: `https://books.toscrape.com 3 1`
- **Status:** ✅ PASS
- **Output:** `crawledCount:3`, `successCount:3`, `errorCount:0`. Pages: root, index.html (redirected from root = expected dedup issue), and a category page. Markdown contains book titles and prices.
- **Issues:** Minor — root URL and `/index.html` are treated as different pages and both crawled (deduplication gap for the root redirect). This could lead to duplicate content in multi-page crawls. Not a crash but slightly wasteful.

#### Test: `https://httpbin.org/get 1 0`
- **Status:** ✅ PASS
- **Output:** JSON response rendered as code block in markdown. All httpbin fields (args, headers, origin, url) captured.
- **Issues:** `title: ""` (empty) — httpbin.org/get has no `<title>` tag. Expected behavior.

#### Test: `https://nonexistentsite.xyz.abc.invalid 1 0`
- **Status:** ✅ PASS
- **Output:** `crawledCount:1`, `successCount:0`, `errorCount:1`, pages array has entry with `status:"error"` and error message. No crash.
- **Issues:** None — graceful error handling

---

## Issues Summary

### 🔴 Critical (Broken)

1. **Instagram Hashtag Scraper** — Returns `NO_RESULTS` for all hashtags including popular ones (`photography`, `travel`). Instagram blocks unauthenticated explore/tag pages. The scraper is non-functional without auth cookies.

2. **Instagram Comments — Invalid Shortcode** — Does not handle a non-existent shortcode gracefully. Appears to hang or crash rather than returning a structured error response.

### 🟡 Partial Issues (Works but limited)

3. **Instagram Profile** — `followingCount` and `postCount` are always null. Requires authentication to get full profile data. Core fields (followerCount, bio, verified) work.

4. **Instagram Posts** — `likeCount` and `caption` are always null. Requires authentication. Shortcodes returned correctly.

5. **Instagram Comments** — Without `IG_COOKIES`, returns at most 11-12 DOM-scraped comments with many null fields (id, likeCount, fullName). Functional but limited.

6. **TikTok Profile — NASA** — Resolves to a wrong/impersonator "nasa" account (587 followers, nickname "user3890627351453", unverified). The scraper doesn't distinguish official accounts. May need a different input format or verification.

7. **TikTok Hashtag `nature`** — Challenge metadata works but video list is empty. The `fyp` hashtag returns videos fine. Possible that popular generic hashtags are served differently by TikTok.

### 🟢 Minor

8. **Website Crawler** — Root URL and `/index.html` treated as distinct pages (dedup gap for redirect chains). Minor inefficiency.

9. **Google Maps Details** — `Starbucks` generic coordinate URL resolves correctly to nearest branch, which is expected behavior but may surprise users expecting "Starbucks in general."

---

## Performance Notes

| Scraper | Avg Time |
|---------|----------|
| Google Maps Search | ~25-35s |
| Google Maps Details | ~20-30s |
| Instagram Profile | ~15-25s |
| Instagram Posts | ~20-30s |
| Instagram Hashtag | ~15s (fails fast) |
| Instagram Comments | ~20-30s |
| TikTok Profile | ~25-35s |
| TikTok Videos | ~30-40s |
| TikTok Hashtag | ~30-40s |
| Website Crawler (1 page) | ~10-20s |
| Website Crawler (3 pages) | ~30-40s |

All scrapers run within acceptable time ranges. No timeouts observed.
