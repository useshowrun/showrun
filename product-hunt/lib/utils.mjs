// ---------------------------------------------------------------------------
// Shared utilities for Product Hunt scraper skills
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
// Scrape post items from a Product Hunt leaderboard / homepage
//
// Product structure (DOM pattern as of 2026-03):
//   <section data-test="post-item-<id>">
//     <img />                                   — thumbnail
//     <span data-test="post-name-<id>">         — name (may include rank "N. " prefix)
//       <a href="/products/<slug>">              — product link
//     </span>
//     <span>tagline text</span>                 — plain span after the external-link SVG
//     <div>                                     — topics wrapper
//       <a href="/topics/<slug>">topic</a>...
//     </div>
//     <button>comments_count</button>           — first unlabeled button = comments
//     <button data-test="vote-button">          — upvote button
//       <p>vote_count</p>
//     </button>
//   </section>
//
// This function runs inside page.evaluate() — no imports, no closures over outer vars.
// ---------------------------------------------------------------------------

export function scrapePostItems() {
  const sections = document.querySelectorAll('[data-test^="post-item-"]');
  const results = [];

  for (const section of sections) {
    const dataTest = section.getAttribute("data-test") || "";
    const postId = dataTest.split("-").pop();

    // Thumbnail
    const imgEl = section.querySelector("img");
    const thumbnail = imgEl ? imgEl.src || imgEl.getAttribute("src") : null;

    // Name (strip rank number prefix like "1. ", "12. ")
    const nameEl = section.querySelector(`[data-test="post-name-${postId}"]`);
    const rawName = nameEl ? nameEl.textContent.trim() : null;
    const name = rawName ? rawName.replace(/^\d+\.\s*/, "") : null;

    // Product slug / URL
    const productLink = section.querySelector("a[href^='/products/']");
    const productSlug = productLink ? productLink.getAttribute("href").split("?")[0] : null;
    const productUrl = productSlug
      ? `https://www.producthunt.com${productSlug}`
      : null;

    // Tagline — the <span> immediately after the SVG icon inside the name area
    // It's a plain span (no data-test) containing the tagline text
    let tagline = null;
    const allSpans = section.querySelectorAll("span:not([data-test])");
    for (const span of allSpans) {
      const text = span.textContent.trim();
      // Skip bullets, empty spans, and topic-separator dots
      if (text && text !== "•" && text.length > 3 && !text.includes("•")) {
        // Skip if it's a child of the name element
        const isInsideName = nameEl && nameEl.contains(span);
        if (!isInsideName) {
          tagline = text;
          break;
        }
      }
    }

    // Topics — links under /topics/
    const topicLinks = section.querySelectorAll("a[href^='/topics/']");
    const topics = [];
    for (const link of topicLinks) {
      const topicName = link.textContent.trim();
      const topicSlug = (link.getAttribute("href") || "").split("/").pop().split("?")[0];
      if (topicName && topicSlug) {
        topics.push({ name: topicName, slug: topicSlug });
      }
    }

    // Vote count — [data-test="vote-button"] button
    const voteBtn = section.querySelector('[data-test="vote-button"]');
    const votesCount = voteBtn
      ? parseInt(voteBtn.textContent.trim().replace(/,/g, ""), 10) || 0
      : null;

    // Comment count — first button WITHOUT data-test inside the section (before vote button)
    // It appears as a generic button with a chat icon
    let commentsCount = null;
    const buttons = section.querySelectorAll("button:not([data-test])");
    if (buttons.length > 0) {
      const firstBtn = buttons[0];
      const countText = firstBtn.textContent.trim().replace(/,/g, "");
      const parsed = parseInt(countText, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        commentsCount = parsed;
      }
    }

    if (postId && name) {
      results.push({
        id: postId,
        name,
        tagline: tagline || null,
        productUrl,
        productSlug: productSlug || null,
        thumbnail: thumbnail || null,
        votesCount,
        commentsCount,
        topics,
        scrapedFrom: "leaderboard",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Extract search results from Product Hunt's Apollo SSR inline script data
//
// Product Hunt (Next.js + Apollo) embeds server-side fetched search results
// in inline scripts via:
//   (window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({...})
//
// The relevant script contains:
//   data.productSearch.edges[].node = { id, name, tagline, slug, reviewsRating,
//                                        reviewsCount, logoUuid }
//
// The slug gives us: https://www.producthunt.com/products/<slug>
// The logoUuid gives us the thumbnail URL via imgix.
//
// This function runs inside page.evaluate() — no imports, no closures.
// ---------------------------------------------------------------------------

export function extractSearchFromApollo() {
  const scripts = document.querySelectorAll("script:not([src])");
  const allProducts = [];

  for (const script of scripts) {
    const text = script.textContent;
    if (!text.includes("productSearch") || !text.includes("ApolloSSR")) continue;

    try {
      // Extract JSON argument from .push({...})
      const match = text.match(/\.push\((\{[\s\S]+\})\)$/);
      if (!match) continue;

      const parsed = JSON.parse(match[1]);
      const rehydrate = parsed.rehydrate || {};

      for (const val of Object.values(rehydrate)) {
        const searchData = val?.data?.productSearch;
        if (!searchData?.edges) continue;

        for (const edge of searchData.edges) {
          const node = edge?.node;
          if (!node) continue;

          const logoUuid = node.logoUuid || null;
          const thumbnail = logoUuid
            ? `https://ph-files.imgix.net/${logoUuid}?auto=compress&codec=mozjpeg&cs=strip&auto=format&w=72&h=72&fit=crop&frame=1`
            : null;

          allProducts.push({
            id: node.id || null,
            name: (node.name || "").trim() || null,
            tagline: (node.tagline || "").trim() || null,
            slug: node.slug || null,
            productUrl: node.slug
              ? `https://www.producthunt.com/products/${node.slug}`
              : null,
            thumbnail,
            reviewsRating:
              node.reviewsRating && node.reviewsRating > 0
                ? node.reviewsRating
                : null,
            reviewsCount:
              node.reviewsCount && node.reviewsCount > 0
                ? node.reviewsCount
                : null,
            isNoLongerOnline: node.isNoLongerOnline || false,
            scrapedFrom: "search",
          });
        }
      }
    } catch (e) {
      // Skip malformed scripts
    }
  }

  return allProducts;
}

// ---------------------------------------------------------------------------
// Scrape search result items from Product Hunt search page (DOM fallback)
//
// Used when Apollo SSR data is not available.
// Search result DOM pattern (as of 2026-03):
//   <button data-test="spotlight-result-product-<id>">
//     <img data-test="<name>-thumbnail" />
//     ... name text (first text node) ...
//     ... tagline text (second text node) ...
//     ... "N reviews" text (optional) ...
//   </button>
// ---------------------------------------------------------------------------

export function scrapeSearchItemsFromDom() {
  const buttons = document.querySelectorAll('[data-test^="spotlight-result-product-"]');
  const results = [];

  for (const btn of buttons) {
    const dataTest = btn.getAttribute("data-test") || "";
    const productId = dataTest.split("-").pop();

    // Thumbnail
    const imgEl = btn.querySelector("img");
    const thumbnail = imgEl ? imgEl.src || imgEl.getAttribute("src") : null;

    // Extract text nodes in order
    const textNodes = [];
    const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text && text.length > 1 && !text.match(/^[\s•]+$/)) {
        textNodes.push(text);
      }
    }

    const name = textNodes[0] || null;
    const tagline =
      textNodes.length > 1 &&
      !textNodes[1].toLowerCase().includes("review") &&
      !textNodes[1].match(/^\d/)
        ? textNodes[1]
        : null;

    // Reviews count
    let reviewsCount = null;
    for (const text of textNodes) {
      const m = text.match(/^(\d+)\s+reviews?$/i);
      if (m) {
        reviewsCount = parseInt(m[1], 10);
        break;
      }
    }

    // Star rating — count filled star elements
    const filledStars = btn.querySelectorAll('[data-test$="-filled"]').length;
    const reviewsRating = filledStars > 0 ? filledStars : null;

    if (productId && name) {
      results.push({
        id: productId,
        name,
        tagline: tagline || null,
        productUrl: null, // slug not available from DOM alone
        thumbnail: thumbnail || null,
        reviewsCount,
        reviewsRating,
        scrapedFrom: "search-dom",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Parse a Product Hunt Atom/RSS feed entry into a clean product record
// (kept for reference — the feed approach lacks vote counts)
// ---------------------------------------------------------------------------

export function parseFeedEntry(xml) {
  function extract(tag, text) {
    const m = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  }

  const idTag = extract("id", xml);
  const postId = idTag ? idTag.split("/").pop() : null;

  const title = extract("title", xml);
  const author = (() => {
    const authorBlock = xml.match(/<author>([\s\S]*?)<\/author>/);
    if (!authorBlock) return null;
    return extract("name", authorBlock[1]) || null;
  })();

  const published = extract("published", xml);
  const updated = extract("updated", xml);

  const productUrl = (() => {
    const m = xml.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/);
    return m ? m[1] : null;
  })();

  const contentRaw = extract("content", xml);
  let tagline = null;
  let discussionUrl = null;
  let externalUrl = null;

  if (contentRaw) {
    const decoded = contentRaw
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    const firstP = decoded.match(/<p>([\s\S]*?)<\/p>/);
    if (firstP) tagline = firstP[1].replace(/<[^>]+>/g, "").trim();

    const links = [...decoded.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
    for (const [, href, text] of links) {
      if (text.trim().toLowerCase() === "discussion") discussionUrl = href.split("?")[0];
      if (text.trim().toLowerCase() === "link") externalUrl = href;
    }
  }

  return {
    id: postId ? parseInt(postId, 10) : null,
    title: title || null,
    tagline: tagline || null,
    author: author || null,
    productUrl: productUrl || null,
    discussionUrl: discussionUrl || null,
    externalUrl: externalUrl || null,
    publishedAt: published ? new Date(published).toISOString() : null,
    updatedAt: updated ? new Date(updated).toISOString() : null,
  };
}
