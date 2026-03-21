/**
 * Shared utilities for Twitter/X scrapers.
 *
 * Strategy overview:
 *   Twitter/X uses internal GraphQL APIs authenticated with a Bearer token
 *   (which is public and constant for web clients) and a guest token or
 *   x-csrf-token obtained from the browser session.
 *
 *   We use camoufox to:
 *   1. Load x.com (gets cookies + guest token set automatically)
 *   2. Intercept XHR calls to /graphql/ endpoints to capture response data
 *   3. Alternatively: make authenticated API calls from the page context
 *      using the bearer token + cookies already in the browser
 *
 *   API endpoints used:
 *   - UserByScreenName: GET /graphql/{id}/UserByScreenName
 *   - UserTweets:       GET /graphql/{id}/UserTweets
 *   - SearchTimeline:   GET /graphql/{id}/SearchTimeline
 *   - TweetDetail:      GET /graphql/{id}/TweetDetail
 */

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

export function emitError(code, message) {
  process.stdout.write(
    "RESULT:" + JSON.stringify({ error: true, code, message }) + "\n"
  );
  process.exit(1);
}

export function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Twitter constants
// ---------------------------------------------------------------------------

// Public Bearer token used by Twitter web client (constant, not secret)
export const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// GraphQL operation IDs (these may change but are stable for months at a time)
// Extracted from twitter.com/x.com page source (queryId values in webpack bundles)
// Last verified: 2026-03-20 via camoufox browser interception
export const QUERY_IDS = {
  UserByScreenName: "IGgvgiOx4QZndDHuD3x9TQ",
  UserTweets: "O0epvwaQPUx-bT9YlqlL6w",
  SearchTimeline: "gkjsKepM6gl_HmFWoWKfgg",  // Requires login; update via DevTools if needed
  TweetDetail: "QuBlQ6SxNAQCt6-kBiCXCQ",
};

// Feature flags required by Twitter GraphQL API
export const DEFAULT_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

export const USER_FEATURES = {
  ...DEFAULT_FEATURES,
  hidden_profile_subscriptions_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  following_and_follower_counts_enabled: true,
};

export const TWEET_FEATURES = {
  ...DEFAULT_FEATURES,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_uc_gql_enabled: true,
  vibe_api_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  interactive_text_enabled: true,
  responsive_web_text_conversations_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------

/**
 * Create a camoufox browser configured for Twitter/X scraping.
 */
export async function createTwBrowser(Camoufox) {
  return Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });
}

/**
 * Create a browser context with US/English locale for consistent results.
 */
export async function createTwContext(browser) {
  return browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
  });
}

// ---------------------------------------------------------------------------
// Guest token / auth setup
// ---------------------------------------------------------------------------

/**
 * Navigate to x.com and extract the guest token from cookies/headers.
 * The guest token is set as a cookie (gt=...) automatically by Twitter.
 */
export async function bootstrapTwitter(page) {
  log("[auth] Navigating to x.com to get guest token...");

  // Intercept the guest token from activate endpoint or cookie
  let guestToken = null;

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/1.1/guest/activate.json") && !guestToken) {
      try {
        const data = await response.json();
        if (data.guest_token) {
          guestToken = data.guest_token;
          log(`[auth] Guest token from activate: ${guestToken}`);
        }
      } catch (_) {}
    }
  });

  try {
    await page.goto("https://x.com", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
  } catch (e) {
    log(`[auth] Navigation warning: ${e.message}`);
  }

  await delay(3000);

  // Try to get guest token from cookie if not intercepted
  if (!guestToken) {
    const cookies = await page.context().cookies("https://x.com");
    const gtCookie = cookies.find((c) => c.name === "gt");
    if (gtCookie) {
      guestToken = gtCookie.value;
      log(`[auth] Guest token from cookie: ${guestToken}`);
    }
  }

  // Get csrf token (ct0 cookie)
  const cookies = await page.context().cookies("https://x.com");
  const ct0Cookie = cookies.find((c) => c.name === "ct0");
  const csrfToken = ct0Cookie?.value || null;

  if (csrfToken) {
    log(`[auth] CSRF token (ct0): found (${csrfToken.length} chars)`);
  } else {
    log("[auth] CSRF token not found in cookies");
  }

  if (!guestToken) {
    log("[auth] No guest token found — will proceed without (may have limited access)");
  }

  return { guestToken, csrfToken };
}

