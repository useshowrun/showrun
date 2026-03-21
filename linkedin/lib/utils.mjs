/**
 * Shared utilities for LinkedIn scrapers.
 *
 * Strategy overview:
 *   LinkedIn public pages are accessible without login for:
 *   - Person profiles: /in/<username>
 *   - Company pages: /company/<slug>
 *   - Job search: /jobs/search/?keywords=...&location=...
 *   - Job detail: /jobs/view/<id>
 *
 *   Data extraction strategies (in priority order):
 *   1. Meta tags (og:*, profile:*, description) — most reliable
 *   2. JSON-LD embedded in <script type="application/ld+json"> — structured data
 *   3. Semantic DOM: h1, h2, h3, h4 with their containing sections
 *   4. data-entity-urn attributes for stable entity identification
 *   5. Named CSS classes that have been stable (base-search-card__title, etc.)
 *
 *   NOTE: LinkedIn shows a limited subset of data to logged-out users.
 *   Full profile sections, connections, recommendations, skills, endorsements
 *   all require authentication. For full access, set LI_COOKIES env var.
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
// Browser setup
// ---------------------------------------------------------------------------

/**
 * Create a camoufox browser configured for LinkedIn scraping.
 * Uses US/English locale for consistent results.
 */
export async function createLinkedInBrowser(Camoufox) {
  return Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });
}

/**
 * Create a browser context with US/English locale.
 */
export async function createLinkedInContext(browser) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Load LinkedIn cookies if provided via env var
  const cookiesJson = process.env.LI_COOKIES;
  if (cookiesJson) {
    try {
      const cookies = JSON.parse(cookiesJson);
      await context.addCookies(cookies);
      log("[auth] Loaded LinkedIn cookies from LI_COOKIES env var");
    } catch (e) {
      log("[auth] Warning: LI_COOKIES is invalid JSON:", e.message);
    }
  }

  return context;
}

// ---------------------------------------------------------------------------
// Meta tag extraction
// ---------------------------------------------------------------------------

/**
 * Extract all meta tags from the page into a key/value object.
 */
