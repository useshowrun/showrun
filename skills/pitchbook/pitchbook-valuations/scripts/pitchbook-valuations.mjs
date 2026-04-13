#!/usr/bin/env node

/**
 * Fetch recent deal multiples / valuations from Pitchbook.
 *
 * Usage:
 *   node pitchbook-valuations.mjs auth                         # capture session from Chrome
 *   node pitchbook-valuations.mjs multiples                    # default 365-day trailing
 *   node pitchbook-valuations.mjs multiples --days=730
 *   node pitchbook-valuations.mjs multiples --verticals=X --locations=X
 */

import { resolve } from 'path';
import {
  CACHE_DIR,
  getAuth,
  checkCurl,
  doCdpAuth,
  curlPost,
  saveJson,
  parseFlags,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Multiples
// ---------------------------------------------------------------------------

function fmtMultiple(v) {
  if (v == null) return 'N/A';
  return `${Number(v).toFixed(1)}x`;
}

async function doMultiples({ days = 365, verticals = [], dealTypes = [], locations = [], gecsIndustries = [] } = {}) {
  const auth = await getAuth();
  checkCurl();
  console.log(`Fetching deal multiples (trailing ${days} days)...`);

  const payload = {
    verticals,
    dealTypes,
    locations,
    gecsIndustries,
    trailingRange: days,
  };

  const result = await curlPost(
    'https://my.pitchbook.com/web-api/dashboard-platform-service/v2/private/valuations/recent-deal-multiples',
    auth,
    payload,
    'https://my.pitchbook.com/dashboard/private',
  );

  const outFile = resolve(CACHE_DIR, `valuations-${Date.now()}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary
  const rows = result.data || [];
  if (rows.length === 0) {
    console.log('\nNo data returned.');
    return result;
  }

  console.log('\nYear  | Deals | EV/EBITDA | EV/Revenue');
  console.log('------+-------+-----------+-----------');
  for (const r of rows) {
    const year = String(r.year ?? '?').padEnd(5);
    const deals = String(r.dealCount ?? '?').padStart(5);
    const ebitda = fmtMultiple(r.valuationEbitdaMedian).padStart(9);
    const revenue = fmtMultiple(r.valuationRevenueMedian).padStart(10);
    console.log(`${year} | ${deals} | ${ebitda} | ${revenue}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function splitList(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

const [,, command, ...args] = process.argv;
const { flags } = parseFlags(args);

switch (command) {
  case 'auth': {
    const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL || 'http://localhost:9222';
    await doCdpAuth(cdpUrl);
    break;
  }
  case 'multiples': {
    const days = parseInt(flags.days || '365', 10);
    const verticals = splitList(flags.verticals);
    const dealTypes = splitList(flags['deal-types']);
    const locations = splitList(flags.locations);
    await doMultiples({ days, verticals, dealTypes, locations });
    break;
  }
  default:
    console.log(`pitchbook-valuations

Fetch recent deal multiples and valuations from Pitchbook.

Commands:
  auth                                        Capture session from Chrome via CDP
  multiples [--days=365] [--verticals=X] [--locations=X]
                                                Fetch deal multiples

Examples:
  node pitchbook-valuations.mjs multiples
  node pitchbook-valuations.mjs multiples --days=730
  node pitchbook-valuations.mjs multiples --verticals=SAAS`);
}