// ---------------------------------------------------------------------------
// API call helpers
// ---------------------------------------------------------------------------

/**
 * Make a Twitter GraphQL API call from within the browser context.
 * Uses the browser's existing cookies (including guest_token, ct0) for auth.
 *
 * @param {Object} page - Playwright page
 * @param {string} endpoint - e.g. "UserByScreenName"
 * @param {string} queryId - operation query ID
 * @param {Object} variables - GraphQL variables
 * @param {Object} features - Feature flags
 * @param {string} bearerToken - Bearer token
 * @param {string|null} guestToken - Guest token (or null)
 * @param {string|null} csrfToken - CSRF token (or null)
 */
export async function callTwitterAPI(
  page,
  { endpoint, queryId, variables, features, bearerToken, guestToken, csrfToken }
) {
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  });

  const url = `https://api.x.com/graphql/${queryId}/${endpoint}?${params}`;

  const result = await page.evaluate(
    async ({ url, bearerToken, guestToken, csrfToken }) => {
      const headers = {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
      };

      if (guestToken) {
        headers["x-guest-token"] = guestToken;
      }
      if (csrfToken) {
        headers["x-csrf-token"] = csrfToken;
      }

      try {
        const resp = await fetch(url, {
          method: "GET",
          headers,
          credentials: "include",
        });

        const text = await resp.text();
        return { status: resp.status, text };
      } catch (e) {
        return { error: e.message };
      }
    },
    { url, bearerToken, guestToken, csrfToken }
  );

  if (result.error) {
    log(`[api] Error calling ${endpoint}: ${result.error}`);
    return null;
  }

  if (result.status !== 200) {
    log(`[api] HTTP ${result.status} from ${endpoint}: ${result.text?.slice(0, 200)}`);
    return null;
  }

  try {
    return JSON.parse(result.text);
  } catch (e) {
    log(`[api] JSON parse error from ${endpoint}: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data parsers
// ---------------------------------------------------------------------------

/**
 * Parse a Twitter user object (from GraphQL result.data.user.result).
 *
 * Twitter's API response format has evolved. As of 2026, key fields are spread across:
 *   - userResult.core:        { name, screen_name, created_at }
 *   - userResult.avatar:      { image_url }
 *   - userResult.profile_bio: { description }
 *   - userResult.location:    { location }
 *   - userResult.legacy:      { followers_count, friends_count, statuses_count, ... }
 *   - userResult.legacy.entities.url.urls[0].expanded_url → website
 *
 * We handle both old format (legacy.screen_name) and new format (core.screen_name).
 */
export function parseUser(userResult) {
  if (!userResult) return null;

  const legacy = userResult.legacy || {};
  const core = userResult.core || {};
  const avatar = userResult.avatar || {};
  const profileBio = userResult.profile_bio || {};
  const locationObj = userResult.location || {};
  const verification = userResult.verification || {};

  // Name / username: new format uses core, old format uses legacy
  const username = core.screen_name || legacy.screen_name || null;
  const name = core.name || legacy.name || null;
  const createdAt = core.created_at || legacy.created_at || null;

  // Bio: new format uses profile_bio.description, old format uses legacy.description
  const bio = profileBio.description || legacy.description || null;

  // Location: new format uses location.location, old format uses legacy.location
  const location = locationObj.location || legacy.location || null;

  // Profile image: new format uses avatar.image_url, old format uses legacy.profile_image_url_https
  const rawProfileImg = avatar.image_url || legacy.profile_image_url_https || "";
  const profileImageUrl = rawProfileImg.replace("_normal", "_400x400") || null;

  // Website from entities
  const website = legacy.entities?.url?.urls?.[0]?.expanded_url || legacy.url || null;

  return {
    id: userResult.rest_id || userResult.id_str || null,
    username,
    name,
    bio,
    location,
    website,
    createdAt,
    isVerified: verification.verified ?? legacy.verified ?? false,
    isBlueVerified: userResult.is_blue_verified ?? false,
    profileImageUrl,
    profileBannerUrl: legacy.profile_banner_url || null,
    followersCount: legacy.followers_count ?? null,
    followingCount: legacy.friends_count ?? null,
    tweetsCount: legacy.statuses_count ?? null,
    listedCount: legacy.listed_count ?? null,
    likesCount: legacy.favourites_count ?? null,
    mediaCount: legacy.media_count ?? null,
    isProtected: legacy.protected ?? false,
    pinnedTweetId: getUserTimelineInstructions(userResult)
      .flatMap((i) => i.entries || [])
      .find((e) => e.entryId?.includes("pinned-tweet"))
      ?.content?.itemContent?.tweet_results?.result?.rest_id || null,
  };
}

/**
 * Parse a tweet result object from Twitter GraphQL response.
 * Handles nested result structures from UserTweets, SearchTimeline, etc.
 */
export function parseTweet(tweetResult) {
  if (!tweetResult) return null;

  // Unwrap nested result (e.g. TweetWithVisibilityResults)
  let result = tweetResult;
  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) {
    result = result.tweet;
  }
  if (result.__typename === "TweetTombstone") {
    return null; // Deleted/suspended tweet
  }

  const legacy = result.legacy || {};
  const core = result.core || {};
  const views = result.views || {};
  const quotedStatusResult = result.quoted_status_result?.result || null;

  // Author — handle both old format (legacy.screen_name) and new format (core.screen_name)
  const authorResult = core?.user_results?.result || null;
  const author = authorResult
    ? {
        id: authorResult.rest_id || null,
        username: authorResult.core?.screen_name || authorResult.legacy?.screen_name || null,
        name: authorResult.core?.name || authorResult.legacy?.name || null,
        isBlueVerified: authorResult.is_blue_verified ?? false,
        profileImageUrl: (() => {
          const raw = authorResult.avatar?.image_url || authorResult.legacy?.profile_image_url_https || "";
          return raw.replace("_normal", "_bigger") || null;
        })(),
      }
    : null;

  // Extract text (full_text preferred)
  const text = legacy.full_text || legacy.text || null;

  // Extract hashtags from entities
  const hashtags = (legacy.entities?.hashtags || []).map((h) => h.text);

  // Extract URLs (expanded)
  const urls = (legacy.entities?.urls || []).map((u) => ({
    url: u.url,
    expandedUrl: u.expanded_url,
    displayUrl: u.display_url,
  }));

  // Extract mentions
  const mentions = (legacy.entities?.user_mentions || []).map((m) => ({
    id: m.id_str,
    username: m.screen_name,
    name: m.name,
  }));

  // Extract media
  const mediaItems = legacy.extended_entities?.media || legacy.entities?.media || [];
  const media = mediaItems.map((m) => parseMediaItem(m)).filter(Boolean);

  // Extract card (link preview / poll)
  const card = result.card ? parseCard(result.card) : null;

  // Quote tweet
  const quoteTweet = quotedStatusResult
    ? parseTweet(quotedStatusResult)
    : null;

  // Reply info
  const replyTo =
    legacy.in_reply_to_screen_name
      ? {
          username: legacy.in_reply_to_screen_name,
          tweetId: legacy.in_reply_to_status_id_str || null,
          userId: legacy.in_reply_to_user_id_str || null,
        }
      : null;

  const tweetId = result.rest_id || legacy.id_str || null;

  // Also try to get username from legacy.user (for embedded/quoted tweets)
  const usernameForUrl = author?.username || legacy.user?.screen_name || null;

  return {
    id: tweetId,
    url: usernameForUrl && tweetId
      ? `https://x.com/${usernameForUrl}/status/${tweetId}`
      : null,
    text,
    hashtags,
    urls,
    mentions,
    media,
    card,
    language: legacy.lang || null,
    createdAt: legacy.created_at || null,
    isRetweet: !!legacy.retweeted_status_id_str,
    retweetedTweetId: legacy.retweeted_status_id_str || null,
    isReply: !!legacy.in_reply_to_status_id_str,
    replyTo,
    quoteTweet,
    quoteCount: legacy.quote_count ?? null,
    replyCount: legacy.reply_count ?? null,
    retweetCount: legacy.retweet_count ?? null,
    likeCount: legacy.favorite_count ?? null,
    viewCount: views.count ? parseInt(views.count, 10) : null,
    bookmarkCount: legacy.bookmark_count ?? null,
    author,
    source: legacy.source
      ? legacy.source.replace(/<[^>]+>/g, "")
      : null, // Strip HTML from source (e.g. "Twitter Web App")
    isPinned: false, // Set by caller if needed
    conversationId: legacy.conversation_id_str || null,
    possiblySensitive: legacy.possibly_sensitive ?? false,
  };
}

