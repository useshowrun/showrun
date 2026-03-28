#!/usr/bin/env node

/**
 * Fetch a full Pitchbook company profile (6 endpoints).
 *
 * Usage:
 *   node pitchbook-company.mjs auth                          # capture session
 *   node pitchbook-company.mjs get <companyId>                # fetch all sections
 *   node pitchbook-company.mjs get <companyId> --sections=generalInfo,dealHistory
 */

import { resolve } from 'path';
import {
  CACHE_DIR,
  getAuth,
  checkCurl,
  doCdpAuth,
  curlGet,
  saveJson,
  delay,
  parseFlags,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const BASE = 'https://my.pitchbook.com';
const DELAY_MS = 6_000;

function endpoints(companyId) {
  return [
    { key: 'generalInfo', url: `${BASE}/web-api/profiles/${companyId}/company/general-info` },
    { key: 'dealHistory', url: `${BASE}/web-api/deal-debt-experience-bff/companies/${companyId}/deal-history` },
    { key: 'currentTeam', url: `${BASE}/web-api/profiles/${companyId}/company/executives/current?page=1&pageSize=100` },
    { key: 'formerTeam', url: `${BASE}/web-api/profiles/${companyId}/company/executives/former?page=1&pageSize=100` },
    { key: 'currentBoardMembers', url: `${BASE}/web-api/profiles/${companyId}/company/board-members/current?page=1&pageSize=100` },
    { key: 'formerBoardMembers', url: `${BASE}/web-api/profiles/${companyId}/company/board-members/former?page=1&pageSize=100` },
  ];
}

const ALL_SECTIONS = ['generalInfo', 'dealHistory', 'currentTeam', 'formerTeam', 'currentBoardMembers', 'formerBoardMembers'];

// ---------------------------------------------------------------------------
// Fetch company
// ---------------------------------------------------------------------------

async function doGet(companyId, sections) {
  const auth = await getAuth();
  checkCurl();
  const referer = `${BASE}/profile/${companyId}/company/profile`;
  const selected = sections.length > 0 ? sections : ALL_SECTIONS;
  const eps = endpoints(companyId).filter(ep => selected.includes(ep.key));

  console.log(`Fetching company ${companyId} (${eps.length} endpoint(s), ~${eps.length * 6}s)`);

  const company = { companyId };

  for (let i = 0; i < eps.length; i++) {
    const { key, url } = eps[i];

    if (i > 0) {
      console.log(`Waiting ${DELAY_MS / 1000}s...`);
      await delay(DELAY_MS);
    }

    console.log(`Fetching ${key}...`);
    try {
      company[key] = await curlGet(url, auth, referer);
    } catch (err) {
      console.error(`Error fetching ${key}: ${err.message}`);
      company[key] = { error: err.message };
    }
  }

  const outFile = resolve(CACHE_DIR, `company-${companyId}.json`);
  saveJson(outFile, company);
  console.log(`\nCompany saved to: ${outFile}`);

  // Print summary
  if (company.generalInfo && !company.generalInfo.error) {
    const gi = company.generalInfo;
    const name = gi.companyName || gi.name || companyId;
    console.log(`  Name: ${name}`);
    if (gi.website) console.log(`  Website: ${gi.website}`);
    if (gi.description) console.log(`  Description: ${gi.description.substring(0, 120)}...`);
  }

  return company;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth': {
    const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL || 'http://localhost:9222';
    await doCdpAuth(cdpUrl);
    break;
  }
  case 'get': {
    const companyId = positional[0];
    if (!companyId) {
      console.error('Usage: node pitchbook-company.mjs get <companyId> [--sections=generalInfo,dealHistory]');
      process.exit(1);
    }
    const sections = flags.sections ? flags.sections.split(',').map(s => s.trim()) : [];
    await doGet(companyId, sections);
    break;
  }
  default:
    console.log(`pitchbook-company

Fetch a full company profile from Pitchbook by company ID.

Commands:
  auth                                          Capture session from Chrome via CDP
  get <companyId> [--sections=s1,s2,...]        Fetch company profile

Available sections:
  generalInfo, dealHistory, currentTeam, formerTeam,
  currentBoardMembers, formerBoardMembers

Examples:
  node pitchbook-company.mjs get 123456-78
  node pitchbook-company.mjs get 123456-78 --sections=generalInfo,dealHistory`);
}
