/**
 * Shared utilities for TikTok scrapers.
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
// TikTok constants
// ---------------------------------------------------------------------------

export const TT_HOME = "https://www.tiktok.com/";

// ---------------------------------------------------------------------------
// TikTok browser setup
// ---------------------------------------------------------------------------

/**
 * Initialize a camoufox browser with TikTok-appropriate settings.
 * Uses MacOS fingerprint to avoid mobile layout.
 */
export async function createTTBrowser(Camoufox) {
  return Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createTTContext(browser) {
  return browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
  });
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse a TikTok user object (from webapp.user-detail or item.author)
 * into a normalized profile object.
 */
export function parseUser(user, stats, statsV2) {
  if (!user) return null;

  // Use statsV2 for precise numbers if available
  const s = statsV2 || {};
  const sApprox = stats || {};

  return {
    id: user.id,
    uniqueId: user.uniqueId,
    nickname: user.nickname,
    signature: user.signature || null,
    avatarUrl: user.avatarLarger || user.avatarMedium || user.avatarThumb || null,
    isVerified: user.verified ?? false,
    isPrivate: user.privateAccount ?? user.secret ?? false,
    bioLink: user.bioLink?.link || null,
    followerCount: parseInt(s.followerCount ?? sApprox.followerCount ?? 0, 10),
    followingCount: parseInt(s.followingCount ?? sApprox.followingCount ?? 0, 10),
    heartCount: parseInt(s.heartCount ?? sApprox.heartCount ?? sApprox.heart ?? 0, 10),
    videoCount: parseInt(s.videoCount ?? sApprox.videoCount ?? 0, 10),
    commerceCategory: user.commerceUserInfo?.category || null,
    language: user.language || null,
    secUid: user.secUid || null,
  };
}

/**
 * Parse a TikTok video item into a normalized object.
 */
export function parseVideoItem(item) {
  if (!item) return null;

  const video = item.video || {};
  const author = item.author || {};
  const stats = item.stats || {};
  const music = item.music || {};
  const challenges = item.challenges || [];

  // Extract hashtags from description
  const desc = item.desc || "";
  const hashtags = desc.match(/#[\w\u0400-\u04FF]+/g) || [];

  // Extract cover image URLs
  const coverUrl = video.cover || video.originCover || video.dynamicCover || null;

  // Play URL (may expire quickly)
  const playUrl = video.playAddr || null;

  return {
    id: item.id,
    url: `https://www.tiktok.com/@${author.uniqueId}/video/${item.id}`,
    description: desc,
    hashtags,
    createTime: item.createTime
      ? new Date(item.createTime * 1000).toISOString()
      : null,
    duration: video.duration || null,
    width: video.width || null,
    height: video.height || null,
    ratio: video.ratio || null,
    coverUrl,
    playUrl,
    diggCount: stats.diggCount ?? null,
    shareCount: stats.shareCount ?? null,
    commentCount: stats.commentCount ?? null,
    playCount: stats.playCount ?? null,
    collectCount: stats.collectCount ?? null,
    author: {
      id: author.id,
      uniqueId: author.uniqueId,
      nickname: author.nickname,
      isVerified: author.verified ?? false,
      avatarUrl: author.avatarThumb || author.avatarMedium || null,
    },
    music: music.title
      ? {
          id: music.id,
          title: music.title,
          authorName: music.authorName || null,
          coverUrl: music.coverThumb || null,
          duration: music.duration || null,
          isOriginal: music.original ?? false,
        }
      : null,
    challenges: challenges.map((c) => ({
      id: c.id,
      title: c.title,
      desc: c.desc || null,
    })),
    isAd: item.isAd ?? false,
    isPinned: item.isPinnedItem ?? false,
    poi: item.poi
      ? {
          id: item.poi.id,
          name: item.poi.name,
        }
      : null,
  };
}

/**
 * Parse a TikTok challenge (hashtag) detail object.
 */
export function parseChallenge(challenge, stats) {
  if (!challenge) return null;
  return {
    id: challenge.id,
    title: challenge.title,
    description: challenge.desc || null,
    coverUrl: challenge.coverLarger || challenge.coverMedium || challenge.coverThumb || null,
    viewCount: stats?.viewCount ?? null,
    videoCount: stats?.videoCount ?? null,
    profileUrl: `https://www.tiktok.com/tag/${encodeURIComponent(challenge.title)}`,
  };
}