/**
 * Parse a media item from tweet entities.
 */
function parseMediaItem(m) {
  if (!m) return null;

  const type = m.type; // "photo", "video", "animated_gif"

  let videoVariants = null;
  if (m.video_info?.variants) {
    // Get best quality MP4 variant
    videoVariants = m.video_info.variants
      .filter((v) => v.content_type === "video/mp4")
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      .map((v) => ({ url: v.url, bitrate: v.bitrate, contentType: v.content_type }));
  }

  return {
    type,
    mediaUrl: m.media_url_https || null,
    expandedUrl: m.expanded_url || null,
    width: m.original_info?.width || null,
    height: m.original_info?.height || null,
    altText: m.ext_alt_text || null,
    duration: m.video_info?.duration_millis
      ? Math.round(m.video_info.duration_millis / 1000)
      : null,
    videoVariants,
    aspectRatio: m.video_info?.aspect_ratio || null,
  };
}

/**
 * Parse a Twitter card (link preview, poll, etc.)
 */
function parseCard(card) {
  if (!card) return null;

  const name = card.rest_id?.split("/")?.pop() || "";
  const values = {};
  for (const binding of card.legacy?.binding_values || []) {
    const key = binding.key;
    const val = binding.value;
    if (val?.string_value !== undefined) values[key] = val.string_value;
    else if (val?.scribe_value !== undefined) values[key] = val.scribe_value;
    else if (val?.image_value) values[key] = val.image_value;
    else if (val?.boolean_value !== undefined) values[key] = val.boolean_value;
  }

  if (name.includes("poll")) {
    // Extract poll options
    const options = [];
    for (let i = 1; i <= 4; i++) {
      const label = values[`choice${i}_label`];
      const count = values[`choice${i}_count`];
      if (label) options.push({ label, count: count ? parseInt(count, 10) : null });
    }
    return {
      type: "poll",
      options,
      endDatetime: values["end_datetime_utc"] || null,
      lastUpdated: values["last_updated_datetime_utc"] || null,
      duration: values["duration_minutes"] || null,
      status: values["counts_are_final"] === "true" ? "final" : "active",
    };
  }

  if (name.includes("app")) {
    return {
      type: "app",
      title: values["title"] || null,
      description: values["description"] || null,
      appUrl: values["app_url_resolved"] || null,
    };
  }

  // Generic link card
  return {
    type: "link",
    title: values["title"] || null,
    description: values["description"] || null,
    url: values["card_url"] || null,
    domain: values["domain"] || null,
    thumbnailUrl: values["thumbnail_image_original"]?.url || values["thumbnail_image"]?.url || null,
  };
}

