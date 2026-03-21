#!/usr/bin/env node

/**
 * Google Maps Details Scraper
 *
 * Gets full details for a specific place by placeId or URL.
 * Uses camoufox-js for anti-detect browser automation.
 *
 * Usage:
 *   node google-maps-details.mjs <placeId|url>
 *
 * Examples:
 *   node google-maps-details.mjs "ChIJu38xAyhP0xQRjRIRycvj29M"
 *   node google-maps-details.mjs "https://www.google.com/maps/place/..."
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
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const input = process.argv[2];

if (!input) {
  emitError(
    "MISSING_ARG",
    "Usage: node google-maps-details.mjs <placeId|url>"
  );
}

// Determine if input is a URL or placeId
const isUrl = input.startsWith("http://") || input.startsWith("https://");
const targetUrl = isUrl
  ? (input.includes("hl=") ? input : input + (input.includes("?") ? "&hl=en" : "?hl=en"))
  : `https://www.google.com/maps/place/?q=place_id:${input}&hl=en`;

// ---------------------------------------------------------------------------
// Extract place details from the loaded page
// All selectors use stable attributes: aria-label, data-item-id, role, href
// ---------------------------------------------------------------------------

async function extractPlaceDetails(page) {
  log("Extracting place details from DOM...");

  return await page.evaluate(() => {
    const result = {};

    // ---------------------------------------------------------------------------
    // Name: from h1 (stable — Google uses h1 for place names)
    // ---------------------------------------------------------------------------
    const h1 = document.querySelector("h1");
    result.name = h1 ? h1.textContent.trim() : null;

    // ---------------------------------------------------------------------------
    // Rating: look for span[aria-label] with "stars" or "out of 5"
    // Google Maps uses aria-label like "4.9 stars" on the rating span
    // Stable: aria-label is accessibility-required and unlikely to change
    // ---------------------------------------------------------------------------
    result.rating = null;
    const allAriaSpans = Array.from(document.querySelectorAll("span[aria-label]"));
    for (const span of allAriaSpans) {
      const label = span.getAttribute("aria-label") || "";
      const m = label.match(/([0-9]+[.,][0-9])\s*stars?/i) ||
                label.match(/([0-9]+[.,][0-9])\s*out\s*of\s*5/i);
      if (m) {
        result.rating = parseFloat(m[1].replace(",", "."));
        break;
      }
    }
    // Also check role="img" elements with aria-label (Google uses these for star widgets)
    if (!result.rating) {
      const starImgs = Array.from(document.querySelectorAll('[role="img"][aria-label]'));
      for (const img of starImgs) {
        const label = img.getAttribute("aria-label") || "";
        const m = label.match(/([0-9]+[.,][0-9])\s*stars?/i);
        if (m) {
          result.rating = parseFloat(m[1].replace(",", "."));
          break;
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Review count: span with aria-label like "544 reviews" (stable)
    // ---------------------------------------------------------------------------
    const reviewSpan = document.querySelector('span[aria-label*=" reviews"]') ||
                       document.querySelector('span[aria-label*=" review"]');
    if (reviewSpan) {
      const label = reviewSpan.getAttribute("aria-label") || "";
      const m = label.match(/([0-9,]+)\s+reviews?/i);
      result.reviewCount = m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
    } else {
      result.reviewCount = null;
    }

    // ---------------------------------------------------------------------------
    // Category: appears directly after h1 in DOM, typically a button or
    // text element with the business type. Use structural + text heuristics.
    // Stable approach: find the element after h1 that has short category-like text,
    // or use button[jsaction*="category"] if present.
    // ---------------------------------------------------------------------------
    result.category = null;

    // Try jsaction-based button (Google Maps uses jsaction for event binding)
    const categoryByJsaction = document.querySelector(
      'button[jsaction*="category"], [jsaction*="category"] button'
    );
    if (categoryByJsaction) {
      result.category = categoryByJsaction.textContent.trim();
    }

    // Try: button near h1 that looks like a category (short, no digits, not a CTA)
    if (!result.category) {
      const h1El = document.querySelector("h1");
      if (h1El) {
        // Walk siblings and nearby elements after h1's parent
        let el = h1El.parentElement;
        while (el && !result.category) {
          el = el.nextElementSibling;
          if (!el) break;
          const candidates = Array.from(el.querySelectorAll("button, span, div"))
            .filter(e => e.children.length === 0);
          for (const c of candidates) {
            const t = c.textContent.trim();
            // Category: short (< 50 chars), no digits, typical business type words
            if (t.length > 2 && t.length < 50 && !/^\d/.test(t) &&
                !/accept|reject|claim|suggest|edit|add|share|save|directions|call|website/i.test(t) &&
                !/reviews?|photos?|about|menu|overview/i.test(t)) {
              result.category = t;
              break;
            }
          }
          if (el.children.length > 5) break; // Don't go too deep
        }
      }
    }

    // Fallback: look for any short standalone text near the rating that could be category
    if (!result.category) {
      const mainEl = document.querySelector('[role="main"]');
      if (mainEl) {
        // Find rating first, then look at nearby text
        const ratingEl = document.querySelector('span[aria-label*="stars"]') ||
                         document.querySelector('[role="img"][aria-label*="stars"]');
        if (ratingEl) {
          const parent = ratingEl.closest('[role="main"] > *') || ratingEl.parentElement;
          const allText = Array.from(parent ? parent.querySelectorAll('*') : [])
            .filter(e => e.children.length === 0)
            .map(e => e.textContent.trim())
            .filter(t => t.length > 2 && t.length < 50 && !/^\d/.test(t) &&
                !/accept|reject|write|reviews?|photos?|about|menu|overview|directions|call|website|save/i.test(t));
          if (allText.length > 0) {
            result.category = allText[0];
          }
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Address: data-item-id="address" button (very stable — data attribute)
    // ---------------------------------------------------------------------------
    const addressBtn = document.querySelector('button[data-item-id="address"]');
    if (addressBtn) {
      const label = addressBtn.getAttribute("aria-label") || addressBtn.textContent.trim();
      result.address = label.replace(/^Address:\s*/i, "").trim();
    } else {
      result.address = null;
    }

    // ---------------------------------------------------------------------------
    // Phone: data-item-id starts with "phone:" (stable — data attribute)
    // ---------------------------------------------------------------------------
    const phoneBtn = document.querySelector('button[data-item-id^="phone:"]');
    if (phoneBtn) {
      const label = phoneBtn.getAttribute("aria-label") || phoneBtn.textContent.trim();
      result.phone = label.replace(/^Phone:\s*/i, "").trim();
    } else {
      result.phone = null;
    }

    // ---------------------------------------------------------------------------
    // Website: data-item-id="authority" link (stable — data attribute)
    // ---------------------------------------------------------------------------
    const websiteLink = document.querySelector('a[data-item-id="authority"]');
    if (websiteLink) {
      result.website = websiteLink.href;
      result.websiteDisplay = websiteLink.textContent.trim();
    } else {
      result.website = null;
      result.websiteDisplay = null;
    }

    // ---------------------------------------------------------------------------
    // Hours: from buttons with aria-label containing "Copy open hours" (stable)
    // Format: "Monday, 8 am to 11 pm, Copy open hours"
    // ---------------------------------------------------------------------------
    const hoursBtns = Array.from(document.querySelectorAll('button[aria-label*="Copy open hours"]'));
    const hours = {};
    for (const btn of hoursBtns) {
      const label = btn.getAttribute("aria-label") || "";
      const m = label.match(/^([A-Za-z]+(?:\s+\([^)]+\))?),\s*(.+?),\s*(?:Hours might differ,\s*)?Copy open hours/);
      if (m) {
        const day = m[1].replace(/\s*\([^)]+\)/, "").trim();
        const time = m[2].trim();
        hours[day] = time;
      }
    }
    result.hours = Object.keys(hours).length > 0 ? hours : null;

    // ---------------------------------------------------------------------------
    // Open status: look for text like "Open ·", "Closed ·", "Opens at"
    // Use text content matching — stable regardless of class names
    // ---------------------------------------------------------------------------
    result.openStatus = null;
    
    // Find spans with open/closed status text pattern
    const allLeafSpans = Array.from(document.querySelectorAll("span"))
      .filter(s => s.children.length === 0);
    
    for (const span of allLeafSpans) {
      const text = span.textContent.trim();
      if (/^(Open|Closed|Opens|Closes)\b/i.test(text) && text.length < 100) {
        // Get the full status including "Open · Closes 9:30 pm"
        // by checking parent text
        const parent = span.parentElement;
        const parentText = parent ? parent.textContent.trim() : text;
        result.openStatus = parentText.length < 150 ? parentText : text;
        break;
      }
    }

    // ---------------------------------------------------------------------------
    // Coordinates: from URL data segments (very stable — part of URL structure)
    // ---------------------------------------------------------------------------
    const url = window.location.href;
    const atCoords = url.match(/@(-?[0-9]+\.[0-9]+),(-?[0-9]+\.[0-9]+)/);
    if (atCoords) {
      result.coordinates = { lat: parseFloat(atCoords[1]), lng: parseFloat(atCoords[2]) };
    } else {
      const latMatch = url.match(/!3d(-?[0-9]+\.[0-9]+)/);
      const lngMatch = url.match(/!4d(-?[0-9]+\.[0-9]+)/);
      result.coordinates = (latMatch && lngMatch)
        ? { lat: parseFloat(latMatch[1]), lng: parseFloat(lngMatch[1]) }
        : null;
    }

    // ---------------------------------------------------------------------------
    // Place ID: from URL structure (stable)
    // ---------------------------------------------------------------------------
    const placeMatch = url.match(/!1s(ChIJ[A-Za-z0-9_-]+)/);
    result.placeId = placeMatch ? placeMatch[1] : null;
    if (!result.placeId) {
      const paramMatch = url.match(/place_id[:=](ChIJ[A-Za-z0-9_-]+)/);
      result.placeId = paramMatch ? paramMatch[1] : null;
    }

    result.url = url;

    return result;
  });
}

