#!/usr/bin/env node

/**
 * Fetch a quick company hover summary from Pitchbook by pbId.
 *
 * Usage:
 *   node pitchbook-hover.mjs auth              # capture session from Chrome
 *   node pitchbook-hover.mjs get <pbId>         # fetch hover card for company
 */

import { resolve } from 'path';
import {
  CACHE_DIR,
  getAuth,
  checkCurl,
  doCdpAuth,
  curlGet,
  saveJson,
  parseFlags,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

function doGet(pbId) {
  const auth = getAuth();
  checkCurl();
  console.log(`Fetching hover card for pbId: ${pbId}`);

  const url = `https://my.pitchbook.com/web-api/entity-hover-platform-service/company/${pbId}`;
  const result = curlGet(url, auth, 'https://my.pitchbook.com/dashboard/private');

  const outFile = resolve(CACHE_DIR, `hover-${pbId}.json`);
  saveJson(outFile, result);
  console.log(`Saved to: ${outFile}`);

  // Print summary
  const name = result.entityName?.name || result.officialName || '?';
  const symbol = result.entityName?.symbol;
  const exchange = result.entityName?.stockExchange;
  const ticker = symbol ? ` (${exchange ? `${exchange}:` : ''}${symbol})` : '';

  console.log(`\n--- ${name}${ticker} ---`);

  if (result.description) {
    const desc = result.description.length > 200
      ? result.description.slice(0, 200) + '...'
      : result.description;
    console.log(`Description: ${desc}`);
  }

  if (result.location)         console.log(`Location: ${result.location}`);
  if (result.website)          console.log(`Website: ${result.website}`);
  if (result.primaryIndustry)  console.log(`Industry: ${result.primaryIndustry}`);
  if (result.gecsIndustry)     console.log(`GECS Industry: ${result.gecsIndustry}`);
  if (result.businessStatus)   console.log(`Status: ${result.businessStatus}`);
  if (result.financingStatus)  console.log(`Financing: ${result.financingStatus}`);
  if (result.ownershipStatus)  console.log(`Ownership: ${result.ownershipStatus}`);
  if (result.lastFinancingDate) console.log(`Last Financing: ${result.lastFinancingDate}`);

  const verticals = result.verticals || [];
  if (verticals.length) console.log(`Verticals: ${verticals.join(', ')}`);

  const investors = result.activeInvestors || [];
  if (investors.length) {
    console.log(`\nActive Investors (${investors.length}):`);
    for (const inv of investors) {
      console.log(`  ${inv.name || '?'} — ${inv.type || '?'} (${inv.pbId || '?'})`);
    }
  }

  const formerInvestors = result.formerInvestors || [];
  if (formerInvestors.length) {
    console.log(`Former Investors: ${formerInvestors.length}`);
  }

  if (result.countOfCompetitors != null) {
    console.log(`Competitors: ${result.countOfCompetitors}`);
  }

  return result;
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
    const pbId = positional[0];
    if (!pbId) {
      console.error('Usage: node pitchbook-hover.mjs get <pbId>');
      process.exit(1);
    }
    doGet(pbId);
    break;
  }
  default:
    console.log(`pitchbook-hover

Fetch a quick company hover summary from Pitchbook.

Commands:
  auth                  Capture session from Chrome via CDP
  get <pbId>            Fetch hover card for a company

Examples:
  node pitchbook-hover.mjs get 12345-67
  node pitchbook-hover.mjs auth`);
}