// ---------------------------------------------------------------------------
// Timeline path helpers
// ---------------------------------------------------------------------------

/**
 * Extract timeline instructions from a user result object.
 * Handles both old format (timeline_v2) and new format (timeline).
 * Returns an empty array if not found.
 *
 * Old: data.user.result.timeline_v2.timeline.instructions
 * New: data.user.result.timeline.timeline.instructions
 */
export function getUserTimelineInstructions(userResult) {
  if (!userResult) return [];

  // Try new format first (data.user.result.timeline.timeline.instructions)
  const newTimeline = userResult.timeline?.timeline?.instructions;
  if (newTimeline && newTimeline.length > 0) return newTimeline;

  // Fall back to old format (data.user.result.timeline_v2.timeline.instructions)
  const oldTimeline = userResult.timeline_v2?.timeline?.instructions;
  if (oldTimeline) return oldTimeline;

  // Also try direct instructions on timeline
  const directTimeline = userResult.timeline?.instructions;
  if (directTimeline) return directTimeline;

  return [];
}

// ---------------------------------------------------------------------------
// Timeline instruction traversal
// ---------------------------------------------------------------------------

/**
 * Extract tweet entries from a Twitter timeline instructions array.
 * Handles: TimelineAddEntries, TimelineReplaceEntry, TimelinePinEntry
 * Returns: { tweets: parsedTweet[], nextCursor: string|null, prevCursor: string|null }
 */
