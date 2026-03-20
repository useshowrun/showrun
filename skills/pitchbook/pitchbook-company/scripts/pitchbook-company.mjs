#!/usr/bin/env node

/**
 * Fetch a full Pitchbook company profile (6 endpoints).
 *
 * Usage:
 *   node pitchbook-company.mjs <companyId>
 */

import {
  loadSession,
  isSessionValid,
  curlGet,
  SessionExpiredError,
  delay,
  emitResult,
  emitError,
  log,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const companyId = process.argv[2];
if (!companyId) {
  emitError("MISSING_ARG", "Usage: node pitchbook-company.mjs <companyId>");
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const BASE = "https://my.pitchbook.com";
const REFERER = `${BASE}/profile/${companyId}/company/profile`;
const DELAY_MS = 6_000;

const ENDPOINTS = [
  {
    key: "generalInfo",
    url: `${BASE}/web-api/profiles/${companyId}/company/general-info`,
  },
  {
    key: "dealHistory",
    url: `${BASE}/web-api/deal-debt-experience-bff/companies/${companyId}/deal-history`,
  },
  {
    key: "currentTeam",
    url: `${BASE}/web-api/profiles/${companyId}/company/executives/current?page=1&pageSize=100`,
  },
  {
    key: "formerTeam",
    url: `${BASE}/web-api/profiles/${companyId}/company/executives/former?page=1&pageSize=100`,
  },
  {
    key: "currentBoardMembers",
    url: `${BASE}/web-api/profiles/${companyId}/company/board-members/current?page=1&pageSize=100`,
  },
  {
    key: "formerBoardMembers",
    url: `${BASE}/web-api/profiles/${companyId}/company/board-members/former?page=1&pageSize=100`,
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const session = loadSession();
  if (!isSessionValid(session)) {
    emitError("SESSION_EXPIRED", "No valid session. Run login/capture-headers first.");
  }

  log(`Fetching company profile for ${companyId} (6 endpoints, ~${ENDPOINTS.length * 6}s)`);

  const company = { companyId };

  for (let i = 0; i < ENDPOINTS.length; i++) {
    const { key, url } = ENDPOINTS[i];

    if (i > 0) {
      log(`Waiting ${DELAY_MS / 1000}s before next request...`);
      await delay(DELAY_MS);
    }

    log(`Fetching ${key}...`);

    try {
      company[key] = curlGet(url, session, REFERER);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        emitError("SESSION_EXPIRED", `Session expired while fetching ${key}: ${err.message}`);
      }
      log(`Error fetching ${key}: ${err.message}`);
      company[key] = null;
    }
  }

  emitResult(company);
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
