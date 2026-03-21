// ---------------------------------------------------------------------------
// Shared utilities for Reddit scraper skills
// ---------------------------------------------------------------------------

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
// Parse Reddit score text like "1.2k", "234k", "1.3M" -> number
// ---------------------------------------------------------------------------
export function parseScore(text) {
  if (!text) return null;
  if (typeof text === "number") return text;
  const s = String(text).trim().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*([KkMm]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  const mult = { K: 1e3, M: 1e6 }[suffix] || 1;
  return Math.round(n * mult);
}

// ---------------------------------------------------------------------------
// Parse Reddit relative timestamps "X hours ago", "X days ago" etc.
// Returns ISO string if possible, else null
// ---------------------------------------------------------------------------
export function parseRelativeTime(text) {
  if (!text) return null;
  // Reddit JSON API gives Unix timestamps, but DOM may give relative
  // Just pass through what we have
  return text;
}

// ---------------------------------------------------------------------------
// Parse a post object from Reddit's JSON API into a clean record
// ---------------------------------------------------------------------------
export function parsePost(data) {
  if (!data) return null;
  const d = data.data || data;
  
  const media = d.media?.reddit_video
    ? { type: "video", url: d.media.reddit_video.fallback_url, dash_url: d.media.reddit_video.dash_url, hls_url: d.media.reddit_video.hls_url, duration: d.media.reddit_video.duration }
    : d.preview?.images?.[0]
      ? { type: "image", url: d.preview.images[0].source?.url?.replace(/&amp;/g, "&"), width: d.preview.images[0].source?.width, height: d.preview.images[0].source?.height }
      : null;

  const thumbnail = d.thumbnail && !["self", "default", "nsfw", "spoiler", "image"].includes(d.thumbnail)
    ? d.thumbnail
    : null;

  return {
    id: d.id || null,
    fullname: d.name || null,
    url: d.url ? (d.url.startsWith("http") ? d.url : `https://www.reddit.com${d.url}`) : null,
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    title: d.title || null,
    author: d.author || null,
    authorId: d.author_fullname || null,
    subreddit: d.subreddit || null,
    subredditId: d.subreddit_id || null,
    flair: d.link_flair_text || null,
    score: d.score ?? null,
    upvoteRatio: d.upvote_ratio ?? null,
    numComments: d.num_comments ?? null,
    numCrossposts: d.num_crossposts ?? null,
    createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
    isVideo: d.is_video ?? false,
    isSelf: d.is_self ?? false,
    isNsfw: d.over_18 ?? false,
    isSpoiler: d.spoiler ?? false,
    isPinned: d.pinned ?? false,
    isStickied: d.stickied ?? false,
    isArchived: d.archived ?? false,
    isLocked: d.locked ?? false,
    selfText: d.selftext || null,
    selfTextHtml: d.selftext_html || null,
    domain: d.domain || null,
    thumbnail,
    media,
    awards: d.total_awards_received ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Parse a comment object from Reddit's JSON API into a clean record
// ---------------------------------------------------------------------------
export function parseComment(data) {
  if (!data) return null;
  const d = data.data || data;
  if (d.kind === "more") return null; // skip "load more" placeholders
  
  return {
    id: d.id || null,
    fullname: d.name || null,
    author: d.author || null,
    body: d.body || null,
    bodyHtml: d.body_html || null,
    score: d.score ?? null,
    createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
    isSubmitter: d.is_submitter ?? false,
    distinguished: d.distinguished || null,
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    depth: d.depth ?? 0,
    awards: d.total_awards_received ?? 0,
    replies: d.replies?.data?.children
      ? d.replies.data.children
          .filter(c => c.kind !== "more")
          .map(c => parseComment(c))
          .filter(Boolean)
      : [],
  };
}