export function extractTimelineEntries(instructions) {
  const tweets = [];
  let nextCursor = null;
  let prevCursor = null;

  for (const instruction of instructions || []) {
    // Handle pinned tweet
    if (instruction.type === "TimelinePinEntry") {
      const entry = instruction.entry;
      const tweet = extractTweetFromEntry(entry);
      if (tweet) {
        tweet.isPinned = true;
        tweets.push(tweet);
      }
      continue;
    }

    const entries = instruction.entries || [];

    for (const entry of entries) {
      const entryId = entry.entryId || "";

      // Cursor entries
      if (entryId.startsWith("cursor-top") || entryId.includes("-cursor-top")) {
        const cursor = entry.content?.value || entry.content?.itemContent?.value;
        if (cursor) prevCursor = cursor;
        continue;
      }
      if (entryId.startsWith("cursor-bottom") || entryId.includes("-cursor-bottom")) {
        const cursor = entry.content?.value || entry.content?.itemContent?.value;
        if (cursor) nextCursor = cursor;
        continue;
      }

      // Tweet entries
      const tweet = extractTweetFromEntry(entry);
      if (tweet) tweets.push(tweet);
    }
  }

  return { tweets, nextCursor, prevCursor };
}

/**
 * Extract a single tweet from a timeline entry.
 */
function extractTweetFromEntry(entry) {
  if (!entry) return null;

  const content = entry.content;
  if (!content) return null;

  // TimelineTimelineItem (single tweet)
  if (content.entryType === "TimelineTimelineItem" || content.__typename === "TimelineTimelineItem") {
    const itemContent = content.itemContent;
    if (itemContent?.itemType === "TimelineTweet" || itemContent?.__typename === "TimelineTweet") {
      const tweetResult = itemContent.tweet_results?.result;
      return parseTweet(tweetResult);
    }
    return null;
  }

  // TimelineTimelineModule (e.g. conversation threads)
  if (content.entryType === "TimelineTimelineModule" || content.__typename === "TimelineTimelineModule") {
    // Take the first tweet in the module (the root of a conversation)
    const items = content.items || [];
    for (const item of items) {
      const itemContent = item.item?.itemContent;
      if (itemContent?.itemType === "TimelineTweet" || itemContent?.__typename === "TimelineTweet") {
        const tweetResult = itemContent.tweet_results?.result;
        const tweet = parseTweet(tweetResult);
        if (tweet) return tweet;
      }
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Intercept helpers (alternative to direct API calls)
// ---------------------------------------------------------------------------

/**
 * Set up response interception for Twitter GraphQL API calls.
 * Returns a store object that collects intercepted responses.
 *
 * Usage:
 *   const store = setupInterception(page, ["UserByScreenName", "UserTweets"]);
 *   await page.goto(url);
 *   await delay(5000);
 *   const userData = store.get("UserByScreenName");
 */
export function setupInterception(page, endpoints) {
  const store = new Map();

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/graphql/")) return;

    for (const ep of endpoints) {
      if (url.includes(`/${ep}`)) {
        // Don't overwrite if we already have data (take first successful)
        if (store.has(ep)) continue;
        try {
          const data = await response.json();
          if (data && !data.errors) {
            store.set(ep, data);
            log(`[intercept] Captured ${ep}`);
          }
        } catch (_) {}
        break;
      }
    }
  });

  store.waitFor = async (endpoint, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (!store.has(endpoint) && Date.now() < deadline) {
      await delay(200);
    }
    return store.get(endpoint) || null;
  };

  return store;
}
