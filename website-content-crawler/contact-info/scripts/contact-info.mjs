#!/usr/bin/env node

/**
 * Website Contact Info Scraper
 *
 * Extracts contact information from any website:
 * - Email addresses
 * - Phone numbers
 * - Physical address
 * - Social media links (Instagram, Twitter/X, Facebook, LinkedIn, TikTok, YouTube, etc.)
 * - WhatsApp links
 * - Contact form URL
 * - Website metadata (name, description)
 *
 * Strategy:
 *   1. Navigate to URL with camoufox (fingerprinted Firefox)
 *   2. Also try /contact, /about, /contact-us if main page doesn't have data
 *   3. Extract from DOM:
 *      a) Link hrefs: mailto:, tel:, social domains
 *      b) Text patterns: email regex, phone regex
 *      c) Schema.org JSON-LD structured data (best quality)
 *      d) Open Graph / meta tags for company name/description
 *   4. Deduplicate and normalize all extracted data
 *
 * Usage:
 *   node contact-info.mjs <url> [--contact-pages] [--depth <1|2|3>]
 *
 * Options:
 *   --contact-pages    Also try /contact, /about, /contact-us pages (default: true)
 *   --no-contact-pages Skip extra page attempts
 *   --depth <N>        How many pages to crawl for contact info (default: 2)
 *
 * Examples:
 *   node contact-info.mjs https://example.com
 *   node contact-info.mjs https://startup.io --depth 3
 *   node contact-info.mjs https://bigcorp.com --no-contact-pages
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   {
 *     url, name, description,
 *     emails: ["info@example.com"],
 *     phones: ["+1-555-123-4567"],
 *     address: null,
 *     social: {
 *       instagram, twitter, facebook, linkedin,
 *       tiktok, youtube, pinterest, snapchat, discord,
 *       github, crunchbase, whatsapp
 *     },
 *     contactFormUrl,
 *     pagesChecked
 *   }
 */

import { Camoufox } from "camoufox-js";
import { emitResult, emitError, log, delay, normalizeUrl } from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let targetUrl = null;
let tryContactPages = true;
let maxDepth = 2;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--no-contact-pages") {
    tryContactPages = false;
  } else if (args[i] === "--contact-pages") {
    tryContactPages = true;
  } else if (args[i] === "--depth" && args[i + 1]) {
    maxDepth = parseInt(args[++i], 10);
  } else if (!targetUrl) {
    targetUrl = args[i];
  }
}

if (!targetUrl) {
  emitError("MISSING_ARG", "Usage: contact-info.mjs <url> [--contact-pages] [--depth N]");
}

// Normalize URL
if (!targetUrl.startsWith("http")) {
  targetUrl = "https://" + targetUrl;
}

let parsedUrl;
try {
  parsedUrl = new URL(targetUrl);
} catch {
  emitError("INVALID_URL", `Invalid URL: ${targetUrl}`);
}

const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;

// ---------------------------------------------------------------------------
// Contact page URL candidates
// ---------------------------------------------------------------------------

const CONTACT_PAGE_PATHS = [
  "/contact",
  "/contact-us",
  "/contactus",
  "/about",
  "/about-us",
  "/about/contact",
  "/get-in-touch",
  "/reach-us",
  "/support",
  "/help",
];

// ---------------------------------------------------------------------------
// Social media domain patterns
// ---------------------------------------------------------------------------