export function extractMetas(document) {
  const metas = {};
  document.querySelectorAll("meta").forEach((m) => {
    const key = m.getAttribute("property") || m.getAttribute("name");
    if (key) metas[key] = m.getAttribute("content");
  });
  return metas;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Normalize whitespace in a string.
 */
export function normalizeText(str) {
  if (!str) return null;
  return str.replace(/\s+/g, " ").trim() || null;
}

/**
 * Parse a LinkedIn follower/employee count string like "27,841,406 followers"
 * or "10,001+ employees" into a number.
 */
export function parseCount(str) {
  if (!str) return null;
  const cleaned = str.replace(/,/g, "").replace(/\+/, "").replace(/[^0-9]/g, "");
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? null : n;
}

/**
 * Parse a date range string like "2000 - Present\n            26 years"
 * into { startDate, endDate, duration }.
 */
export function parseDateRange(str) {
  if (!str) return { startDate: null, endDate: null, duration: null };
  const lines = str
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const range = lines[0] || "";
  const duration = lines[1] || null;
  const parts = range.split(" - ").map((p) => p.trim());
  return {
    startDate: parts[0] || null,
    endDate: parts[1] || null,
    duration: duration,
  };
}

/**
 * Find a section by its h2 heading text.
 * Returns the containing <section> element or null.
 */
export function findSectionByH2(document, headingText) {
  const h2s = Array.from(document.querySelectorAll("h2"));
  const h2 = h2s.find((h) => h.textContent?.trim() === headingText);
  if (!h2) return null;
  return h2.closest("section") || h2.parentElement?.parentElement || null;
}

// ---------------------------------------------------------------------------
// Profile data extraction
// ---------------------------------------------------------------------------

/**
 * Extract a person's profile data from the current page.
 * Works on /in/<username> pages.
 */
export async function extractPersonProfile(page) {
  return page.evaluate(() => {
    // ---- Helpers ----
    function normalizeText(str) {
      if (!str) return null;
      return str.replace(/\s+/g, " ").trim() || null;
    }

    function parseDateRange(str) {
      if (!str) return { startDate: null, endDate: null, duration: null };
      const lines = str
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const range = lines[0] || "";
      const duration = lines[1] || null;
      const parts = range.split(" - ").map((p) => p.trim());
      return {
        startDate: parts[0] || null,
        endDate: parts[1] || null,
        duration: duration,
      };
    }

    function findSectionByH2(headingText) {
      const h2s = Array.from(document.querySelectorAll("h2"));
      const h2 = h2s.find((h) => h.textContent?.trim() === headingText);
      if (!h2) return null;
      return h2.closest("section") || h2.parentElement?.parentElement || null;
    }

    // ---- Meta tags ----
    const metas = {};
    document.querySelectorAll("meta").forEach((m) => {
      const key = m.getAttribute("property") || m.getAttribute("name");
      if (key) metas[key] = m.getAttribute("content");
    });

    // ---- JSON-LD ----
    let jsonLd = null;
    const jsonLdScripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const script of jsonLdScripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data["@graph"]) {
          jsonLd = data["@graph"];
        } else if (data["@type"] === "Person") {
          jsonLd = [data];
        }
      } catch (_) {}
    }

    // ---- Basic profile info ----
    // Name: h1 always has the person name on LinkedIn public profiles
    const name = normalizeText(document.querySelector("h1")?.textContent);

    // Headline: h2 that doesn't contain auth/nav words
    const h2s = Array.from(document.querySelectorAll("h2"));
    const SKIP_H2 = [
      "Sign in",
      "LinkedIn",
      "View",
      "About",
      "Activity",
      "Experience",
      "Education",
      "More",
      "Other",
      "Explore",
      "Articles",
      "respects",
    ];
    const headlineH2 = h2s.find(
      (h) =>
        h.textContent &&
        !SKIP_H2.some((skip) => h.textContent.includes(skip))
    );
    const headline = normalizeText(headlineH2?.textContent);

    // Location: .profile-info-subheader contains location + "Contact Info" link
    const locationEl = document.querySelector(".profile-info-subheader");
    let location = null;
    if (locationEl) {
      // Get first non-empty text node
      for (const node of locationEl.childNodes) {
        const text = node.textContent?.trim();
        if (text && text !== "Contact Info") {
          location = text;
          break;
        }
      }
      // Fallback: just get the first line
      if (!location) {
        const locText = locationEl.textContent?.split("\n")[0]?.trim();
        if (locText && locText !== "Contact Info") location = locText;
      }
    }

    // Profile image
    const profileImage =
      document.querySelector("img.top-card-layout__entity-image")?.src ||
      document.querySelector('img[alt*="Photo"]')?.src ||
      metas["og:image"] ||
      null;

    // Connections count (if visible)
    const connectionText = document.querySelector(
      '[class*="connections"], [class*="connection-count"]'
    )?.textContent?.trim();

    // ---- About section ----
    const aboutSection = findSectionByH2("About");
    let about = null;
    if (aboutSection) {
      // Get the p or content div within the section
      const contentEl =
        aboutSection.querySelector(".core-section-container__content") ||
        aboutSection.querySelector("p");
      if (contentEl) {
        about = normalizeText(contentEl.textContent);
      } else {
        // Strip "About" heading and get remaining text
        const fullText = aboutSection.textContent?.trim() || "";
        about = normalizeText(fullText.replace(/^About\s*/i, ""));
      }
    }
    // Fallback: use OG description (contains headline + about + experience summary)
    if (!about && metas["og:description"]) {
      // The OG description contains: "Headline · About · Experience · Education · Location"
      // Extract the "About" part (second segment after headline)
      const parts = metas["og:description"].split(" · ");
      if (parts.length > 1) about = normalizeText(parts.slice(1).join(" · "));
    }

    // ---- Experience ----
    const expSection = findSectionByH2("Experience");
    const experiences = [];
    if (expSection) {
      const items = expSection.querySelectorAll("li");
      for (const li of items) {
        // Use stable semantic selectors: h3 for title, h4 for company
        // Also try class-based: experience-item__title, experience-item__subtitle
        const title =
          normalizeText(li.querySelector("h3")?.textContent) ||
          normalizeText(li.querySelector('[class*="experience-item__title"]')?.textContent);
        const company =
          normalizeText(li.querySelector("h4")?.textContent) ||
          normalizeText(li.querySelector('[class*="experience-item__subtitle"]')?.textContent);

        // Date range: parse from <time> elements and the "before:middot" duration span
        const dateRangeEl = li.querySelector('[class*="date-range"]');
        let startDate = null;
        let endDate = null;
        let duration = null;

        if (dateRangeEl) {
          // Extract start date from <time> element (most reliable)
          const timeEls = dateRangeEl.querySelectorAll("time");
          if (timeEls.length >= 2) {
            startDate = normalizeText(timeEls[0].textContent);
            endDate = normalizeText(timeEls[1].textContent);
          } else if (timeEls.length === 1) {
            startDate = normalizeText(timeEls[0].textContent);
            // Check if "Present" appears in the text
            const rangeText = dateRangeEl.textContent || "";
            if (rangeText.includes("Present")) endDate = "Present";
          }
          // Duration: "X years Y months" in span.before:middot
          const durationEl = dateRangeEl.querySelector('[class*="before:middot"], [class*="middot"]');
          duration = normalizeText(durationEl?.textContent) || null;
          
          // Fallback: parse from full text if time elements not found
          if (!startDate) {
            const rawText = normalizeText(dateRangeEl.textContent) || "";
            // Remove duration (usually at end after newline)
            const firstLine = rawText.split("\n")[0]?.trim() || rawText.split("  ")[0]?.trim() || rawText;
            const parts = firstLine.split(" - ").map((p) => p.trim());
            startDate = parts[0] || null;
            endDate = parts[1] || null;
          }
        }

        // Description
        const description = normalizeText(
          li.querySelector('[class*="description"]')?.textContent
        );

        // Location
        const expLocation = normalizeText(
          li.querySelector('[class*="location"]')?.textContent
        );

        if (title || company) {
          experiences.push({
            title,
            company,
            startDate,
            endDate,
            duration,
            location: expLocation,
            description,
          });
        }
      }
    }

    // ---- Education ----
    const eduSection = findSectionByH2("Education");
    const education = [];
    if (eduSection) {
      const items = eduSection.querySelectorAll("li");
      for (const li of items) {
        const school = normalizeText(li.querySelector("h3")?.textContent);
        const degree = normalizeText(li.querySelector("h4")?.textContent);
        // "-" alone means no degree info provided
        const degreeClean =
          degree && degree !== "-" ? degree : null;

        const dateRangeEl = li.querySelector('[class*="date-range"]');
        let startDate = null;
        let endDate = null;
        
        if (dateRangeEl) {
          const timeEls = dateRangeEl.querySelectorAll("time");
          if (timeEls.length >= 2) {
            startDate = normalizeText(timeEls[0].textContent);
            endDate = normalizeText(timeEls[1].textContent);
          } else if (timeEls.length === 1) {
            startDate = normalizeText(timeEls[0].textContent);
          } else {
            // Fallback: parse text
            const rawText = normalizeText(dateRangeEl.textContent) || "";
            const parts = rawText.split(" - ").map((p) => p.trim());
            startDate = parts[0] || null;
            endDate = parts[1] || null;
          }
        }

        const description = normalizeText(
          li.querySelector('[class*="description"]')?.textContent
        );

        if (school) {
          education.push({
            school,
            degree: degreeClean,
            startDate,
            endDate,
            description,
          });
        }
      }
    }

    // ---- Articles / Posts ----
    // Find the articles section (heading may vary: "Articles by X", "Articles", "Activity")
    let articleSection = null;
    for (const h2 of h2s) {
      if (
        h2.textContent?.includes("Articles") &&
        !h2.textContent?.includes("Sign")
      ) {
        articleSection =
          h2.closest("section") || h2.parentElement?.parentElement;
        break;
      }
    }

    const articles = [];
    if (articleSection) {
      // Each article is in a <div> or <li> with an <a> link and h3 title
      const articleEls = articleSection.querySelectorAll(
        "article, [class*='article-card'], li"
      );
      const seen = new Set();
      for (const el of articleEls) {
        const titleEl = el.querySelector("h3");
        const linkEl = el.querySelector(
          'a[href*="/pulse/"], a[href*="/posts/"]'
        );
        if (!titleEl || !linkEl) continue;
        const title = normalizeText(titleEl.textContent);
        const url = linkEl.href;
        if (!title || seen.has(url)) continue;
        seen.add(url);

        // Date
        const timeEl = el.querySelector("time");
        const dateText = normalizeText(
          timeEl?.textContent ||
            el.querySelector('[class*="date"]')?.textContent
        );

        articles.push({ title, url, publishedAt: dateText });
      }
    }

    // Enrich articles with JSON-LD data (dates + like counts)
    if (jsonLd) {
      for (const item of jsonLd) {
        if (item["@type"] === "Article" && item.url && item.headline) {
          const existing = articles.find((a) => a.url === item.url);
          if (existing) {
            // Enrich existing article with JSON-LD data
            existing.publishedAt = existing.publishedAt || item.datePublished || null;
            existing.likeCount = item.interactionStatistic?.userInteractionCount || null;
          } else {
            // Add article from JSON-LD if not already in list
            articles.push({
              title: item.headline,
              url: item.url,
              publishedAt: item.datePublished || null,
              likeCount:
                item.interactionStatistic?.userInteractionCount || null,
            });
          }
        }
      }
    }

    // ---- Profile URL & username ----
    const profileUrl = metas["og:url"] || window.location.href;
    const username = profileUrl.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1] || null;

    return {
      username,
      name,
      headline,
      location,
      profileImage,
      about,
      profileUrl,
      experiences,
      education,
      articles,
      meta: {
        description: metas["description"] || null,
        ogTitle: metas["og:title"] || null,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Company data extraction
// ---------------------------------------------------------------------------

/**
 * Extract company data from a LinkedIn company page.
 * Works on /company/<slug> pages.
 */
export async function extractCompanyData(page) {
  return page.evaluate(() => {
    function normalizeText(str) {
      if (!str) return null;
      return str.replace(/\s+/g, " ").trim() || null;
    }

    function parseCount(str) {
      if (!str) return null;
      const cleaned = str
        .replace(/,/g, "")
        .replace(/\+/, "")
        .replace(/[^0-9]/g, "");
      const n = parseInt(cleaned, 10);
      return isNaN(n) ? null : n;
    }

    // ---- Meta tags ----
    const metas = {};
    document.querySelectorAll("meta").forEach((m) => {
      const key = m.getAttribute("property") || m.getAttribute("name");
      if (key) metas[key] = m.getAttribute("content");
    });

    // ---- Basic company info ----
    const name = normalizeText(document.querySelector("h1")?.textContent);
    const profileUrl = metas["og:url"] || window.location.href;
    const slug = profileUrl.match(/linkedin\.com\/company\/([^/?#]+)/)?.[1] || null;
    const profileImage = metas["og:image"] || null;

    // Tagline (h2 that looks like a company tagline, not nav items)
    const h2s = Array.from(document.querySelectorAll("h2"));
    const SKIP = [
      "LinkedIn",
      "Sign in",
      "About",
      "Locations",
      "Employees",
      "Updates",
      "Join",
      "Similar",
      "Browse",
      "Funding",
      "Affiliated",
    ];
    const taglineH2 = h2s.find(
      (h) =>
        h.textContent &&
        !SKIP.some((skip) => h.textContent.trim().startsWith(skip))
    );
    const industry = normalizeText(taglineH2?.textContent);

    // Follower count from DOM text "X followers"
    const allText = document.body?.textContent || "";
    const followerMatch = allText.match(/([\d,]+(?:\.\d+)?[KMBkm]?)\s*followers/);
    const followerText = followerMatch?.[1];
    let followerCount = null;
    if (followerText) {
      followerCount = parseCount(followerText);
    }

    // Employee count from DOM "View all X employees" or "Discover all X employees"
    const employeeMatch = allText.match(/(?:View|Discover) all ([\d,]+(?:\.\d+)?[KMBkm]?)\s*employees/);
    const employeeText = employeeMatch?.[1];
    let employeeCount = null;
    if (employeeText) {
      employeeCount = parseCount(employeeText);
    }

    // ---- About section ----
    const h2About = h2s.find(
      (h) =>
        h.textContent?.trim() === "About us" ||
        h.textContent?.trim() === "About"
    );
    const aboutSection =
      h2About?.closest("section") || h2About?.parentElement?.parentElement;

    let about = null;
    let website = null;
    let industryDetail = null;
    let companySize = null;
    let headquarters = null;
    let companyType = null;
    let founded = null;
    let specialties = null;

    if (aboutSection) {
      // Main description paragraph: find first <p> with substantial text (not a label)
      const pEls = aboutSection.querySelectorAll("p");
      for (const p of pEls) {
        const t = normalizeText(p.textContent);
        if (t && t.length > 50) {
          about = t;
          break;
        }
      }
      // Fallback: find content div
      if (!about) {
        const contentEl = aboutSection.querySelector('[class*="show-more-less__text"]') ||
          aboutSection.querySelector('[class*="org-about__description"]');
        about = normalizeText(contentEl?.textContent);
      }

      // Detail items: LinkedIn uses <dt> labels paired with <dd> values
      // Website dd contains an <a> tag — extract the href for clean URL
      const dtEls = aboutSection.querySelectorAll("dt");
      for (const dt of dtEls) {
        const label = normalizeText(dt.textContent);
        const dd = dt.nextElementSibling;
        if (!label || !dd) continue;
        const lc = label.toLowerCase();
        
        if (lc.includes("website")) {
          // Extract URL from the <a> tag inside the dd
          const linkEl = dd.querySelector("a");
          if (linkEl) {
            // LinkedIn wraps external URLs in a redirect URL; try to extract the real URL
            const href = linkEl.getAttribute("href") || "";
            const urlParam = href.match(/[?&]url=([^&]+)/);
            if (urlParam) {
              try {
                website = decodeURIComponent(urlParam[1]);
              } catch (_) {
                website = linkEl.textContent?.trim() || href;
              }
            } else {
              // Use the text content of the link (contains the actual URL)
              website = linkEl.textContent?.trim() || null;
            }
          }
          // Remove "External link for X" suffix if present
          if (website && website.includes("\n")) {
            website = website.split("\n")[0]?.trim() || website;
          }
        } else if (lc.includes("industry")) {
          industryDetail = normalizeText(dd.textContent);
        } else if (lc.includes("company size") || lc === "size") {
          companySize = normalizeText(dd.textContent);
        } else if (lc.includes("headquarters")) {
          headquarters = normalizeText(dd.textContent);
        } else if (lc === "type") {
          companyType = normalizeText(dd.textContent);
        } else if (lc.includes("founded")) {
          founded = normalizeText(dd.textContent);
        } else if (lc.includes("specialties")) {
          specialties = normalizeText(dd.textContent);
        }
      }
    }

    // ---- Locations ----
    const locH2 = h2s.find((h) => h.textContent?.trim() === "Locations");
    const locSection =
      locH2?.closest("section") || locH2?.parentElement?.parentElement;
    const locations = [];
    if (locSection) {
      // Each location is in div[id^="address-"] with <p> elements for address lines
      const addrDivs = locSection.querySelectorAll('[id^="address-"]');
      for (const div of addrDivs) {
        const lines = Array.from(div.querySelectorAll("p"))
          .map((p) => normalizeText(p.textContent))
          .filter(Boolean);
        if (lines.length > 0) {
          locations.push(lines.join(", "));
        }
      }
    }

    // Fallback: extract from <li> items in locations section
    if (locations.length === 0 && locSection) {
      const lis = locSection.querySelectorAll("li");
      for (const li of lis) {
        // Get text from li, skip "Get directions" and "Primary" badge text
        const cloneDiv = document.createElement("div");
        cloneDiv.innerHTML = li.innerHTML;
        // Remove links (Get directions)
        cloneDiv.querySelectorAll("a").forEach((a) => a.remove());
        // Remove tag badges
        cloneDiv.querySelectorAll(".tag-sm, .tag-enabled").forEach((t) => t.remove());
        const text = normalizeText(cloneDiv.textContent);
        if (text && text.length > 10) {
          locations.push(text);
        }
      }
    }

    return {
      slug,
      name,
      profileUrl,
      profileImage,
      industry: industryDetail || industry,
      followerCount,
      employeeCount,
      about,
      website,
      companySize,
      headquarters,
      companyType,
      founded,
      specialties,
      locations: locations.slice(0, 10),
      meta: {
        description: metas["description"] || null,
        ogTitle: metas["og:title"] || null,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Job search extraction
// ---------------------------------------------------------------------------

/**
 * Extract job listings from a LinkedIn jobs search page.
 */
export async function extractJobListings(page) {
  return page.evaluate(() => {
    function normalizeText(str) {
      if (!str) return null;
      return str.replace(/\s+/g, " ").trim() || null;
    }

    // LinkedIn uses [class*="job-search-card"] or .base-card with data-entity-urn
    const cards = Array.from(
      document.querySelectorAll(
        '[class*="job-search-card"][data-entity-urn], .base-card[data-entity-urn]'
      )
    );

    const jobs = [];
    for (const card of cards) {
      const urn = card.getAttribute("data-entity-urn");
      const jobId = urn?.split(":").pop() || null;

      // Title from h3 (stable semantic element)
      const title = normalizeText(card.querySelector("h3")?.textContent);

      // Company from h4 (stable semantic element)
      const company = normalizeText(card.querySelector("h4")?.textContent);

      // Job URL from the full-link anchor
      const urlEl =
        card.querySelector('a[href*="/jobs/view/"]') ||
        card.querySelector("a[href]");
      const rawUrl = urlEl?.href || null;
      // Clean URL: remove tracking params (position, refId, trackingId, pageNum)
      let url = null;
      if (rawUrl) {
        try {
          const u = new URL(rawUrl);
          u.searchParams.delete("position");
          u.searchParams.delete("pageNum");
          u.searchParams.delete("refId");
          u.searchParams.delete("trackingId");
          url = u.toString();
        } catch (_) {
          url = rawUrl;
        }
      }

      // Company logo
      const logoImg = card.querySelector("img[src]")?.getAttribute("src") || null;

      // Location: use stable class "job-search-card__location"
      const locationEl = card.querySelector('[class*="job-search-card__location"]');
      const location = normalizeText(locationEl?.textContent) || null;

      // Posted date: use stable class "job-search-card__listdate" with datetime attr
      const timeEl = card.querySelector('time[class*="listdate"], time[class*="job-search-card"]');
      let postedAt = null;
      if (timeEl) {
        postedAt =
          timeEl.getAttribute("datetime") ||
          normalizeText(timeEl.textContent) || null;
      } else {
        // Fallback: any time element in the card
        const anyTime = card.querySelector("time");
        if (anyTime) {
          postedAt = anyTime.getAttribute("datetime") || normalizeText(anyTime.textContent);
        }
      }

      // Easy Apply badge
      const isEasyApply =
        !!card.querySelector('[class*="easy-apply"]') ||
        card.textContent?.includes("Easy Apply") || false;

      // Applicant count (sometimes shown in card)
      const applicantMatch = card.textContent?.match(
        /([\d,]+\+?)\s*applicants?/i
      );
      const applicantCount = applicantMatch
        ? parseInt(applicantMatch[1].replace(/,/g, ""), 10)
        : null;

      if (title || company) {
        jobs.push({
          jobId,
          urn,
          title,
          company,
          location,
          postedAt,
          isEasyApply,
          applicantCount,
          url,
          logoImg,
        });
      }
    }

    // Total results count from h1 heading: "90,000+ Software Engineer Jobs in United States"
    const h1El = document.querySelector("h1");
    const h1Text = normalizeText(h1El?.textContent) || "";
    const totalMatch = h1Text.match(/^([\d,]+\+?)\s/);
    const totalResults = totalMatch
      ? parseInt(totalMatch[1].replace(/[,+]/g, ""), 10)
      : null;

    return { jobs, totalResults };
  });
}

// ---------------------------------------------------------------------------
// Job detail extraction
// ---------------------------------------------------------------------------

/**
 * Extract full job details from a LinkedIn job detail page.
 * Works on /jobs/view/<id> pages.
 */
export async function extractJobDetail(page) {
  return page.evaluate(() => {
    function normalizeText(str) {
      if (!str) return null;
      return str.replace(/\s+/g, " ").trim() || null;
    }

    // Meta tags
    const metas = {};
    document.querySelectorAll("meta").forEach((m) => {
      const key = m.getAttribute("property") || m.getAttribute("name");
      if (key) metas[key] = m.getAttribute("content");
    });

    // Job ID from URL or data attr
    const urn =
      document.querySelector("[data-entity-urn]")?.getAttribute("data-entity-urn") ||
      null;
    const jobId = urn?.split(":").pop() || null;

    // Title
    const title = normalizeText(document.querySelector("h1")?.textContent);

    // Top card: company + location + posted + applicants
    const topCard = document.querySelector(
      "[class*='topcard'], [class*='top-card']"
    );

    // Company name: h4 or link inside topcard
    const companyEl =
      document.querySelector(
        '[class*="topcard__org-name"] a, [class*="topcard__org-name"]'
      ) || document.querySelector("h4");
    const company = normalizeText(companyEl?.textContent);

    // Location: span with "topcard__flavor--bullet"
    const locationEl =
      document.querySelector('[class*="topcard__flavor--bullet"]') ||
      document.querySelector('[class*="topcard__flavor"]');
    const location = normalizeText(locationEl?.textContent);

    // Posted date and applicants from flavors
    const flavorEls = Array.from(
      document.querySelectorAll('[class*="topcard__flavor"]')
    );
    let postedAt = null;
    let applicantCount = null;
    for (const el of flavorEls) {
      const text = normalizeText(el.textContent) || "";
      if (text.match(/\d+\s+(day|hour|week|month|year)s?\s+ago/i) || text.match(/Just now|Today/i)) {
        postedAt = text;
      } else if (text.match(/applicant|over/i)) {
        const numMatch = text.match(/([\d,]+\+?)\s*applicant/i);
        if (numMatch) {
          applicantCount = parseInt(numMatch[1].replace(/,/g, ""), 10);
        }
      }
    }

    // Company logo
    const logoImg =
      document.querySelector('[class*="topcard"] img')?.src ||
      document.querySelector('[class*="company-logo"]')?.src ||
      null;

    // Job description text
    const descEl =
      document.querySelector('[class*="show-more-less-html__markup"]') ||
      document.querySelector('[class*="description__text"]') ||
      document.querySelector('[class*="description"]');
    const description = normalizeText(descEl?.textContent);

    // Job criteria: seniority, employment type, job function, industries
    const criteriaEls = Array.from(
      document.querySelectorAll('[class*="description__job-criteria-item"]')
    );
    const criteria = {};
    for (const el of criteriaEls) {
      const label = normalizeText(el.querySelector("h3")?.textContent);
      const value = normalizeText(el.querySelector("span")?.textContent);
      if (label && value) {
        // Normalize label to camelCase key
        const key = label
          .toLowerCase()
          .replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
        criteria[key] = value;
      }
    }

    // LinkedIn job URL (canonical)
    const jobUrl = metas["og:url"] || window.location.href;

    // Company profile URL
    const companyUrl =
      document.querySelector(
        'a[href*="/company/"][class*="topcard"]'
      )?.href ||
      document.querySelector('a[href*="/company/"]')?.href ||
      null;

    // Easy Apply
    const isEasyApply =
      !!document.querySelector('[class*="easy-apply"]') ||
      document.body?.textContent?.includes("Easy Apply") || false;

    return {
      jobId,
      urn,
      title,
      company,
      companyUrl,
      location,
      postedAt,
      applicantCount,
      isEasyApply,
      logoImg,
      description,
      criteria,
      jobUrl,
      meta: {
        description: metas["description"] || null,
        ogTitle: metas["og:title"] || null,
      },
    };
  });
}
