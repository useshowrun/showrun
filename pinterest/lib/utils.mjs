/**
 * Shared utilities for Pinterest scrapers.
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

export async function createPinterestBrowser(Camoufox) {
  return Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });
}

export async function createPinterestContext(browser) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Load Pinterest cookies if provided via env var
  const cookiesJson = process.env.PT_COOKIES;
  if (cookiesJson) {
    try {
      const cookies = JSON.parse(cookiesJson);
      await context.addCookies(
        cookies.map((c) => ({ ...c, domain: c.domain || ".pinterest.com" }))
      );
      log("Loaded PT_COOKIES");
    } catch (e) {
      log(`PT_COOKIES parse error: ${e.message}`);
    }
  }

  return context;
}

// ---------------------------------------------------------------------------
// Parse a Pinterest pin from BaseSearchResource result
// ---------------------------------------------------------------------------

export function parsePin(result) {
  if (!result || result.type !== "pin") return null;

  const images = result.images || {};
  const imageUrl =
    images.orig?.url ||
    images["736x"]?.url ||
    images["474x"]?.url ||
    null;

  const thumbnailUrl =
    images["236x"]?.url ||
    images["170x"]?.url ||
    null;

  const pinner = result.pinner || {};
  const board = result.board || {};
  const boardOwner = board.owner || {};

  return {
    id: result.id || result.node_id || null,
    title: result.title || result.grid_title || null,
    description: result.description?.trim() || result.seo_alt_text?.trim() || null,
    link: result.link || null,
    domain: result.domain || null,
    imageUrl,
    thumbnailUrl,
    dominantColor: result.dominant_color || null,
    createdAt: result.created_at || null,
    saves: result.saves || null,
    reactionCount: result.reaction_counts
      ? Object.values(result.reaction_counts).reduce((a, b) => a + (b || 0), 0)
      : null,
    pinner: pinner.username
      ? {
          username: pinner.username,
          fullName: pinner.full_name || null,
          profileUrl: `https://www.pinterest.com/${pinner.username}/`,
        }
      : null,
    board: board.name
      ? {
          name: board.name,
          pinCount: board.pin_count || null,
          url: boardOwner.username
            ? `https://www.pinterest.com/${boardOwner.username}/${board.id ? "" : ""}`
            : null,
        }
      : null,
    isPromoted: result.is_promoted || false,
    pinUrl: result.id ? `https://www.pinterest.com/pin/${result.id}/` : null,
  };
}
