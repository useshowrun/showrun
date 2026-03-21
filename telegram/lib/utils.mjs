// ---------------------------------------------------------------------------
// Shared utilities for Telegram scraper skills
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
// Parse subscriber/member counts like "10.4M" → 10400000, "5,000" → 5000
// ---------------------------------------------------------------------------
export function parseCount(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/,/g, "");
  const m = cleaned.match(/^([\d.]+)\s*([KMBkm]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
  return Math.round(n * multiplier);
}

// ---------------------------------------------------------------------------
// Parse a Telegram channel username from any input format:
//   "durov", "@durov", "t.me/durov", "https://t.me/durov", "https://t.me/s/durov"
// ---------------------------------------------------------------------------
export function parseChannelUsername(input) {
  input = input.trim();
  // Full URL
  try {
    const url = new URL(input);
    if (url.hostname === "t.me") {
      // Could be /s/username or /username
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "s") return parts[1] || null;
      return parts[0] || null;
    }
  } catch (_) {}
  // @username
  if (input.startsWith("@")) return input.slice(1);
  // Plain username (no dots/slashes)
  if (/^[a-zA-Z0-9_]+$/.test(input)) return input;
  return null;
}

// ---------------------------------------------------------------------------
// Strip HTML tags from message text, preserving line breaks
// ---------------------------------------------------------------------------
export function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<b>(.*?)<\/b>/gi, "$1")
    .replace(/<i>(.*?)<\/i>/gi, "$1")
    .replace(/<a[^>]*>(.*?)<\/a>/gi, "$1")
    .replace(/<tg-emoji[^>]*>.*?<\/tg-emoji>/gi, (match) => {
      // Extract the fallback text from <b> inside tg-emoji
      const b = match.match(/<b>(.*?)<\/b>/);
      return b ? b[1] : "";
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#33;/g, "!")
    .trim();
}

// ---------------------------------------------------------------------------
// Extract links from message HTML
// ---------------------------------------------------------------------------
export function extractLinks(html) {
  if (!html) return [];
  const links = [];
  const regex = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    const text = stripHtml(match[2]);
    // Skip internal Telegram links (navigation, previews)
    if (href.startsWith("//telegram.org") || href.includes("t.me/")) {
      links.push({ url: href, text });
    } else if (href.startsWith("http") || href.startsWith("tg://")) {
      links.push({ url: href, text });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Parse message HTML block into a structured message object
// Returns null if not a valid message
// ---------------------------------------------------------------------------
export function parseMessageHtml(html, channelUsername) {
  // Extract data-post attribute: "channelname/123"
  const dataPost = html.match(/data-post="([^/]+)\/(\d+)"/);
  if (!dataPost) return null;
  const messageId = parseInt(dataPost[2], 10);
  const messageUrl = `https://t.me/${channelUsername}/${messageId}`;

  // Extract datetime
  const datetimeMatch = html.match(/datetime="([^"]+)"/);
  const datetime = datetimeMatch ? datetimeMatch[1] : null;

  // Check if edited
  const isEdited = html.includes("js-message_edited") || html.includes("tgme_widget_message_meta edited");

  // Extract author (for forwarded messages or group chats)
  const authorMatch = html.match(/tgme_widget_message_from_author"[^>]*>([^<]+)</);
  const author = authorMatch ? authorMatch[1].trim() : null;

  // Extract message text (main text content)
  const textMatch = html.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const rawText = textMatch ? textMatch[1] : "";
  const text = stripHtml(rawText);

  // Extract view count
  const viewsMatch = html.match(/<span class="tgme_widget_message_views">([\d.KMB]+)<\/span>/);
  const views = viewsMatch ? parseCount(viewsMatch[1]) : null;
  const viewsText = viewsMatch ? viewsMatch[1] : null;

  // Extract reactions
  const reactions = [];
  const reactionBlock = html.match(/tgme_widget_message_reactions[^>]*>([\s\S]*?)<\/div>/);
  if (reactionBlock) {
    // Paid stars reaction
    const paidMatch = reactionBlock[1].match(/tgme_reaction_paid.*?>([\d.KMB]+)</);
    if (paidMatch) {
      reactions.push({ type: "stars", count: parseCount(paidMatch[1]), countText: paidMatch[1] });
    }
    // Regular reactions (emoji ID based)
    const emojiReactions = [...reactionBlock[1].matchAll(/tgme_reaction"[^>]*><tg-emoji[^>]*>.*?<\/tg-emoji>([\d.KMB]+)</g)];
    for (const r of emojiReactions) {
      reactions.push({ type: "emoji", count: parseCount(r[1]), countText: r[1] });
    }
  }
  const totalReactions = reactions.reduce((sum, r) => sum + (r.count || 0), 0);

  // Detect media type
  const hasPhoto = html.includes("tgme_widget_message_photo_wrap") || html.includes("message_photo");
  const hasVideo = html.includes("tgme_widget_message_video") || html.includes("js-message_video");
  const hasVoice = html.includes("tgme_widget_message_voice");
  const hasDocument = html.includes("tgme_widget_message_document");
  const hasPoll = html.includes("tgme_widget_message_poll");
  const hasSticker = html.includes("tgme_widget_message_sticker");
  const hasLinkPreview = html.includes("tgme_widget_message_link_preview");

  let mediaType = null;
  if (hasVideo) mediaType = "video";
  else if (hasPhoto) mediaType = "photo";
  else if (hasVoice) mediaType = "voice";
  else if (hasDocument) mediaType = "document";
  else if (hasSticker) mediaType = "sticker";
  else if (hasPoll) mediaType = "poll";

  // Extract photo URLs (background-image from message_photo)
  const photoUrls = [];
  const photoBgRegex = /tgme_widget_message_photo_wrap[^>]+>|message_photo[^>]+style="[^"]*background-image:url\('([^']+)'\)/g;
  let photoBgMatch;
  // Try direct photo URL pattern
  const photoBgDirect = [...html.matchAll(/style="[^"]*background-image:url\('(https:\/\/cdn[^']+\.(jpg|png|webp)[^']*)'\)"/g)];
  for (const m of photoBgDirect) {
    if (!m[1].includes("telesco.pe/file/r") || photoUrls.length === 0) {
      // Filter out profile pictures (reused across all messages)
      photoUrls.push(m[1]);
    }
  }

  // Extract video URL
  let videoUrl = null;
  const videoMatch = html.match(/<video[^>]+src="([^"]+)"/);
  if (videoMatch) videoUrl = videoMatch[1];

  // Extract video duration
  let videoDuration = null;
  const videoDurMatch = html.match(/message_video_duration[^>]*>([\d:]+)</);
  if (videoDurMatch) videoDuration = videoDurMatch[1];

  // Extract link preview
  let linkPreview = null;
  if (hasLinkPreview) {
    const lpHref = html.match(/tgme_widget_message_link_preview"[^>]+href="([^"]+)"/);
    const lpSite = html.match(/link_preview_site_name[^>]*>(.*?)<\/div>/);
    const lpTitle = html.match(/link_preview_title[^>]*>(.*?)<\/div>/);
    const lpDesc = html.match(/link_preview_description[^>]*>([\s\S]*?)<\/div>/);
    const lpImg = html.match(/link_preview_image[^>]+style="[^"]*background-image:url\('([^']+)'\)"/);
    linkPreview = {
      url: lpHref ? lpHref[1] : null,
      siteName: lpSite ? stripHtml(lpSite[1]) : null,
      title: lpTitle ? stripHtml(lpTitle[1]) : null,
      description: lpDesc ? stripHtml(lpDesc[1]) : null,
      imageUrl: lpImg ? lpImg[1] : null,
    };
  }

  // Extract forwarded from
  let forwardedFrom = null;
  const fwdMatch = html.match(/tgme_widget_message_forwarded_from_name[^>]*>([\s\S]*?)<\/span>/);
  if (fwdMatch) forwardedFrom = stripHtml(fwdMatch[1]);

  // Extract links from text
  const links = extractLinks(rawText);

  // Extract hashtags
  const hashtags = [...text.matchAll(/#([a-zA-Z0-9_]+)/g)].map((m) => m[1]);

  return {
    messageId,
    messageUrl,
    datetime,
    isEdited,
    author,
    text,
    mediaType,
    photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
    videoUrl: videoUrl || undefined,
    videoDuration: videoDuration || undefined,
    linkPreview: linkPreview || undefined,
    forwardedFrom: forwardedFrom || undefined,
    links: links.length > 0 ? links : undefined,
    hashtags: hashtags.length > 0 ? hashtags : undefined,
    views,
    viewsText,
    reactions: reactions.length > 0 ? reactions : undefined,
    totalReactions: totalReactions > 0 ? totalReactions : undefined,
  };
}

// ---------------------------------------------------------------------------
// Parse channel info from t.me/s/{channel} page HTML
// ---------------------------------------------------------------------------
export function parseChannelInfo(html, channelUsername) {
  // Title
  const titleMatch = html.match(/tgme_channel_info_header_title[^>]*><span[^>]*>(.*?)<\/span>/);
  const title = titleMatch ? stripHtml(titleMatch[1]) : channelUsername;

  // Verified
  const isVerified = html.includes("verified-icon");

  // Description
  const descMatch = html.match(/tgme_channel_info_description">([\s\S]*?)<\/div>/);
  const description = descMatch ? stripHtml(descMatch[1]) : null;

  // Photo URL
  const photoMatch = html.match(/tgme_page_photo_image[^>]+>[\s\S]*?<img src="([^"]+)"/);
  const photoUrl = photoMatch ? photoMatch[1] : null;

  // OG image (larger version)
  const ogImgMatch = html.match(/og:image.*?content="([^"]+)"/);
  const ogImageUrl = ogImgMatch ? ogImgMatch[1] : null;

  // Counters
  const counters = {};
  const counterRegex = /<span class="counter_value">(.*?)<\/span>[\s\S]*?<span class="counter_type">(.*?)<\/span>/g;
  let counterMatch;
  while ((counterMatch = counterRegex.exec(html)) !== null) {
    const value = counterMatch[1].trim();
    const type = counterMatch[2].trim();
    counters[type] = { text: value, count: parseCount(value) };
  }

  const subscriberCount = counters["subscribers"]?.count || null;
  const subscriberText = counters["subscribers"]?.text || null;

  return {
    username: channelUsername,
    title,
    description,
    isVerified,
    photoUrl: photoUrl || ogImageUrl,
    subscriberCount,
    subscriberText,
    photoCount: counters["photos"]?.count || null,
    videoCount: counters["videos"]?.count || null,
    linkCount: counters["links"]?.count || null,
  };
}

// ---------------------------------------------------------------------------
// Fetch a t.me/s page and return { html, isChannel, beforeId }
// Uses camoufox browser page for fetching
// ---------------------------------------------------------------------------
export async function fetchTelegramPage(page, channelUsername, beforeId = null) {
  let url = `https://t.me/s/${channelUsername}`;
  if (beforeId) url += `?before=${beforeId}`;

  log(`[telegram] Fetching: ${url}`);
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const finalUrl = page.url();
  const html = await page.content();

  // If redirected away from /s/ URL, it's not a public channel
  const isChannel = finalUrl.includes(`/s/${channelUsername}`) ||
    html.includes("tgme_channel_info_counters");

  // Extract the "before" link for pagination
  const beforeMatch = html.match(/data-before="(\d+)"/);
  const nextBeforeId = beforeMatch ? parseInt(beforeMatch[1], 10) : null;

  return { html, isChannel, nextBeforeId, finalUrl };
}
