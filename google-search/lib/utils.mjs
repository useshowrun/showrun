// ---------------------------------------------------------------------------
// Shared utilities for Google Search scraper skills
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
// Parse a result count string like "About 1,230,000,000 results" → number
// ---------------------------------------------------------------------------

export function parseResultCount(text) {
  if (!text) return null;
  // "About 1,230,000,000 results (0.52 seconds)"
  const m = text.match(/[\d,]+/);
  if (!m) return null;
  return parseInt(m[0].replace(/,/g, ""), 10);
}

// ---------------------------------------------------------------------------
// Clean a displayed URL (e.g. "example.com › page › subpage")
// ---------------------------------------------------------------------------

export function cleanDisplayUrl(text) {
  if (!text) return null;
  return text.trim().replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Extract domain from a URL string
// ---------------------------------------------------------------------------

export function extractDomain(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse sitelinks list from a result card
// ---------------------------------------------------------------------------

export function parseSitelinks(container) {
  const links = [];
  // Sitelinks are typically in table cells or styled list items
  const cells = container.querySelectorAll("table td, [role='listitem']");
  for (const cell of cells) {
    const a = cell.querySelector("a[href]");
    if (!a) continue;
    const url = a.href;
    const title = a.innerText.trim();
    if (url && title) links.push({ title, url });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Check if Google returned a CAPTCHA / unusual traffic page
// ---------------------------------------------------------------------------

export function isCaptchaPage(title, url) {
  const titleLower = (title || "").toLowerCase();
  const urlLower = (url || "").toLowerCase();
  return (
    titleLower.includes("unusual traffic") ||
    titleLower.includes("captcha") ||
    urlLower.includes("/sorry/") ||
    urlLower.includes("recaptcha")
  );
}