const SOCIAL_DOMAINS = {
  instagram: ["instagram.com"],
  twitter: ["twitter.com", "x.com"],
  facebook: ["facebook.com", "fb.com"],
  linkedin: ["linkedin.com"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
  pinterest: ["pinterest.com"],
  snapchat: ["snapchat.com"],
  discord: ["discord.gg", "discord.com"],
  github: ["github.com"],
  crunchbase: ["crunchbase.com"],
  twitch: ["twitch.tv"],
  telegram: ["t.me", "telegram.me", "telegram.org"],
};

// ---------------------------------------------------------------------------
// Extract contact data from a page
// ---------------------------------------------------------------------------

async function extractContactFromPage(page, url) {
  const data = await page.evaluate((url) => {
    const result = {
      emails: new Set(),
      phones: new Set(),
      socialLinks: {},
      contactFormUrl: null,
      address: null,
      name: null,
      description: null,
      schemaData: null,
    };

    const domainToSocial = {
      "instagram.com": "instagram",
      "twitter.com": "twitter",
      "x.com": "twitter",
      "facebook.com": "facebook",
      "fb.com": "facebook",
      "linkedin.com": "linkedin",
      "tiktok.com": "tiktok",
      "youtube.com": "youtube",
      "youtu.be": "youtube",
      "pinterest.com": "pinterest",
      "snapchat.com": "snapchat",
      "discord.gg": "discord",
      "discord.com": "discord",
      "github.com": "github",
      "crunchbase.com": "crunchbase",
      "twitch.tv": "twitch",
      "t.me": "telegram",
      "telegram.me": "telegram",
      "wa.me": "whatsapp",
      "api.whatsapp.com": "whatsapp",
    };

    // 1. Scan all links
    const links = Array.from(document.querySelectorAll("a[href]"));
    for (const link of links) {
      const href = link.href || "";
      const text = link.innerText?.trim() || "";

      // mailto: links
      if (href.startsWith("mailto:")) {
        const email = href.replace(/^mailto:/, "").split("?")[0].trim().toLowerCase();
        if (email && email.includes("@") && email.includes(".")) {
          result.emails.add(email);
        }
      }

      // tel: links
      if (href.startsWith("tel:")) {
        const phone = href.replace(/^tel:/, "").replace(/%20/g, " ").trim();
        if (phone.length >= 7) {
          result.phones.add(phone);
        }
      }

      // Social media links
      try {
        const linkUrl = new URL(href);
        const hostname = linkUrl.hostname.replace(/^www\./, "");
        if (domainToSocial[hostname]) {
          const platform = domainToSocial[hostname];
          // Only use the first/canonical link per platform (not follow/share buttons)
          if (!result.socialLinks[platform]) {
            // Skip generic domain links like "facebook.com" without a page/profile path
            const path = linkUrl.pathname;
            if (path && path !== "/" && path.length > 1) {
              // Skip if the link is to the same site we're scraping (self-reference)
              // e.g., github.com scraping github.com/events/...
              const currentHostname = new URL(url).hostname.replace(/^www\./, "");
              const socialHostname = hostname.split(".").slice(-2).join(".");
              const currentRoot = currentHostname.split(".").slice(-2).join(".");
              if (socialHostname !== currentRoot) {
                // Prefer canonical profile/company page links — skip event/tracking links
                const looksLikeProfile =
                  path.split("/").filter(Boolean).length <= 2 || // at most 2 path segments (e.g. /company/name, /@handle)
                  path.includes("/company/") ||
                  path.includes("/@") ||
                  path.includes("/channel/") ||
                  path.includes("/user/");
                if (looksLikeProfile || Object.keys(result.socialLinks).length < 3) {
                  result.socialLinks[platform] = href;
                }
              }
            }
          }
        }
      } catch {}

      // WhatsApp chat links
      if (href.includes("wa.me/") || href.includes("api.whatsapp.com/send")) {
        if (!result.socialLinks.whatsapp) {
          result.socialLinks.whatsapp = href;
        }
      }

      // Contact form detection
      if (
        !result.contactFormUrl &&
        (href.includes("/contact") || href.includes("/reach-us") || href.includes("/get-in-touch")) &&
        !href.includes("mailto:")
      ) {
        result.contactFormUrl = href;
      }
    }

    // 2. Text-based email extraction (for emails not in mailto: links)
    const bodyText = document.body.innerText || "";
    const emailRegex = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
    let emailMatch;
    while ((emailMatch = emailRegex.exec(bodyText)) !== null) {
      const email = emailMatch[0].toLowerCase();
      // Skip image filenames and tracking pixels
      if (!email.includes(".png") && !email.includes(".jpg") && !email.includes(".gif")) {
        result.emails.add(email);
      }
    }

    // 3. Text-based phone extraction
    // International phone patterns
    const phonePatterns = [
      /\+\d{1,3}[\s\-\.]?\(?\d{1,4}\)?[\s\-\.]?\d{1,4}[\s\-\.]?\d{1,9}/g,
      /\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4}/g, // US format: (555) 123-4567
      /\d{2,4}[\s\-]\d{3,4}[\s\-]\d{3,4}(?:[\s\-]\d{2,4})?/g, // European formats
    ];

    const foundPhones = new Set();
    for (const pattern of phonePatterns) {
      let match;
      while ((match = pattern.exec(bodyText)) !== null) {
        const raw = match[0].trim();
        // Filter: must have at least 7 digits total
        const digitCount = (raw.match(/\d/g) || []).length;
        if (digitCount >= 7 && digitCount <= 15) {
          foundPhones.add(raw);
        }
      }
    }
    for (const phone of foundPhones) {
      result.phones.add(phone);
    }

    // 4. Schema.org JSON-LD extraction
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
      try {
        const jsonData = JSON.parse(script.textContent || "{}");
        const schema = Array.isArray(jsonData) ? jsonData[0] : jsonData;

        if (schema["@type"] === "Organization" || schema["@type"] === "LocalBusiness" || 
            schema["@type"] === "Corporation" || schema["@type"] === "WebSite") {
          
          if (schema.name) result.name = schema.name;
          if (schema.description) result.description = schema.description;

          // Email from schema
          if (schema.email) result.emails.add(schema.email.toLowerCase());

          // Phone from schema
          if (schema.telephone) result.phones.add(schema.telephone);

          // Address from schema
          if (schema.address) {
            const addr = schema.address;
            const parts = [
              addr.streetAddress,
              addr.addressLocality,
              addr.addressRegion,
              addr.postalCode,
              addr.addressCountry,
            ].filter(Boolean);
            if (parts.length > 0) result.address = parts.join(", ");
          }

          // Social links from sameAs
          const sameAs = Array.isArray(schema.sameAs) ? schema.sameAs : [schema.sameAs].filter(Boolean);
          for (const link of sameAs) {
            try {
              const sameAsUrl = new URL(link);
              const hostname = sameAsUrl.hostname.replace(/^www\./, "");
              if (domainToSocial[hostname]) {
                const platform = domainToSocial[hostname];
                if (!result.socialLinks[platform]) {
                  result.socialLinks[platform] = link;
                }
              }
            } catch {}
          }

          // Contact point
          if (schema.contactPoint) {
            const cp = Array.isArray(schema.contactPoint) ? schema.contactPoint : [schema.contactPoint];
            for (const contact of cp) {
              if (contact.telephone) result.phones.add(contact.telephone);
              if (contact.email) result.emails.add(contact.email.toLowerCase());
            }
          }
        }
      } catch {}
    }

    // 5. Meta tags
    const metaName = document.querySelector('meta[property="og:site_name"]')?.content ||
      document.querySelector('meta[name="application-name"]')?.content ||
      document.title?.replace(/\s*[\||\-]\s*.+$/, "").trim() || null;
    if (metaName && !result.name) result.name = metaName;

    const metaDesc = document.querySelector('meta[property="og:description"]')?.content ||
      document.querySelector('meta[name="description"]')?.content || null;
    if (metaDesc && !result.description) result.description = metaDesc;

    // Convert Sets to arrays for serialization
    return {
      emails: Array.from(result.emails),
      phones: Array.from(result.phones),
      socialLinks: result.socialLinks,
      contactFormUrl: result.contactFormUrl,
      address: result.address,
      name: result.name,
      description: result.description,
    };
  }, url);

  return data;
}

