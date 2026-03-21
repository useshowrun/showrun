/**
 * Shared utilities for Facebook scrapers.
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
// Facebook constants
// ---------------------------------------------------------------------------

export const FB_HOME = "https://www.facebook.com/";

// ---------------------------------------------------------------------------
// Facebook browser setup
// ---------------------------------------------------------------------------

/**
 * Initialize a camoufox browser with Facebook-appropriate settings.
 * Uses Firefox fingerprint to bypass Facebook's bot detection.
 */
export async function createFbBrowser(Camoufox) {
  return Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createFbContext(browser) {
  return browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
  });
}

// ---------------------------------------------------------------------------
// Relay fragment parser
// ---------------------------------------------------------------------------

/**
 * Extract all RelayPrefetchedStreamCache entries from the page's JSON scripts.
 * Facebook embeds server-rendered data in these entries.
 *
 * @param {Page} page - Playwright page object
 * @returns {Array<{name: string, data: object}>} Array of relay cache entries
 */
export async function extractRelayData(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll("script[type='application/json']"));
    const relayEntries = [];

    function traverseForRelay(obj) {
      if (!obj || typeof obj !== "object") return;

      if (Array.isArray(obj)) {
        // Check if it's a RelayPrefetchedStreamCache.next call
        if (
          obj[0] === "RelayPrefetchedStreamCache" &&
          obj[1] === "next" &&
          Array.isArray(obj[3]) &&
          obj[3].length >= 2
        ) {
          relayEntries.push({ name: obj[3][0], data: obj[3][1] });
          return;
        }
        for (const item of obj) {
          traverseForRelay(item);
        }
        return;
      }

      for (const val of Object.values(obj)) {
        if (val && typeof val === "object") {
          traverseForRelay(val);
        }
      }
    }

    for (const s of scripts) {
      if (!s.textContent) continue;
      try {
        const data = JSON.parse(s.textContent);
        traverseForRelay(data);
      } catch (e) {
        // skip invalid JSON
      }
    }

    return relayEntries.map((e) => ({
      name: e.name,
      bbox: e.data?.__bbox || null,
    }));
  });
}

/**
 * Extract session tokens from the page HTML.
 * Returns { lsd, dtsg, hsi } for use in GraphQL API calls.
 */
export async function extractSessionTokens(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll("script[type='application/json']"));

    let lsd = null;
    let dtsg = null;
    let hsi = null;

    for (const s of scripts) {
      const text = s.textContent || "";

      // LSD token (from login form)
      if (!lsd) {
        const m = text.match(/"name":"lsd","value":"([^"]+)"/);
        if (m) lsd = m[1];
      }

      // DTSG token
      if (!dtsg) {
        const m = text.match(/"token":"([A-Za-z0-9_:-]{20,})"/);
        if (m) dtsg = m[1];
      }

      // HSI
      if (!hsi) {
        const m = text.match(/"hsi":"([0-9]+)"/);
        if (m) hsi = m[1];
      }

      if (lsd && dtsg && hsi) break;
    }

    return { lsd, dtsg, hsi };
  });
}

// ---------------------------------------------------------------------------
// Post parser
// ---------------------------------------------------------------------------

/**
 * Parse a Facebook Story node (from timeline_list_feed_units.edges[].node)
 * into a clean, normalized post object.
 */
