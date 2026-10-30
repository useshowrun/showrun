#!/usr/bin/env node
// instagram-user.mjs — Instagram user operations
//
// Every request runs inside the logged-in instagram.com tab in Chrome (in-page
// fetch over CDP, see ../../_shared/instagram-fetch.mjs). No cookies are copied
// out of the browser.
//
// Commands:
//   node instagram-user.mjs auth                                      Check the Chrome tab is logged in
//   node instagram-user.mjs lookup <username>                         Profile by handle
//   node instagram-user.mjs lookup-id <id>                            Profile by numeric ID
//   node instagram-user.mjs posts <username|id> [--count=12] [--cursor=X]
//   node instagram-user.mjs reels <username|id> [--count=12] [--cursor=X]
//   node instagram-user.mjs highlights <username|id>                  Highlight reels tray
//   node instagram-user.mjs tagged <username|id> [--count=12] [--cursor=X]
//   node instagram-user.mjs stories <username|id>                     Active stories
//   node instagram-user.mjs followers <username|id> [--count=25] [--cursor=X]
//   node instagram-user.mjs following <username|id> [--count=25] [--cursor=X]
//
// Requires Node 22+ and the chrome-cdp skill. No external dependencies.

import { resolve } from 'path';
import {
  CACHE_DIR, ensureDir, saveJson,
  igApi, igGraphql, resolveUserPk, rememberUserPk, checkSession, InstagramStopError,
} from '../../_shared/instagram-fetch.mjs';

