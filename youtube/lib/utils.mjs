// ---------------------------------------------------------------------------
// Shared utilities for YouTube scraper skills
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
// Extract ytInitialData or ytInitialPlayerResponse from inline page scripts.
// These variables are declared with `var` in inline <script> tags but may not
// be accessible via window.* in Firefox due to script scoping. We extract
// the JSON directly by parsing the script text.
// ---------------------------------------------------------------------------

export async function extractPageJson(page, varName) {
  return page.evaluate((name) => {
    const scripts = Array.from(document.querySelectorAll("script:not([src])"));
    for (const script of scripts) {
      const text = script.textContent;
      const prefix = `var ${name} =`;
      if (!text.includes(prefix)) continue;

      const start = text.indexOf(prefix) + prefix.length;
      let i = start;
      // Skip whitespace
      while (i < text.length && text[i] === " ") i++;
      // Must start with {
      if (text[i] !== "{") continue;

      const jsonStart = i;
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            return text.slice(jsonStart, i + 1);
          }
        }
      }
    }
    return null;
  }, varName);
}

// ---------------------------------------------------------------------------
// Parse subscriber count text like "25.9M subscribers" → 25900000
// ---------------------------------------------------------------------------

export function parseSubCount(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*([KMBkm]?)\s*subscriber/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
  return Math.round(n * multiplier);
}

// ---------------------------------------------------------------------------
// Parse view/like count text like "41,218 views" or "1.7B" → number
// ---------------------------------------------------------------------------

export function parseCount(text) {
  if (!text) return null;
  // "41,218 views"
  const cleaned = text.replace(/,/g, "").replace(/\s.*/g, "");
  const m = cleaned.match(/([\d.]+)\s*([KMBkm]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
  return Math.round(n * multiplier);
}

// ---------------------------------------------------------------------------
// Extract best thumbnail URL from thumbnails array
// ---------------------------------------------------------------------------

export function bestThumbnail(thumbnails) {
  if (!thumbnails || thumbnails.length === 0) return null;
  // Prefer higher resolution (larger width)
  return thumbnails.reduce((best, t) =>
    (t.width || 0) > (best.width || 0) ? t : best,
    thumbnails[0]
  ).url;
}

// ---------------------------------------------------------------------------
// Extract text from a "runs" array: [{text: "..."}, ...]
// ---------------------------------------------------------------------------

export function runsText(obj) {
  if (!obj) return null;
  if (typeof obj === "string") return obj;
  if (obj.simpleText) return obj.simpleText;
  if (obj.runs) return obj.runs.map((r) => r.text).join("");
  return null;
}

// ---------------------------------------------------------------------------
// Handle YouTube consent cookie
// ---------------------------------------------------------------------------

export async function addConsentCookies(context) {
  await context.addCookies([
    {
      name: "SOCS",
      value: "CAESEwgDEgk2NjM4NTQ5NDYaAmVuIAEaBgiAoJ-1Bg",
      domain: ".youtube.com",
      path: "/",
    },
    {
      name: "SOCS",
      value: "CAESEwgDEgk2NjM4NTQ5NDYaAmVuIAEaBgiAoJ-1Bg",
      domain: ".google.com",
      path: "/",
    },
  ]);
}

// ---------------------------------------------------------------------------
// Parse a channel URL / handle into candidate URL list to try
// Accepts: @handle, UCxxxxxx channelId, /user/legacyName, /c/customName, full URLs
// ---------------------------------------------------------------------------

export function resolveChannelUrls(input) {
  input = input.trim();

  // Already a full URL
  if (input.startsWith("https://") || input.startsWith("http://")) {
    const url = new URL(input);
    // Normalize to remove /featured, /about, etc.
    const parts = url.pathname.split("/").filter(Boolean);
    const base = parts.length >= 2
      ? `https://www.youtube.com/${parts[0]}/${parts[1]}`
      : `https://www.youtube.com${url.pathname}`;
    return [base + "/videos", base];
  }

  // Channel ID (starts with UC and is 24 chars)
  if (/^UC[A-Za-z0-9_-]{22}$/.test(input)) {
    return [
      `https://www.youtube.com/channel/${input}/videos`,
      `https://www.youtube.com/channel/${input}`,
    ];
  }

  // @handle format
  if (input.startsWith("@")) {
    const handle = input.slice(1);
    return [
      `https://www.youtube.com/@${handle}/videos`,
      `https://www.youtube.com/user/${handle}/videos`,
      `https://www.youtube.com/c/${handle}/videos`,
      `https://www.youtube.com/@${handle}`,
      `https://www.youtube.com/user/${handle}`,
    ];
  }

  // Plain name — try all formats
  return [
    `https://www.youtube.com/user/${input}/videos`,
    `https://www.youtube.com/c/${input}/videos`,
    `https://www.youtube.com/@${input}/videos`,
    `https://www.youtube.com/user/${input}`,
    `https://www.youtube.com/c/${input}`,
  ];
}