// ---------------------------------------------------------------------------
// Merge contact data from multiple pages
// ---------------------------------------------------------------------------

function mergeContactData(base, addition) {
  // Merge emails
  const emailSet = new Set([...base.emails, ...addition.emails]);
  base.emails = Array.from(emailSet).slice(0, 10);

  // Merge phones (deduplicate by normalizing digits)
  const allPhones = [...base.phones, ...addition.phones];
  const phoneMap = new Map();
  for (const p of allPhones) {
    const digits = p.replace(/\D/g, "");
    if (!phoneMap.has(digits) && digits.length >= 7) {
      phoneMap.set(digits, p);
    }
  }
  base.phones = Array.from(phoneMap.values()).slice(0, 10);

  // Merge social links (keep first found per platform)
  for (const [platform, url] of Object.entries(addition.socialLinks)) {
    if (!base.socialLinks[platform] && url) {
      base.socialLinks[platform] = url;
    }
  }

  // Keep first found contact form
  if (!base.contactFormUrl && addition.contactFormUrl) {
    base.contactFormUrl = addition.contactFormUrl;
  }

  // Address (prefer the one that looks fuller)
  if (!base.address && addition.address) {
    base.address = addition.address;
  }

  // Name and description
  if (!base.name && addition.name) base.name = addition.name;
  if (!base.description && addition.description) base.description = addition.description;

  return base;
}

// ---------------------------------------------------------------------------
// Filter out low-quality emails
// ---------------------------------------------------------------------------

