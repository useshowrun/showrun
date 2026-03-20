#!/usr/bin/env node

/**
 * Search Pitchbook for a company by domain, name, or any search term.
 *
 * Usage:
 *   node pitchbook-search.mjs <query>
 */

import {
  loadSession,
  isSessionValid,
  curlPost,
  SessionExpiredError,
  emitResult,
  emitError,
  log,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const query = process.argv[2];
if (!query) {
  emitError("MISSING_ARG", "Usage: node pitchbook-search.mjs <query>");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const session = loadSession();
  if (!isSessionValid(session)) {
    emitError("SESSION_EXPIRED", "No valid session. Run login/capture-headers first.");
  }

  log("Searching Pitchbook for:", query);

  const payload = {
    searchRequest: {
      limit: 5,
      offset: 0,
      query,
    },
    timeZoneOffset: "+00:00",
    excludeProhibitedWords: true,
  };

  try {
    const result = curlPost(
      "https://my.pitchbook.com/web-api/general-search/search/mixed",
      session,
      payload,
      "https://my.pitchbook.com/dashboard/private"
    );

    emitResult(result);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      emitError("SESSION_EXPIRED", err.message);
    }
    throw err;
  }
}

main();
