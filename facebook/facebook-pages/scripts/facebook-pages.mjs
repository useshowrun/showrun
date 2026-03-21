#!/usr/bin/env node

/**
 * Facebook Pages Scraper
 *
 * Scrapes public Facebook page information:
 * - Name, category, follower count, about text
 * - Contact info (email, phone, website, social links)
 * - Profile and cover photo URLs
 * - Page ID and verification status
 *
 * Strategy:
 *   1. Navigate to facebook.com/<page>/about_contact_and_basic_info
 *   2. Parse Relay/GraphQL JSON fragments from SSR (profile header, profile pic, cover)
 *   3. Extract structured contact data from DOM (category, website, email, phone, address)
 *   4. Extract follower count from DOM body text
 *   5. Optionally navigate to /about_details for extended bio
 *
 * No login required for public page data.
 *
 * Usage:
 *   node facebook-pages.mjs <page_username_or_url> [--bio] [--posts] [--max <N>]
 *
 * Examples:
 *   node facebook-pages.mjs natgeo
 *   node facebook-pages.mjs https://www.facebook.com/nasa
 *   node facebook-pages.mjs cnn --bio
 *   node facebook-pages.mjs starbucks --posts --max 3
 *
 * Environment:
 *   FB_COOKIES - JSON array of Facebook session cookies (optional, enables more data)
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createFbBrowser,
  createFbContext,
  extractRelayData,
  parseProfileData,
  extractFollowerCounts,
  parseStoryNode,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let pageInput = null;
let includeBio = false;
let includePosts = false;
let maxPosts = 3;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bio") {
    includeBio = true;
  } else if (args[i] === "--posts") {
    includePosts = true;
  } else if (args[i] === "--max" && args[i + 1]) {
    maxPosts = parseInt(args[i + 1], 10);
    i++;
  } else if (!pageInput) {
    pageInput = args[i];
  }
}

if (!pageInput) {
  emitError("MISSING_ARG", "Usage: facebook-pages.mjs <page_username_or_url> [--bio] [--posts] [--max N]");
}

// ---------------------------------------------------------------------------
// Resolve username
// ---------------------------------------------------------------------------

function resolveUsername(input) {
  if (input.includes("facebook.com/")) {
    try {
      const url = new URL(input.startsWith("http") ? input : "https://" + input);
      const parts = url.pathname.split("/").filter(Boolean);
      const slug = parts.find(
        (p) => !["about", "about_contact_and_basic_info", "about_details",
                  "posts", "photos", "videos", "reviews", "events", "about_profile_transparency"].includes(p)
      );
      return slug || parts[0] || input;
    } catch {
      return input;
    }
  }
  return input.replace(/\/$/, "").trim();
}

const username = resolveUsername(pageInput);
const pageUrl = `https://www.facebook.com/${username}`;
const contactInfoUrl = `https://www.facebook.com/${username}/about_contact_and_basic_info`;
const detailsUrl = `https://www.facebook.com/${username}/about_details`;

// ---------------------------------------------------------------------------
// Auth cookies
// ---------------------------------------------------------------------------

async function loadAuthCookies(context) {
  const cookiesJson = process.env.FB_COOKIES;
  if (!cookiesJson) return false;
  try {
    const cookies = JSON.parse(cookiesJson);
    await context.addCookies(
      cookies.map((c) => ({ ...c, domain: c.domain || ".facebook.com" }))
    );
    log("Loaded FB_COOKIES");
    return true;
  } catch (e) {
    log(`FB_COOKIES parse error: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extract page data from contact info DOM
// Navigating to /about_contact_and_basic_info gives structured data
// ---------------------------------------------------------------------------

async function extractContactInfoDom(page) {
  return page.evaluate(() => {
    const result = {
      categories: [],
      website: null,
      email: null,
      phone: null,
      address: null,
      socialLinks: [],
      instagram: null,
      twitter: null,
      linkedin: null,
      youtube: null,
      tiktok: null,
      name: null,
    };

    const main = document.querySelector('[role="main"]');
    if (!main) return result;

    // Parse structured sections by their text headers
    const allText = main.innerText;
    const sections = {};
    const lines = allText.split("\n").map((l) => l.trim()).filter(Boolean);
    let currentSection = null;
    let sectionLines = [];

    const sectionHeaders = [
      "Categories",
      "Contact info",
      "Address",
      "Websites and social links",
      "About",
      "Basic info",
      "Email",
      "Phone",
      "Mobile",
    ];

    for (const line of lines) {
      if (sectionHeaders.includes(line)) {
        if (currentSection) sections[currentSection] = sectionLines.join("\n");
        currentSection = line;
        sectionLines = [];
      } else {
        if (currentSection) sectionLines.push(line);
      }
    }
    if (currentSection) sections[currentSection] = sectionLines.join("\n");

    // Categories
    if (sections["Categories"]) {
      result.categories = sections["Categories"]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    }

    // Contact section: phone and email
    const contactText = sections["Contact info"] || "";
    const emailMatch = contactText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) result.email = emailMatch[0];
    // Phone: various formats
    const phoneMatch = contactText.match(/[\+\(]?[\d][\d\-\(\)\s]{6,}[\d]/);
    if (phoneMatch) result.phone = phoneMatch[0].trim();

    // Address
    if (sections["Address"]) {
      result.address = sections["Address"].trim();
    }

    // Extract external links (Facebook uses redirect URLs)
    const links = Array.from(main.querySelectorAll("a[href]"));
    for (const link of links) {
      const href = link.href || "";

      // Facebook redirect links
      if (href.includes("l.facebook.com/l.php") || href.includes("lm.facebook.com")) {
        try {
          const url = new URL(href);
          const u = url.searchParams.get("u") || url.searchParams.get("href");
          if (u) {
            const decoded = decodeURIComponent(u);
            if (!decoded.includes("facebook.com")) {
              const host = new URL(decoded).hostname;
              if (host.includes("instagram.com")) {
                result.instagram = decoded;
                result.socialLinks.push({ platform: "instagram", url: decoded });
              } else if (host.includes("twitter.com") || host.includes("x.com")) {
                result.twitter = decoded;
                result.socialLinks.push({ platform: "twitter", url: decoded });
              } else if (host.includes("linkedin.com")) {
                result.linkedin = decoded;
                result.socialLinks.push({ platform: "linkedin", url: decoded });
              } else if (host.includes("youtube.com")) {
                result.youtube = decoded;
                result.socialLinks.push({ platform: "youtube", url: decoded });
              } else if (host.includes("tiktok.com")) {
                result.tiktok = decoded;
                result.socialLinks.push({ platform: "tiktok", url: decoded });
              } else if (!result.website) {
                result.website = decoded;
              } else {
                result.socialLinks.push({ platform: "website", url: decoded });
              }
            }
          }
        } catch {}
      }

      // Direct mailto/tel links
      if (href.startsWith("mailto:") && !result.email) {
        result.email = href.replace("mailto:", "");
      }
      if (href.startsWith("tel:") && !result.phone) {
        result.phone = href.replace("tel:", "").replace(/[^0-9+\-\(\) ]/g, "");
      }
    }

    // Fallback: website from plain text URL in Websites section
    if (!result.website) {
      const webSection = sections["Websites and social links"] || "";
      const urlMatch = webSection.match(/https?:\/\/[^\s]+/);
      if (urlMatch) result.website = urlMatch[0];
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Extract extended bio/about from about_details page
// ---------------------------------------------------------------------------

async function extractBioFromDetailsDom(page) {
  return page.evaluate(() => {
    const main = document.querySelector('[role="main"]');
    if (!main) return null;

    const allText = main.innerText;
    const sections = {};
    const lines = allText.split("\n").map((l) => l.trim()).filter(Boolean);
    let currentSection = null;
    let sectionLines = [];

    // Stop collecting when we hit navigation or UI elements
    const uiStopWords = ["Reels", "Photos", "Videos", "See all", "More", "Check in", "Send message"];
    const sectionHeaders = [
      "About", "Mission", "General Information", "Description", "Impressum",
      `About ${allText.split("\n")[0]}`,  // "About PageName"
    ];

    for (const line of lines) {
      // Stop at UI elements
      if (uiStopWords.some((w) => line === w || line.startsWith(w + "\n"))) break;
      if (/^\d+[KMB]?$/.test(line)) break; // stop at engagement numbers

      if (sectionHeaders.some((h) => line.startsWith("About"))) {
        if (currentSection) sections[currentSection] = sectionLines.join("\n");
        currentSection = "About";
        sectionLines = [];
      } else if (line === "Mission") {
        if (currentSection) sections[currentSection] = sectionLines.join("\n");
        currentSection = "Mission";
        sectionLines = [];
      } else if (line === "General Information") {
        if (currentSection) sections[currentSection] = sectionLines.join("\n");
        currentSection = "General Information";
        sectionLines = [];
      } else {
        if (currentSection) sectionLines.push(line);
      }
    }
    if (currentSection) sections[currentSection] = sectionLines.join("\n");

    // Trim and filter the "About" text to remove UI noise
    let about = sections["About"] || sections["Description"] || null;
    if (about) {
      // Remove lines that look like navigation/UI elements
      const noisePatterns = [
        /^(Reels|Photos|Videos|Events|See all|More|Check in|Send message|Like|Follow|Share)/i,
        /^\d+[KMBkmb]?$/, // standalone numbers
      ];
      const cleanLines = about.split("\n").filter((l) => {
        const t = l.trim();
        if (!t) return false;
        return !noisePatterns.some((p) => p.test(t));
      });
      about = cleanLines.join("\n").trim() || null;

      // Cap at 2000 chars for sanity
      if (about && about.length > 2000) about = about.substring(0, 2000) + "...";
    }

    return {
      about,
      mission: sections["Mission"] || null,
      generalInfo: sections["General Information"] || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Extract follower count and page name from DOM
// ---------------------------------------------------------------------------

async function extractHeaderInfoDom(page) {
  return page.evaluate(() => {
    const result = {
      name: null,
      followerCount: null,
      followerText: null,
      likesCount: null,
      likesText: null,
      rating: null,
      ratingCount: null,
    };

    // Name from h1 or h2 in main
    const h1 = document.querySelector("h1");
    if (h1) result.name = h1.innerText?.trim();

    // From page title
    if (!result.name) {
      const title = document.title;
      const m = title.match(/^(.+?)[\s|][-|]\s*Facebook/);
      if (m) result.name = m[1].trim();
    }

    // Follower count from body text
    const bodyText = document.body.innerText;

    const followerMatch = bodyText.match(/([\d,]+(?:\.\d+)?[KMBkmb]?)\s+followers?/i);
    if (followerMatch) {
      result.followerText = followerMatch[0];
      const numStr = followerMatch[1].replace(/,/g, "");
      const num = parseFloat(numStr);
      if (/[Kk]/.test(numStr)) result.followerCount = Math.round(num * 1e3);
      else if (/[Mm]/.test(numStr)) result.followerCount = Math.round(num * 1e6);
      else if (/[Bb]/.test(numStr)) result.followerCount = Math.round(num * 1e9);
      else result.followerCount = Math.round(num);
    }

    const likesMatch = bodyText.match(/([\d,]+(?:\.\d+)?[KMBkmb]?)\s+(?:people\s+)?likes?/i);
    if (likesMatch) {
      result.likesText = likesMatch[0];
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Extract profile and cover photo from Relay data
// ---------------------------------------------------------------------------

function extractMediaFromRelay(relayEntries) {
  let profilePicUrl = null;
  let coverPhotoUrl = null;
  let pageId = null;
  let pageName = null;
  let isVerified = false;

  for (const entry of relayEntries) {
    const bbox = entry.bbox;
    if (!bbox?.result?.data) continue;
    const data = bbox.result.data;

    // Handle flat profile data entries (entries with __isProfile at root level)
    // These appear as: { __isProfile: "User", profilePic160: { uri: ... }, ... }
    if (data.__isProfile && data.profilePic160?.uri && !profilePicUrl) {
      profilePicUrl = data.profilePic160.uri;
    }

    const root = data.user || data.page;
    if (!root) continue;

    if (root.id && !pageId) pageId = root.id;
    if (root.name) pageName = root.name;
    if (root.is_verified) isVerified = true;

    // Profile picture
    const picUri =
      root.profile_picture?.uri ||
      root.profilePic160?.uri;
    if (picUri && !profilePicUrl) profilePicUrl = picUri;

    // Cover photo
    const coverUri = root.cover_photo?.photo?.image?.uri;
    if (coverUri && !coverPhotoUrl) coverPhotoUrl = coverUri;

    // From header renderer
    const headerUser = root.profile_header_renderer?.user;
    if (headerUser) {
      if (headerUser.id && !pageId) pageId = headerUser.id;
      if (headerUser.name) pageName = headerUser.name;
      if (headerUser.is_verified) isVerified = true;
      if (headerUser.profile_picture?.uri && !profilePicUrl) {
        profilePicUrl = headerUser.profile_picture.uri;
      }
      if (headerUser.cover_photo?.photo?.image?.uri && !coverPhotoUrl) {
        coverPhotoUrl = headerUser.cover_photo.photo.image.uri;
      }
    }
  }

  return { profilePicUrl, coverPhotoUrl, pageId, pageName, isVerified };
}

// ---------------------------------------------------------------------------
// Extract recent posts from the posts page
// ---------------------------------------------------------------------------

async function extractRecentPosts(context, count) {
  const postsPageUrl = `https://www.facebook.com/${username}/posts`;
  log(`Fetching recent posts from: ${postsPageUrl}`);

  const postsPage = await context.newPage();
  try {
    await postsPage.goto(postsPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await delay(4000);

    const relayEntries = await extractRelayData(postsPage);
    const posts = [];

    for (const entry of relayEntries) {
      if (posts.length >= count) break;
      const bbox = entry.bbox;
      if (!bbox?.result?.data) continue;
      const data = bbox.result.data;

      const feedUnits =
        data.user?.timeline_list_feed_units?.edges ||
        data.page?.timeline_list_feed_units?.edges ||
        [];

      for (const edge of feedUnits) {
        if (posts.length >= count) break;
        const node = edge?.node;
        if (!node) continue;
        const post = parseStoryNode(node, username);
        if (post) posts.push(post);
      }
    }

    return posts;
  } catch (e) {
    log(`Failed to fetch posts: ${e.message}`);
    return [];
  } finally {
    await postsPage.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching Facebook page info for: ${username}`);
  log(`Contact URL: ${contactInfoUrl}`);

  const browser = await createFbBrowser(Camoufox);

  try {
    const context = await createFbContext(browser);
    const isAuthed = await loadAuthCookies(context);

    const page = await context.newPage();

    // Navigate to contact info page (best for category, website, contact data)
    log("Navigating to contact info page...");
    let finalUrl = contactInfoUrl;
    try {
      const response = await page.goto(contactInfoUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      finalUrl = page.url();

      // Check for 404 or redirect to login
      if (
        finalUrl.includes("/login") ||
        finalUrl.includes("/checkpoint") ||
        response?.status() === 404
      ) {
        // Try main page instead
        log("Contact page failed, trying main page...");
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        finalUrl = page.url();
      }
    } catch (e) {
      log(`Navigation warning: ${e.message}`);
    }

    await delay(5000);
    finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    // Check page existence
    const pageTitle = await page.title();
    log(`Page title: ${pageTitle}`);

    if (
      pageTitle.includes("Page Not Found") ||
      pageTitle === "Facebook" ||
      pageTitle === ""
    ) {
      emitError("NOT_FOUND", `Facebook page not found: ${username}`);
    }

    // Extract Relay data (profile header, profile pic, cover photo)
    log("Extracting Relay data...");
    const relayEntries = await extractRelayData(page);
    log(`Found ${relayEntries.length} relay entries`);

    // Extract media and identity from relay
    const relayMedia = extractMediaFromRelay(relayEntries);

    // Extract header info (name, follower count) from DOM
    const headerInfo = await extractHeaderInfoDom(page);

    // Extract contact/category info from DOM
    const contactInfo = await extractContactInfoDom(page);

    // Optionally fetch bio from details page
    let bioData = null;
    if (includeBio) {
      log("Fetching about details page for bio...");
      try {
        const detailsPage = await context.newPage();
        await detailsPage.goto(detailsUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await delay(3000);
        bioData = await extractBioFromDetailsDom(detailsPage);
        await detailsPage.close();
      } catch (e) {
        log(`Bio fetch failed: ${e.message}`);
      }
    }

    // Build result
    const name =
      relayMedia.pageName ||
      headerInfo.name ||
      pageTitle.replace(/[\s|]+Facebook$/, "").replace(/\s*[-|]\s*$/, "").trim();

    const result = {
      username,
      id: relayMedia.pageId || null,
      name,
      categories: contactInfo.categories.length > 0 ? contactInfo.categories : null,
      category: contactInfo.categories[0] || null,
      followerCount: headerInfo.followerCount,
      followerText: headerInfo.followerText || null,
      likesText: headerInfo.likesText || null,
      website: contactInfo.website || null,
      email: contactInfo.email || null,
      phone: contactInfo.phone || null,
      address: contactInfo.address || null,
      instagram: contactInfo.instagram || null,
      twitter: contactInfo.twitter || null,
      linkedin: contactInfo.linkedin || null,
      youtube: contactInfo.youtube || null,
      tiktok: contactInfo.tiktok || null,
      socialLinks: contactInfo.socialLinks.length > 0 ? contactInfo.socialLinks : null,
      isVerified: relayMedia.isVerified,
      profilePicUrl: relayMedia.profilePicUrl || null,
      coverPhotoUrl: relayMedia.coverPhotoUrl || null,
      pageUrl: `https://www.facebook.com/${username}`,
      authenticated: isAuthed,
    };

    // Add bio if requested
    if (bioData) {
      result.bio = bioData.about || null;
      result.mission = bioData.mission || null;
      result.generalInfo = bioData.generalInfo || null;
    }

    log(`\nExtracted page info:`);
    log(`  Name: ${result.name}`);
    log(`  Category: ${result.category}`);
    log(`  Followers: ${result.followerText}`);
    log(`  Website: ${result.website}`);
    log(`  Email: ${result.email}`);
    log(`  Phone: ${result.phone}`);
    log(`  Verified: ${result.isVerified}`);
    log(`  Profile pic: ${result.profilePicUrl ? "✓" : "✗"}`);
    log(`  Cover photo: ${result.coverPhotoUrl ? "✓" : "✗"}`);

    // Optionally fetch posts
    if (includePosts) {
      log(`Fetching up to ${maxPosts} recent posts...`);
      result.posts = await extractRecentPosts(context, maxPosts);
      log(`Fetched ${result.posts.length} posts`);
    }

    emitResult(result);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