// ---------------------------------------------------------------------------
// Extract reviews from the reviews tab
// Uses data-review-id (stable data attribute) for container identification
// Uses aria-label for rating, structural position + text patterns for other fields
// ---------------------------------------------------------------------------

async function extractReviews(page, maxReviews = 10) {
  log(`Extracting up to ${maxReviews} reviews...`);

  try {
    // Click the Reviews tab
    const reviewsTab = page.locator('button[aria-label*="Reviews for"]').first();
    if (await reviewsTab.isVisible({ timeout: 3000 })) {
      log("Clicking Reviews tab...");
      await reviewsTab.click();
      await delay(2000);
    }

    // Scroll to load reviews
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const main = document.querySelector('[role="main"]');
        if (main) main.scrollBy(0, 2000);
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollBy(0, 2000);
      });
      await delay(1000);
    }

    const reviews = await page.evaluate((max) => {
      // Top-level review cards: div.jftiEf with data-review-id
      // jftiEf is a class that Google has used consistently; combined with data-review-id
      // it's reliable. If jftiEf ever changes, fall back to any [data-review-id] that 
      // is not a child of another [data-review-id].
      let reviewEls = Array.from(document.querySelectorAll('div.jftiEf[data-review-id]'));
      if (reviewEls.length === 0) {
        // Fallback: top-level data-review-id elements (not nested)
        reviewEls = Array.from(document.querySelectorAll('[data-review-id]')).filter(
          el => !el.parentElement || !el.parentElement.closest('[data-review-id]')
        );
      }
      reviewEls = reviewEls.slice(0, max);

      return reviewEls.map((el) => {
        // ---------------------------------------------------------------------------
        // Author: "Photo of <name>" button (stable pattern — aria-label for photos
        // consistently references the reviewer's name)
        // ---------------------------------------------------------------------------
        let author = null;
        
        const photoBtn = Array.from(el.querySelectorAll('button[aria-label]')).find(
          b => b.getAttribute('aria-label').startsWith('Photo of ')
        );
        if (photoBtn) {
          author = photoBtn.getAttribute('aria-label').replace(/^Photo of\s+/i, '').trim();
        }
        
        // Fallback: "Actions for <name>'s review" button
        if (!author) {
          const actionsBtn = Array.from(el.querySelectorAll('button[aria-label]')).find(
            b => b.getAttribute('aria-label').includes("'s review") || 
                 b.getAttribute('aria-label').startsWith('Actions for ')
          );
          if (actionsBtn) {
            const label = actionsBtn.getAttribute('aria-label');
            const m = label.match(/Actions for (.+?)'s review/i);
            if (m) author = m[1].trim();
          }
        }
        
        // Last fallback: first short non-metadata leaf text
        if (!author) {
          const allLeaf = Array.from(el.querySelectorAll('span, div')).filter(e => e.children.length === 0);
          for (const e of allLeaf) {
            const t = e.textContent.trim();
            if (t.length >= 2 && t.length <= 50 &&
                !t.match(/^\d/) &&
                !t.match(/(review|photo|star|ago|Local Guide|Like|Share|Closed)/i) &&
                t.split(' ').length <= 5) {
              author = t;
              break;
            }
          }
        }

        // ---------------------------------------------------------------------------
        // Rating: span[aria-label*="stars"] (stable accessibility attribute)
        // ---------------------------------------------------------------------------
        let rating = null;
        const starSpan = el.querySelector('span[aria-label*="star"]');
        if (starSpan) {
          const label = starSpan.getAttribute('aria-label') || '';
          const m = label.match(/([0-9]+(?:[.,][0-9]+)?)\s*stars?/i);
          if (m) rating = parseFloat(m[1].replace(',', '.'));
        }

        // ---------------------------------------------------------------------------
        // All leaf text content for parsing (spans and divs both)
        // ---------------------------------------------------------------------------
        const allSpanTexts = Array.from(el.querySelectorAll('span, div'))
          .filter(s => s.children.length === 0)
          .map(s => s.textContent.trim())
          .filter(t => t.length > 0);

        // ---------------------------------------------------------------------------
        // Time: text matching temporal patterns (stable, language-independent for English)
        // ---------------------------------------------------------------------------
        let time = null;
        for (const t of allSpanTexts) {
          if (t.match(/^\d+\s+(year|month|week|day)s?\s+ago$/i) ||
              t.match(/^a\s+(year|month|week|day)\s+ago$/i) ||
              t.match(/^(yesterday|today)$/i) ||
              t.match(/^Edited\s+/i)) {
            time = t;
            break;
          }
        }

        // ---------------------------------------------------------------------------
        // Reviewer stats: text with "reviews", "photos", or "Local Guide"
        // Pattern: "8 reviews · 10 photos" or "Local Guide · 185 reviews · 656 photos"
        // ---------------------------------------------------------------------------
        let reviewerCount = null;
        for (const t of allSpanTexts) {
          if ((t.match(/\d+\s+review/i) || t.match(/Local Guide/i)) && t.length < 100) {
            reviewerCount = t;
            break;
          }
        }

        // ---------------------------------------------------------------------------
        // Review text: the longest text in the card that isn't metadata
        // Exclude: author name, time patterns, reviewer stats, UI button texts
        // ---------------------------------------------------------------------------
        let text = null;
        const excludePatterns = [
          /^\d+\s+(year|month|week|day)s?\s+ago$/i,
          /^a\s+(year|month|week|day)\s+ago$/i,
          /^Edited\s+/i,
          /^\d+\s+reviews?/i,
          /^Local Guide/i,
          /^(Like|Share|Report|Flag)$/i,
          /^\d+$/, // just a number (like count)
          /^Response from the owner/i,
        ];
        
        const textCandidates = allSpanTexts.filter(t =>
          t.length > 15 &&
          t !== author &&
          !excludePatterns.some(p => p.test(t))
        );
        
        if (textCandidates.length > 0) {
          // Pick the longest candidate (most likely to be actual review text)
          text = textCandidates.reduce((a, b) => a.length > b.length ? a : b, '');
        }

        return {
          author: author || null,
          rating,
          text: text || null,
          time: time || null,
          reviewerCount: reviewerCount || null,
        };
      }).filter((r) => r.author || r.text);
    }, maxReviews);

    return reviews;
  } catch (err) {
    log(`Error extracting reviews: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Extract photos
// Uses googleusercontent URL pattern (stable) + aria-label on buttons
// ---------------------------------------------------------------------------

async function extractPhotos(page, maxPhotos = 10) {
  log(`Extracting up to ${maxPhotos} photos...`);

  try {
    const photos = await page.evaluate((max) => {
      // Look for photo buttons with img elements — aria-label "Photo of" is stable
      // Also catch any googleusercontent.com images with dimension params
      const imgs = Array.from(document.querySelectorAll(
        'button[aria-label*="Photo"] img, img[src*="googleusercontent"]'
      )).filter((img) => {
        const src = img.src || "";
        return src.includes("googleusercontent") && (src.includes("=w") || src.includes("-h"));
      }).slice(0, max);

      return imgs.map((img) => img.src);
    }, maxPhotos);

    return [...new Set(photos)]; // deduplicate
  } catch (err) {
    log(`Error extracting photos: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching Google Maps details for: ${input}`);
  log(`Target URL: ${targetUrl}`);

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

    // Navigate
    log("Navigating to Google Maps...");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Handle cookie consent
    await delay(2000);
    try {
      const consentBtn = page
        .locator('button[aria-label*="Accept all"], form[action*="consent"] button')
        .first();
      if (await consentBtn.isVisible({ timeout: 3000 })) {
        log("Dismissing cookie consent...");
        await consentBtn.click();
        await delay(1500);
      }
    } catch {
      // No consent dialog
    }

    // Wait for place details to load (h1 element appears)
    log("Waiting for place details to load...");
    let loaded = false;
    for (let i = 0; i < 20; i++) {
      const h1Count = await page.locator("h1").count();
      if (h1Count > 0) {
        const h1Text = await page.locator("h1").first().textContent();
        if (h1Text && h1Text.trim() && h1Text !== "Google Maps") {
          log(`Place loaded: "${h1Text.trim()}"`);
          loaded = true;
          break;
        }
      }
      await delay(1000);
    }

    if (!loaded) {
      const title = await page.title();
      log(`Page title: ${title}`);
      emitError("PLACE_NOT_LOADED", "Could not find place details (h1 not found)");
    }

    // Wait for URL to stabilize (may redirect from place_id:... to canonical URL)
    await delay(2000);
    for (let i = 0; i < 10; i++) {
      const url = page.url();
      if (url.includes("@") || url.includes("!3d")) {
        log(`URL has coordinates: ${url.substring(0, 80)}...`);
        break;
      }
      await delay(500);
    }

    // Extract details (while on overview tab, before switching to reviews)
    const details = await extractPlaceDetails(page);

    // Extract photos (from overview page, before switching to reviews tab)
    const photos = await extractPhotos(page, 10);

    // Extract reviews (switches to reviews tab)
    const reviews = await extractReviews(page, 10);

    // Resolve placeId: from details URL, or fall back to input if it was a ChIJ ID
    let placeId = details.placeId;
    if (!placeId && !isUrl && input.startsWith("ChIJ")) {
      placeId = input;
    }

    const result = {
      name: details.name,
      address: details.address,
      phone: details.phone,
      website: details.website,
      rating: details.rating,
      reviewCount: details.reviewCount,
      category: details.category,
      hours: details.hours,
      openStatus: details.openStatus,
      coordinates: details.coordinates,
      placeId,
      url: details.url,
      photos,
      reviews,
    };

    log(`\nExtracted details for: ${result.name || "unknown"}`);
    log(`  Address: ${result.address}`);
    log(`  Phone: ${result.phone}`);
    log(`  Website: ${result.website}`);
    log(`  Rating: ${result.rating} (${result.reviewCount} reviews)`);
    log(`  Hours: ${result.hours ? Object.keys(result.hours).length + " days" : "not found"}`);
    log(`  Reviews: ${reviews.length}`);
    log(`  Photos: ${photos.length}`);

    emitResult(result);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