export function parseStoryNode(node, pageUsername) {
  if (!node) return null;

  // Post ID (numeric)
  const postId = node.post_id || null;

  // Story ID (encoded)
  const storyId = node.id || null;

  // --------------------------------------------------------------------------
  // Post URL - prefer canonical URL from timestamp section, fallback to post_id
  // --------------------------------------------------------------------------
  const timestampStory = node.comet_sections?.timestamp?.story;
  let url = timestampStory?.url || null;
  if (!url && postId) {
    url = `https://www.facebook.com/${pageUsername}/posts/${postId}`;
  }

  // --------------------------------------------------------------------------
  // Creation time - from timestamp.story.creation_time
  // --------------------------------------------------------------------------
  const creationTimestamp = timestampStory?.creation_time || node.creation_time || null;
  const createdAt = creationTimestamp
    ? new Date(creationTimestamp * 1000).toISOString()
    : null;

  // --------------------------------------------------------------------------
  // Message text - navigate the comet_sections structure
  // Facebook's Relay SSR nests text deep in CometFeedStoryDefaultContentStrategy
  // --------------------------------------------------------------------------
  const contentStory = node.comet_sections?.content?.story;
  const innerSections = contentStory?.comet_sections;
  const messageStrategy = innerSections?.message;
  const messageStory = messageStrategy?.story;
  const messageObj = messageStory?.message || contentStory?.message || null;
  const text = messageObj?.text || null;

  // Extract hashtags from message ranges
  const hashtags = [];
  const externalLinks = [];
  if (messageObj?.ranges) {
    for (const range of messageObj.ranges) {
      const entity = range.entity;
      if (!entity) continue;
      if (entity.__typename === "Hashtag" && entity.url) {
        const hashMatch = entity.url.match(/hashtag\/([^?/]+)/);
        if (hashMatch) hashtags.push("#" + hashMatch[1]);
      }
      if (entity.__typename === "ExternalUrl" && entity.external_url) {
        externalLinks.push(entity.external_url);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Attachments (photos, videos)
  // --------------------------------------------------------------------------
  const attachments = (node.attachments || [])
    .map((att) => parseAttachment(att))
    .filter(Boolean);

  // --------------------------------------------------------------------------
  // Feedback (reactions, comments, shares)
  // Facebook nests this deep in comet_sections.feedback.story.*
  // The actual data is in story_ufi_container.story.feedback_context for logged-out
  // or story.feedback_context directly for authenticated
  // --------------------------------------------------------------------------

  const feedbackSection = node.comet_sections?.feedback;
  const feedbackStory = feedbackSection?.story;

  // Try logged-out path: story.story_ufi_container.story.feedback_context...
  const ufiContainerTarget =
    feedbackStory?.story_ufi_container?.story?.feedback_context
      ?.feedback_target_with_context;

  // Try direct path: story.feedback_context...
  const directTarget =
    feedbackStory?.feedback_context?.feedback_target_with_context;

  const feedbackTarget = ufiContainerTarget || directTarget;
  const feedbackSummary =
    feedbackTarget?.comet_ufi_summary_and_actions_renderer?.feedback;

  // Fallback to the top-level shallow feedback
  const shallowFeedback = node.feedback;
  const feedback = parseFeedback(feedbackSummary || shallowFeedback);

  // Post URL from feedback section (canonical)
  const feedbackUrl = feedbackTarget?.url;
  if (!url && feedbackUrl) {
    url = feedbackUrl;
  }

  // --------------------------------------------------------------------------
  // Author info
  // --------------------------------------------------------------------------
  const owningProfile =
    feedbackSummary?.owning_profile ||
    feedbackTarget?.owning_profile ||
    shallowFeedback?.owning_profile;

  const author = owningProfile
    ? {
        id: owningProfile.id,
        name: owningProfile.name,
        shortName: owningProfile.short_name || owningProfile.name,
        profileUrl: `https://www.facebook.com/${pageUsername}`,
      }
    : null;

  // --------------------------------------------------------------------------
  // Post privacy
  // --------------------------------------------------------------------------
  const privacyScope = innerSections?.context_layout?.story?.comet_sections?.metadata?.[0]?.story?.privacy_scope;
  const privacy = privacyScope?.description || null;

  // Is pinned
  const isPinned = node.comet_sections?.content?.is_pinned ?? false;

  return {
    postId,
    storyId,
    url,
    text,
    hashtags,
    externalLinks,
    createdAt,
    author,
    attachments,
    feedback,
    privacy,
    isPinned,
    isSponsored: node.sponsored_data !== null && node.sponsored_data !== undefined,
  };
}

/**
 * Parse a post attachment (photo, video, etc.)
 * Facebook wraps media in a styles.attachment.media structure in SSR data.
 */
function parseAttachment(att) {
  if (!att) return null;

  // Try direct media (from GraphQL API response)
  // Then try styles.attachment.media (from SSR relay data)
  const directMedia = att.media;
  const styledMedia = att.styles?.attachment?.media;
  const media = (styledMedia && styledMedia.photo_image) ? styledMedia : (directMedia || styledMedia);

  if (!media) return null;

  const type = media.__typename || "Unknown";

  if (type === "Photo") {
    // photo_image has the actual URL; viewer_image has dimensions
    const imageUri = media.photo_image?.uri || null;
    const width = media.photo_image?.width || media.viewer_image?.width || null;
    const height = media.photo_image?.height || media.viewer_image?.height || null;

    return {
      type: "photo",
      id: media.id,
      url: media.url || null,
      imageUri,
      width,
      height,
      altText: media.accessibility_caption || null,
    };
  }

  if (type === "Video") {
    return {
      type: "video",
      id: media.id,
      url: media.url || null,
      thumbnailUri: media.thumbnailImage?.uri || media.preferred_thumbnail?.image?.uri || null,
      width: media.width || null,
      height: media.height || null,
      duration: media.playable_duration_in_ms
        ? media.playable_duration_in_ms / 1000
        : null,
      altText: media.accessibility_caption || null,
    };
  }

  return {
    type: type.toLowerCase(),
    id: media.id || null,
    url: media.url || null,
  };
}

/**
 * Parse post feedback (reactions, comments, shares).
 * Handles both the deep SSR structure and the GraphQL API structure.
 */
function parseFeedback(feedback) {
  if (!feedback) return null;

  const reactionCount = feedback.reaction_count?.count ?? null;

  // Comment count: try different paths
  const commentCount =
    feedback.comment_rendering_instance?.comments?.total_count ??
    feedback.comment_count?.total_count ??
    null;

  const shareCount = feedback.share_count?.count ?? null;

  // Reaction breakdown
  const reactionBreakdown = {};
  if (feedback.top_reactions?.edges) {
    for (const edge of feedback.top_reactions.edges) {
      const name = edge.node?.localized_name?.toLowerCase() || "unknown";
      reactionBreakdown[name] = edge.reaction_count || 0;
    }
  }

  return {
    reactionCount,
    commentCount,
    shareCount,
    reactionBreakdown,
    i18nReactionCount: feedback.i18n_reaction_count || null,
  };
}

// ---------------------------------------------------------------------------
// Profile parser
// ---------------------------------------------------------------------------

/**
 * Parse profile/page data from Relay fragments.
 * Combines data from multiple fragments (header, logged-out root, etc.)
 */
export function parseProfileData(relayEntries, username) {
  let profile = {
    username,
    id: null,
    name: null,
    profilePicUrl: null,
    coverPhotoUrl: null,
    bio: null,
    website: null,
    followerCount: null,
    followingCount: null,
    categoryName: null,
    isVerified: false,
    pageUrl: `https://www.facebook.com/${username}`,
  };

  for (const entry of relayEntries) {
    const result = entry.bbox?.result;
    if (!result) continue;

    const data = result.data || {};

    // From ProfileCometHeaderQuery - main profile header
    const user = data.user;
    if (user) {
      if (user.id) profile.id = user.id;

      const headerRenderer = user.profile_header_renderer;
      if (headerRenderer) {
        const headerUser = headerRenderer.user;
        if (headerUser) {
          if (headerUser.name) profile.name = headerUser.name;
          if (headerUser.url) profile.pageUrl = headerUser.url;
          if (headerUser.is_verified) profile.isVerified = true;

          // Cover photo - in headerUser.cover_photo.photo.image.uri
          if (headerUser.cover_photo?.photo?.image?.uri) {
            profile.coverPhotoUrl = headerUser.cover_photo.photo.image.uri;
          }

          // Profile picture (sticky bar, usually 80x80)
          if (headerUser.profile_picture_for_sticky_bar?.uri && !profile.profilePicUrl) {
            profile.profilePicUrl = headerUser.profile_picture_for_sticky_bar.uri;
          }
          if (headerUser.profile_picture?.uri) {
            profile.profilePicUrl = headerUser.profile_picture.uri;
          }
        }
      }

      // From ProfileCometTimelineFeed - user.profile_url
      if (user.profile_url) profile.pageUrl = user.profile_url;
      if (user.name) profile.name = user.name;
      if (user.profile_picture?.uri) profile.profilePicUrl = user.profile_picture.uri;
    }

    // From ProfilePlusCometLoggedOutRoot - tile sections (bio, etc.)
    const mainColumnTiles = data.mainColumnTiles;
    if (mainColumnTiles?.id) {
      if (!profile.id) profile.id = mainColumnTiles.id;
    }

    // From INTRO tile section (in deferred fragment with label ProfileCometTilesFeed)
    if (result.label?.includes("ProfileCometTilesFeed")) {
      const sections = data.profile_tile_sections?.edges || [];
      for (const sectionEdge of sections) {
        const section = sectionEdge.node;
        if (section?.profile_tile_section_type === "INTRO") {
          const views = section.profile_tile_views?.nodes || [];
          for (const view of views) {
            const renderer = view.view_style_renderer;
            if (!renderer) continue;

            // Bio from IntroBioRenderer - also contains website URL as range entity
            if (renderer.__typename === "ProfileTileViewIntroBioRenderer") {
              const tileItems = renderer.view?.profile_tile_items?.nodes || [];
              for (const item of tileItems) {
                const n = item.node;
                if (n?.__typename === "ProfileStatus" && n.profile_status_text) {
                  const statusText = n.profile_status_text;
                  const fullText = statusText.text || "";

                  // Extract website from the ranges (ExternalUrl entities)
                  if (!profile.website) {
                    for (const range of statusText.ranges || []) {
                      const entity = range.entity;
                      if (entity?.__typename === "ExternalUrl" && entity.external_url) {
                        profile.website = entity.external_url;
                        break;
                      }
                    }
                  }

                  // Bio is the text minus the URL line
                  if (!profile.bio && fullText) {
                    // Remove the last line if it looks like a URL
                    const lines = fullText.split("\n").filter((l) => l.trim());
                    const nonUrlLines = lines.filter(
                      (l) => !l.trim().match(/^https?:\/\//) && !l.trim().match(/^[a-z0-9-]+\.[a-z]+/i)
                    );
                    profile.bio = nonUrlLines.join("\n") || lines[0] || fullText;
                  }
                }
                if (n?.__typename === "ExternalLink" && n.external_url) {
                  if (!profile.website) profile.website = n.external_url;
                }
                if (n?.__typename === "WebsiteLink" && n.website?.url) {
                  if (!profile.website) profile.website = n.website.url;
                }
              }
            }
          }
        }
      }
    }

    // Profile picture from ProfileCometProfilePicture_profile defer
    if (result.label?.includes("ProfileCometProfilePicture_profile")) {
      const profilePhoto = data.profilePic160 || data.profilePic320;
      if (profilePhoto?.uri && !profile.profilePicUrl) {
        profile.profilePicUrl = profilePhoto.uri;
      }
    }

    // Name and gender from ProfileCometLockedProfilePopover
    if (result.label?.includes("ProfileCometLockedProfilePopover")) {
      if (data.name && !profile.name) profile.name = data.name;
    }
  }

  return profile;
}

/**
 * Extract follower/following count from DOM text.
 * Facebook shows "51M followers • 2 following" in the page body.
 */
export async function extractFollowerCounts(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText;

    // Pattern: "51M followers • 2 following"
    const followerMatch = bodyText.match(/([\d.,]+[KMBkmb]?)\s+followers?/i);
    const followingMatch = bodyText.match(/([\d.,]+[KMBkmb]?)\s+following/i);

    function parseCount(str) {
      if (!str) return null;
      const cleaned = str.replace(/,/g, "").trim();
      const num = parseFloat(cleaned);
      if (isNaN(num)) return null;
      if (/[Kk]/.test(cleaned)) return Math.round(num * 1000);
      if (/[Mm]/.test(cleaned)) return Math.round(num * 1000000);
      if (/[Bb]/.test(cleaned)) return Math.round(num * 1000000000);
      return Math.round(num);
    }

    return {
      followerCount: parseCount(followerMatch?.[1]),
      followingCount: parseCount(followingMatch?.[1]),
      followerText: followerMatch?.[0] || null,
    };
  });
}

/**
 * Extract DOM-based page header info (name, bio, category, website).
 * Fallback when Relay data is incomplete.
 */
export async function extractPageHeaderDom(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText;

    // Page name from h2 or banner heading
    const bannerEl = document.querySelector('[role="banner"]');
    const h2s = bannerEl
      ? Array.from(bannerEl.querySelectorAll("h2")).map((h) => h.innerText.trim())
      : [];

    // Bio and links from intro section
    const introEl = document.querySelector('[aria-label="Intro"]') ||
      document.querySelector('[data-pagelet="ProfileIntroCard"]');
    const introText = introEl?.innerText || "";

    // External links in intro
    const introLinks = introEl
      ? Array.from(introEl.querySelectorAll("a[href]"))
          .map((a) => ({ text: a.innerText.trim(), href: a.href }))
          .filter((l) => l.href && !l.href.includes("facebook.com"))
      : [];

    return {
      h2Names: h2s,
      introText: introText.substring(0, 1000),
      introLinks: introLinks.slice(0, 5),
      bodyTextSnippet: bodyText.substring(0, 500),
    };
  });
}