function filterEmails(emails) {
  const EXCLUDE_PATTERNS = [
    /^example@/,
    /^test@/,
    /^noreply@/,
    /^no-reply@/,
    /^donotreply@/,
    /sentry.io/,
    /wixpress.com/,
    /shopify.com$/,
    /wordpress.com$/,
  ];

  return emails.filter((email) => {
    if (!email.includes("@") || !email.includes(".")) return false;
    if (EXCLUDE_PATTERNS.some((p) => p.test(email))) return false;
    // Must have valid TLD
    const parts = email.split(".");
    const tld = parts[parts.length - 1];
    return tld.length >= 2 && tld.length <= 10;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching contact info from: ${targetUrl}`);

  const browser = await Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    const page = await context.newPage();

    const pagesChecked = [];

    // Start with the target URL
    log(`Navigating to: ${targetUrl}`);
    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await delay(3000);
    } catch (e) {
      log(`Navigation warning for ${targetUrl}: ${e.message}`);
    }

    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    // Check if navigation failed
    if (!finalUrl || finalUrl === "about:blank") {
      emitError("LOAD_FAILED", `Failed to load URL: ${targetUrl}. Site may be unreachable.`);
    }

    pagesChecked.push(finalUrl);

    const title = await page.title().catch(() => "");
    log(`Title: ${title}`);

    // Extract from main page
    let contactData = await extractContactFromPage(page, finalUrl);
    log(`Main page: emails=${contactData.emails.length}, phones=${contactData.phones.length}, social=${Object.keys(contactData.socialLinks).length}`);

    // Discover contact page links from main page
    const discoveredContactUrls = await page.evaluate((base) => {
      const links = Array.from(document.querySelectorAll("a[href]"));
      const contactPaths = ["/contact", "/about", "/contact-us", "/get-in-touch", "/reach-us"];
      const found = [];
      for (const link of links) {
        const href = link.href || "";
        const text = (link.innerText || link.title || "").toLowerCase();
        const isContactUrl = contactPaths.some(
          (path) => href.toLowerCase().includes(path)
        );
        const isContactText = ["contact", "reach us", "get in touch", "about"].some(
          (phrase) => text.includes(phrase)
        );
        if ((isContactUrl || isContactText) && !found.includes(href)) {
          // Only same-domain links
          try {
            const u = new URL(href);
            if (u.hostname === new URL(base).hostname) {
              found.push(href);
            }
          } catch {}
        }
      }
      return found.slice(0, 5);
    }, finalUrl);

    log(`Discovered contact pages: ${discoveredContactUrls.join(", ") || "none"}`);

    // Check contact pages if enabled
    if (tryContactPages && maxDepth > 1) {
      // Build list of pages to check:
      // 1. Discovered from links
      // 2. Common path candidates (up to maxDepth total)
      const pagesToTry = new Set([...discoveredContactUrls]);

      // Add path candidates that we haven't tried
      const attemptedPaths = new Set([new URL(finalUrl).pathname.toLowerCase()]);
      for (const path of CONTACT_PAGE_PATHS) {
        if (pagesToTry.size + 1 >= maxDepth) break;
        const url = baseUrl + path;
        const pathKey = path.toLowerCase();
        if (!attemptedPaths.has(pathKey)) {
          pagesToTry.add(url);
          attemptedPaths.add(pathKey);
        }
      }

      let checkedCount = 1; // main page already done
      for (const extraUrl of pagesToTry) {
        if (checkedCount >= maxDepth) break;
        if (pagesChecked.includes(extraUrl)) continue;

        log(`Checking contact page: ${extraUrl}`);
        try {
          const extraPage = await context.newPage();
          await extraPage.goto(extraUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await delay(2000);

          const extraFinalUrl = extraPage.url();
          // Skip if redirected to a different domain
          try {
            if (new URL(extraFinalUrl).hostname !== parsedUrl.hostname) {
              await extraPage.close();
              continue;
            }
          } catch {}

          pagesChecked.push(extraFinalUrl);

          const extraData = await extractContactFromPage(extraPage, extraFinalUrl);
          log(`  → emails=${extraData.emails.length}, phones=${extraData.phones.length}, social=${Object.keys(extraData.socialLinks).length}`);

          contactData = mergeContactData(contactData, extraData);
          await extraPage.close();
          checkedCount++;

          // If we have good data, stop early
          if (
            contactData.emails.length > 0 &&
            Object.keys(contactData.socialLinks).length >= 2
          ) {
            log("Found sufficient contact data — stopping early");
            break;
          }
        } catch (e) {
          log(`  Failed to load ${extraUrl}: ${e.message}`);
        }
      }
    }

    // Post-processing
    contactData.emails = filterEmails(contactData.emails);

    // Build final result
    const result = {
      url: finalUrl,
      name: contactData.name || parsedUrl.hostname.replace(/^www\./, ""),
      description: contactData.description || null,
      emails: contactData.emails,
      phones: contactData.phones,
      address: contactData.address || null,
      social: contactData.socialLinks,
      contactFormUrl: contactData.contactFormUrl || null,
      pagesChecked,
    };

    log(`\nFinal result:`);
    log(`  Name: ${result.name}`);
    log(`  Emails: ${result.emails.join(", ") || "none"}`);
    log(`  Phones: ${result.phones.join(", ") || "none"}`);
    log(`  Social: ${Object.keys(result.social).join(", ") || "none"}`);
    log(`  Pages checked: ${pagesChecked.length}`);

    emitResult(result);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