// ---------------------------------------------------------------------------
// Contact details parsed from the bio
// ---------------------------------------------------------------------------
//
// The web profile query no longer returns public_email / public_phone_number /
// business contact info (the contact buttons are mobile-app only). The next
// best source is what the account wrote in its bio and links.

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const WHATSAPP_RE = /(?:https?:\/\/)?(?:wa\.me\/[^\s"'<>]+|(?:api\.|web\.)?whatsapp\.com\/(?:send|message)[^\s"'<>]*|chat\.whatsapp\.com\/[^\s"'<>]+)/gi;
const PHONE_RE = /(?:\+|\b00)?\(?\d[\d\s().\-]{6,}\d/g;

function phoneDigits(s) {
  return String(s).replace(/^\s*(?:\+|00)/, '').replace(/\D/g, '');
}

function extractContacts(texts) {
  const emails = new Map(), phones = new Map(), whatsapp = new Map();
  for (const raw of texts) {
    if (!raw) continue;
    const text = String(raw);
    for (const m of text.matchAll(EMAIL_RE)) {
      const e = m[0].replace(/^mailto:/i, '').replace(/[.]+$/, '');
      emails.set(e.toLowerCase(), e);
    }
    for (const m of text.matchAll(WHATSAPP_RE)) {
      let url = m[0].replace(/[).,;]+$/, '');
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      let phone = null;
      try {
        const u = new URL(url);
        const fromPath = u.hostname.endsWith('wa.me') ? u.pathname.slice(1).split('/')[0] : '';
        const digits = (u.searchParams.get('phone') || fromPath || '').replace(/\D/g, '');
        if (digits.length >= 7) phone = `+${digits}`;
      } catch {}
      whatsapp.set(url, { url, phone });
      if (phone) phones.set(phoneDigits(phone), phone);
    }
    const tel = text.match(/^tel:(.+)$/i);
    const phoneText = tel ? tel[1] : text.replace(WHATSAPP_RE, ' ').replace(/https?:\/\/\S+/g, ' ');
    for (const m of phoneText.matchAll(PHONE_RE)) {
      const candidate = m[0].trim().replace(/[\s.\-]+$/, '');
      const digits = phoneDigits(candidate);
      if (digits.length < 9 || digits.length > 15) continue;
      if (!phones.has(digits)) phones.set(digits, candidate.replace(/\s+/g, ' '));
    }
  }
  return { emails: [...emails.values()], phones: [...phones.values()], whatsapp: [...whatsapp.values()] };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const ACCOUNT_TYPES = { 1: 'personal', 2: 'business', 3: 'creator' };

// `u` is data.user from PolarisProfilePageContentQuery.
function formatUserProfile(u) {
  const bioLinks = (u.bio_links || []).map(b => ({ title: b.title || null, url: b.url || null, link_type: b.link_type || null }));
  const contacts = extractContacts([u.biography, u.external_url, ...bioLinks.flatMap(b => [b.url, b.title])]);
  const hasAddress = u.address_street || u.city_name || u.zip;
  const isProfessional = u.is_professional_account
    ?? (u.account_type === 2 || u.account_type === 3 ? true : u.account_type === 1 ? false : null);
  return {
    id: String(u.id || u.pk),
    username: u.username,
    full_name: u.full_name,
    biography: u.biography,
    bio_links: bioLinks,
    external_url: u.external_url || null,
    followers_count: u.follower_count ?? null,
    following_count: u.following_count ?? null,
    posts_count: u.media_count ?? null,
    highlight_reel_count: null, // not in the web profile query; use `highlights`
    profile_pic_url: u.hd_profile_pic_url_info?.url || u.profile_pic_url || null,
    is_private: u.is_private ?? null,
    is_verified: u.is_verified ?? null,
    is_business_account: u.is_business ?? null,
    is_professional_account: isProfessional,
    account_type: (ACCOUNT_TYPES[u.account_type] || u.account_type) ?? null,
    business_category_name: null, // not exposed on web; category_name is the public category
    category_name: u.category || null,
    // Contact buttons are mobile-app only now: the web API never returns these.
    business_email: null,
    business_phone_number: null,
    public_email: null,
    public_phone_number: null,
    business_address: hasAddress
      ? { street_address: u.address_street || null, city_name: u.city_name || null, zip_code: u.zip || null }
      : null,
    // Parsed from biography + bio_links + external_url.
    bio_emails: contacts.emails,
    bio_phone_numbers: contacts.phones,
    bio_whatsapp_links: contacts.whatsapp,
    pronouns: u.pronouns || [],
    has_clips: u.total_clips_count != null ? u.total_clips_count > 0 : null,
    clips_count: u.total_clips_count ?? null,
    has_channel: null,
    fbid: u.fbid_v2 || null,
    mutual_followers_count: u.mutual_followers_count ?? null,
  };
}

function formatUserShort(u) {
  return {
    id: u.pk || u.id,
    username: u.username,
    full_name: u.full_name,
    is_private: u.is_private,
    is_verified: u.is_verified,
    profile_pic_url: u.profile_pic_url,
  };
}

function bestImage(versions) {
  if (!versions || !versions.length) return null;
  return versions.reduce((best, v) => (!best || v.width > best.width ? v : best), null)?.url || null;
}

// Works for both v1 feed items and GraphQL XDTMediaDict nodes (same shape).
function formatMediaItem(item) {
  // media_type: 1=image, 2=video, 8=carousel
  const carouselMedia = item.carousel_media
    ? item.carousel_media.map(m => ({
        id: m.pk || m.id,
        media_type: m.media_type,
        image_url: bestImage(m.image_versions2?.candidates),
        video_url: m.video_versions?.[0]?.url,
      }))
    : null;
  return {
    id: item.pk || item.id,
    code: item.code,
    url: item.code ? `https://www.instagram.com/p/${item.code}/` : null,
    media_type: item.media_type,
    is_video: item.media_type === 2,
    is_carousel: item.media_type === 8,
    taken_at: item.taken_at,
    caption: item.caption?.text || null,
    like_count: item.like_count,
    comment_count: item.comment_count,
    play_count: item.play_count || item.view_count,
    image_url: bestImage(item.image_versions2?.candidates),
    video_url: item.video_versions?.[0]?.url,
    carousel: carouselMedia,
    owner: item.user ? { id: item.user.pk || item.user.id, username: item.user.username, full_name: item.user.full_name } : null,
    location: item.location ? { name: item.location.name, id: item.location.pk, lat: item.location.lat, lng: item.location.lng } : null,
    accessibility_caption: item.accessibility_caption,
  };
}

function formatReel(node) {
  // clips/user/ items wrap media under .media
  const item = node.media || node;
  return formatMediaItem(item);
}

function formatStoryItem(item) {
  return {
    id: item.pk || item.id,
    media_type: item.media_type,
    taken_at: item.taken_at,
    expiring_at: item.expiring_at,
    image_url: bestImage(item.image_versions2?.candidates),
    video_url: item.video_versions?.[0]?.url,
    video_duration: item.video_duration,
  };
}

// ---------------------------------------------------------------------------
// User resolver
// ---------------------------------------------------------------------------

function normalizeUsername(s) {
  return String(s || '').replace(/^@/, '').trim().toLowerCase();
}

function fetchProfileById(pk) {
  const data = igGraphql('PolarisProfilePageContentQuery', { enable_integrity_filters: true, id: String(pk) });
  if (!data?.user) throw new Error(`User not found: ${pk}`);
  rememberUserPk(data.user.username, data.user.pk || data.user.id);
  return data.user;
}

function fetchProfile(username) {
  const u = normalizeUsername(username);
  const pk = resolveUserPk(u);
  let user = fetchProfileById(pk);
  if (normalizeUsername(user.username) !== u) {
    // Cached id belongs to an account that has since changed its handle.
    const fresh = resolveUserPk(u, { refresh: true });
    if (fresh !== pk) user = fetchProfileById(fresh);
  }
  return user;
}

function resolveUserId(target) {
  const t = normalizeUsername(target);
  return /^\d+$/.test(t) ? t : resolveUserPk(t);
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : 'true';
    else positional.push(arg);
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdAuth() {
  const s = checkSession();
  console.log(JSON.stringify({ ok: true, userId: s.userId, tabId: s.tabId, href: s.href, appLoaded: s.appLoaded }, null, 2));
}

function cmdLookup(username) {
  if (!username) { console.error('Usage: lookup <username>'); process.exit(1); }
  const profile = formatUserProfile(fetchProfile(username));
  saveJson(resolve(CACHE_DIR, `user-${profile.username}.json`), profile);
  console.log(JSON.stringify(profile, null, 2));
}

function cmdLookupId(id) {
  if (!id || !/^\d+$/.test(id)) { console.error('Usage: lookup-id <numeric id>'); process.exit(1); }
  const profile = formatUserProfile(fetchProfileById(id));
  saveJson(resolve(CACHE_DIR, `user-id-${id}.json`), profile);
  console.log(JSON.stringify(profile, null, 2));
}

function cmdPosts(target, flags) {
  if (!target) { console.error('Usage: posts <username|id> [--count=12] [--cursor=X]'); process.exit(1); }
  const t = normalizeUsername(target);
  const username = /^\d+$/.test(t) ? fetchProfileById(t).username : t;
  const count = parseInt(flags.count || '12', 10);
  const variables = {
    data: {
      count,
      include_reel_media_seen_timestamp: true,
      include_relationship_info: true,
      latest_besties_reel_media: true,
      latest_reel_media: true,
    },
    username,
  };
  if (flags.cursor) Object.assign(variables, { after: flags.cursor, before: null, first: count, last: null });
  const data = igGraphql('PolarisProfilePostsQuery', variables);
  const conn = data.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!conn) throw new Error(`No timeline returned for ${username} (private or unavailable account?)`);
  const posts = (conn.edges || []).map(e => formatMediaItem(e.node));
  const result = {
    posts,
    nextCursor: conn.page_info?.has_next_page ? conn.page_info.end_cursor || null : null,
    more_available: !!conn.page_info?.has_next_page,
  };
  saveJson(resolve(CACHE_DIR, `posts-${username}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

function cmdReels(target, flags) {
  if (!target) { console.error('Usage: reels <username|id> [--count=12] [--cursor=X]'); process.exit(1); }
  const userId = resolveUserId(target);
  const count = parseInt(flags.count || '12', 10);
  // POST /api/v1/clips/user/ now returns HTML for web; these are the profile
  // Reels tab queries. The grid query carries code, counts, and thumbnail but
  // not caption/taken_at/video URL — use `instagram-post info <code>` for those.
  const data = { include_feed_video: true, page_size: count, target_user_id: userId };
  const res = flags.cursor
    ? igGraphql('PolarisProfileReelsTabContentQuery_connection', { after: flags.cursor, data, first: count, id: userId })
    : igGraphql('PolarisProfileReelsTabContentQuery', { data, user_id: userId });
  const conn = res.fetch__XDTUserDict?.clips_connection;
  if (!conn) throw new Error(`No reels returned for ${target} (private or unavailable account?)`);
  const reels = (conn.edges || []).map(e => formatReel(e.node));
  const more = !!conn.page_info?.has_next_page;
  const result = { reels, nextCursor: more ? conn.page_info.end_cursor || null : null, more_available: more };
  saveJson(resolve(CACHE_DIR, `reels-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

function cmdHighlights(target) {
  if (!target) { console.error('Usage: highlights <username|id>'); process.exit(1); }
  const userId = resolveUserId(target);
  const data = igGraphql('PolarisProfileStoryHighlightsTrayContentQuery', { user_id: userId });
  const highlights = (data.highlights?.edges || []).map(({ node: h }) => ({
    id: h.id,
    title: h.title,
    media_count: h.media_count ?? null,
    cover_image_url: h.cover_media?.cropped_image_version?.url || h.cover_media?.thumbnail_src || null,
    created_at: h.created_at ?? null,
  }));
  const result = { highlights };
  saveJson(resolve(CACHE_DIR, `highlights-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

function cmdTagged(target, flags) {
  if (!target) { console.error('Usage: tagged <username|id> [--count=12] [--cursor=X]'); process.exit(1); }
  const userId = resolveUserId(target);
  const count = parseInt(flags.count || '12', 10);
  // /api/v1/usertags/<id>/feed/ now 404s for web; this is the Tagged tab query.
  const variables = { count, user_id: userId };
  if (flags.cursor) Object.assign(variables, { after: flags.cursor, first: count });
  const data = igGraphql('PolarisProfileTaggedTabContentQuery', variables);
  const conn = data.xdt_api__v1__usertags__user_id__feed_connection;
  if (!conn) throw new Error(`No tagged posts returned for ${target} (private or unavailable account?)`);
  const posts = (conn.edges || []).map(e => formatMediaItem(e.node));
  const more = !!conn.page_info?.has_next_page;
  const result = { posts, nextCursor: more ? conn.page_info.end_cursor || null : null, more_available: more };
  saveJson(resolve(CACHE_DIR, `tagged-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

function cmdStories(target) {
  if (!target) { console.error('Usage: stories <username|id>'); process.exit(1); }
  const userId = resolveUserId(target);
  // /api/v1/feed/reels_media/ now 500s for web; this is the story viewer's query.
  const data = igGraphql('PolarisStoriesV3ReelPageStandaloneQuery', { reel_ids_arr: [userId], is_highlight: false });
  const reel = (data.xdt_api__v1__feed__reels_media?.reels_media || [])
    .find(r => String(r.id) === String(userId) || String(r.user?.pk || r.user?.id) === String(userId));
  if (!reel) {
    console.log(JSON.stringify({ stories: [], reel: null }, null, 2));
    return;
  }
  const stories = (reel.items || []).map(formatStoryItem);
  const result = {
    reel: {
      id: reel.id,
      latest_reel_media: reel.latest_reel_media,
      expiring_at: stories.reduce((max, s) => Math.max(max, s.expiring_at || 0), 0) || null,
      seen: reel.seen,
    },
    stories,
  };
  saveJson(resolve(CACHE_DIR, `stories-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

function cmdFriendships(kind, target, flags) {
  if (!target) { console.error(`Usage: ${kind} <username|id> [--count=25] [--cursor=X]`); process.exit(1); }
  const userId = resolveUserId(target);
  const count = parseInt(flags.count || '25', 10);
  let path = `/api/v1/friendships/${userId}/${kind}/?count=${count}`;
  if (flags.cursor) path += `&max_id=${encodeURIComponent(flags.cursor)}`;
  const data = igApi(path);
  const users = (data.users || []).map(formatUserShort);
  const result = { users, nextCursor: data.next_max_id || null };
  saveJson(resolve(CACHE_DIR, `${kind}-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`instagram-user — Instagram user operations

Commands:
  auth                              Check the Chrome instagram.com tab is logged in
  lookup <username>                 Get profile by @username
  lookup-id <id>                    Get profile by numeric user ID
  posts <username|id> [--count=12] [--cursor=X]      Recent posts
  reels <username|id> [--count=12] [--cursor=X]      Recent reels
  highlights <username|id>          Highlight reels tray
  tagged <username|id> [--count=12] [--cursor=X]     Posts user is tagged in
  stories <username|id>             Active 24h stories
  followers <username|id> [--count=25] [--cursor=X]  Followers list
  following <username|id> [--count=25] [--cursor=X]  Following list

Requests run inside the logged-in instagram.com tab in Chrome (chrome-cdp).
Cache: ~/.local/share/showrun/data/instagram/cache/`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];
  const arg1 = positional[1];

  ensureDir(CACHE_DIR);

  try {
    switch (command) {
      case 'auth':         cmdAuth(); break;
      case 'lookup':       cmdLookup(arg1); break;
      case 'lookup-id':    cmdLookupId(arg1); break;
      case 'posts':        cmdPosts(arg1, flags); break;
      case 'reels':        cmdReels(arg1, flags); break;
      case 'highlights':   cmdHighlights(arg1); break;
      case 'tagged':       cmdTagged(arg1, flags); break;
      case 'stories':      cmdStories(arg1); break;
      case 'followers':    cmdFriendships('followers', arg1, flags); break;
      case 'following':    cmdFriendships('following', arg1, flags); break;
      default: printUsage();
    }
  } catch (err) {
    if (err instanceof InstagramStopError) console.error(`STOP: ${err.message}`);
    else console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
