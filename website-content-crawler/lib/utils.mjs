/**
 * Shared utilities for Website Content Crawler.
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
// URL utilities
// ---------------------------------------------------------------------------

/**
 * Normalize URL: remove fragment, trailing slash normalization, lowercase scheme+host
 */
export function normalizeUrl(url, baseUrl) {
  try {
    const parsed = new URL(url, baseUrl);
    // Remove fragment
    parsed.hash = "";
    // Lowercase scheme and host
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Check if URL is same domain (or subdomain) as base.
 */
export function isSameDomain(url, baseUrl) {
  try {
    const u = new URL(url);
    const b = new URL(baseUrl);
    const uHost = u.hostname.toLowerCase();
    const bHost = b.hostname.toLowerCase();
    return uHost === bHost || uHost.endsWith("." + bHost) || bHost.endsWith("." + uHost);
  } catch {
    return false;
  }
}

/**
 * Check if URL is a web page (not a file/binary/media link).
 */
export function isWebPage(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    // Skip non-page extensions
    const skipExtensions = [
      ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
      ".zip", ".tar", ".gz", ".rar", ".7z",
      ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp",
      ".mp4", ".mp3", ".avi", ".mov", ".wmv", ".flv", ".webm",
      ".css", ".js", ".mjs", ".ts",
      ".xml", ".json", ".csv", ".txt",
      ".woff", ".woff2", ".ttf", ".eot",
    ];
    for (const ext of skipExtensions) {
      if (pathname.endsWith(ext)) return false;
    }
    // Skip non-http/https
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content extraction (runs in browser context)
// ---------------------------------------------------------------------------

/**
 * Clean and extract main content from a page.
 * Removes nav, headers, footers, ads, cookie banners.
 * Returns { title, markdown, text, metadata, links }
 */
export const extractPageContent = `
(function() {
  // ---- Helpers ----
  function getText(el) {
    if (!el) return "";
    return el.innerText || el.textContent || "";
  }

  function getAttr(el, ...attrs) {
    if (!el) return null;
    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      if (val && val.trim()) return val.trim();
    }
    return null;
  }

  // ---- Title ----
  const title = document.title || 
    getAttr(document.querySelector("h1"), "textContent") || 
    getAttr(document.querySelector('meta[property="og:title"]'), "content") || "";

  // ---- Metadata ----
  const metadata = {};
  
  // Description
  const descMeta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  if (descMeta) metadata.description = getAttr(descMeta, "content");
  
  // Author
  const authorMeta = document.querySelector('meta[name="author"], meta[property="article:author"]');
  if (authorMeta) metadata.author = getAttr(authorMeta, "content");
  
  // Published date
  const dateMeta = document.querySelector('meta[property="article:published_time"], meta[name="date"], time[datetime]');
  if (dateMeta) metadata.publishedDate = getAttr(dateMeta, "content") || getAttr(dateMeta, "datetime");
  
  // Keywords
  const keywordsMeta = document.querySelector('meta[name="keywords"]');
  if (keywordsMeta) metadata.keywords = getAttr(keywordsMeta, "content");
  
  // OG image
  const ogImage = document.querySelector('meta[property="og:image"]');
  if (ogImage) metadata.image = getAttr(ogImage, "content");
  
  // Canonical URL
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) metadata.canonical = getAttr(canonical, "href");
  
  // Language
  metadata.language = document.documentElement.lang || null;
  
  // ---- Noise removal ----
  // Clone body to avoid mutating the real DOM
  const bodyClone = document.body.cloneNode(true);
  
  // Remove obviously noisy elements
  const noiseSelectors = [
    "nav", "header", "footer",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    ".nav", ".navigation", ".navbar", ".menu", ".sidebar", ".side-bar",
    ".header", ".footer", ".cookie", ".cookies", ".cookie-banner", ".cookie-notice",
    ".advertisement", ".ad", ".ads", ".advert",
    "#nav", "#navigation", "#navbar", "#menu", "#sidebar",
    "#header", "#footer", "#cookie", "#cookie-banner",
    ".social-share", ".social-links", ".share-buttons",
    ".modal", ".popup", ".overlay",
    "script", "style", "noscript", "iframe",
    ".breadcrumb", ".breadcrumbs",
    ".related", ".related-posts", ".suggestions",
    "aside",
  ];
  
  for (const sel of noiseSelectors) {
    bodyClone.querySelectorAll(sel).forEach(el => el.remove());
  }
  
  // ---- Find main content element ----
  // Priority: <main>, [role=main], article, .content, .post, .entry
  const mainSelectors = [
    "main",
    "[role='main']",
    // For listing pages with multiple articles, prefer parent container
    ".post-content", ".entry-content", ".article-content", ".article-body",
    ".content", ".main-content",
    "#content", "#main-content", "#main",
    ".post", ".entry",
    "article",
    ".container",
    ".wrapper",
    "[class*='content']",
    "[id*='content']",
  ];
  
  let mainEl = null;
  
  // If there are multiple articles (listing/index page), try to find their parent container
  const allArticles = bodyClone.querySelectorAll("article");
  if (allArticles.length > 1) {
    // Find common ancestor of the first two articles
    let candidate = allArticles[0].parentElement;
    while (candidate && candidate !== bodyClone) {
      if (candidate.contains(allArticles[1])) {
        mainEl = candidate;
        break;
      }
      candidate = candidate.parentElement;
    }
  }
  
  // Otherwise use the priority selector list
  if (!mainEl) {
    for (const sel of mainSelectors) {
      const el = bodyClone.querySelector(sel);
      if (el && (el.innerText || el.textContent || "").trim().length > 50) {
        mainEl = el;
        break;
      }
    }
  }
  
  // Fallback: use the body clone
  if (!mainEl) mainEl = bodyClone;
  
  // ---- Convert to Markdown-like text ----
  function htmlToMarkdown(el) {
    const lines = [];
    
    function processNode(node, depth) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.replace(/\\s+/g, " ").trim();
        if (text) lines.push({ type: "text", content: text });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      
      const tag = node.tagName.toLowerCase();
      const children = Array.from(node.childNodes);
      
      // Skip invisible elements
      const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
      if (style && (style.display === "none" || style.visibility === "hidden")) return;
      
      switch (tag) {
        case "h1":
          lines.push({ type: "block", content: "# " + node.innerText.trim() });
          break;
        case "h2":
          lines.push({ type: "block", content: "## " + node.innerText.trim() });
          break;
        case "h3":
          lines.push({ type: "block", content: "### " + node.innerText.trim() });
          break;
        case "h4":
          lines.push({ type: "block", content: "#### " + node.innerText.trim() });
          break;
        case "h5": case "h6":
          lines.push({ type: "block", content: "##### " + node.innerText.trim() });
          break;
        case "p": {
          const text = node.innerText.trim();
          if (text) lines.push({ type: "block", content: text });
          break;
        }
        case "br":
          lines.push({ type: "br" });
          break;
        case "hr":
          lines.push({ type: "block", content: "---" });
          break;
        case "ul": case "ol": {
          const items = node.querySelectorAll(":scope > li");
          items.forEach((li, i) => {
            const prefix = tag === "ul" ? "- " : (i + 1) + ". ";
            lines.push({ type: "block", content: prefix + li.innerText.trim() });
          });
          break;
        }
        case "blockquote": {
          const text = node.innerText.trim();
          if (text) lines.push({ type: "block", content: "> " + text.split("\\n").join("\\n> ") });
          break;
        }
        case "pre": case "code": {
          const codeText = node.innerText || node.textContent || "";
          if (codeText.trim()) {
            if (tag === "pre") {
              lines.push({ type: "block", content: "\`\`\`\\n" + codeText.trim() + "\\n\`\`\`" });
            }
          }
          break;
        }
        case "a": {
          const href = node.getAttribute("href");
          const text = node.innerText.trim();
          if (text && href && !href.startsWith("javascript:")) {
            lines.push({ type: "inline", content: "[" + text + "](" + href + ")" });
          } else if (text) {
            lines.push({ type: "text", content: text });
          }
          break;
        }
        case "img": {
          const alt = node.getAttribute("alt") || "";
          const src = node.getAttribute("src") || "";
          if (alt && src) {
            lines.push({ type: "inline", content: "![" + alt + "](" + src + ")" });
          }
          break;
        }
        case "table": {
          // Simplified table extraction
          const rows = Array.from(node.querySelectorAll("tr"));
          rows.forEach((row, ri) => {
            const cells = Array.from(row.querySelectorAll("td, th"));
            const cellTexts = cells.map(c => c.innerText.trim().replace(/\\n/g, " "));
            lines.push({ type: "block", content: "| " + cellTexts.join(" | ") + " |" });
            if (ri === 0) {
              lines.push({ type: "block", content: "| " + cells.map(() => "---").join(" | ") + " |" });
            }
          });
          break;
        }
        case "strong": case "b": {
          const text = node.innerText.trim();
          if (text) lines.push({ type: "text", content: "**" + text + "**" });
          break;
        }
        case "em": case "i": {
          const text = node.innerText.trim();
          if (text) lines.push({ type: "text", content: "*" + text + "*" });
          break;
        }
        default:
          children.forEach(child => processNode(child, depth + 1));
      }
    }
    
    Array.from(el.childNodes).forEach(n => processNode(n, 0));
    
    // Assemble lines
    let result = "";
    let prevType = null;
    for (const line of lines) {
      if (line.type === "block") {
        if (prevType !== null) result += "\\n\\n";
        result += line.content;
        prevType = "block";
      } else if (line.type === "br") {
        result += "\\n";
      } else {
        if (prevType === "block") result += " ";
        result += line.content;
        prevType = "text";
      }
    }
    
    return result;
  }
  
  const markdown = htmlToMarkdown(mainEl);
  
  // ---- Plain text ----
  const text = (mainEl.innerText || mainEl.textContent || "").replace(/\\s+/g, " ").trim();
  
  // ---- Links ----
  const links = [];
  const seenLinks = new Set();
  document.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    const linkText = (a.innerText || a.textContent || "").trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    if (seenLinks.has(href)) return;
    seenLinks.add(href);
    links.push({ href, text: linkText.substring(0, 100) });
  });
  
  return {
    title: (title || "").trim(),
    markdown: markdown.trim(),
    text: text.substring(0, 10000), // cap plain text at 10k chars
    metadata,
    links: links.slice(0, 200), // cap at 200 links
    url: window.location.href,
  };
})()
`;
