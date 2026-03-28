#!/usr/bin/env node

/**
 * Fetch active investors from Pitchbook.
 *
 * Usage:
 *   node pitchbook-investors.mjs auth                          # capture session from Chrome
 *   node pitchbook-investors.mjs active                        # fetch active investors (default 365 days)
 *   node pitchbook-investors.mjs active --days=30              # trailing range in days
 *   node pitchbook-investors.mjs active --verticals=VC,PE      # filter by verticals
 *   node pitchbook-investors.mjs active --asset-class=VENTURE_CAPITAL  # filter by asset class
 *   node pitchbook-investors.mjs active --locations=US         # filter by locations
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
// Active Investors
// ---------------------------------------------------------------------------

async function fetchActiveInvestors({ days = 365, verticals = [], assetClasses = [], dealTypes = [], locations = [] } = {}) {
  const auth = await getAuth();
  checkCurl();

  const trailingRange = parseInt(days, 10);
  console.log(`Fetching active investors (trailing ${trailingRange} days)...`);

  const payload = {
    assetClasses,
    verticals,
    dealTypes,
    locations,
    gecsIndustries: [],
    trailingRange,
    resolvedFilter: {
      verticals,
      dealTypes,
      locations,
      gecsIndustries: [],
      trailingRange,
    },
  };

  const result = await curlPost(
    'https://my.pitchbook.com/web-api/dashboard-platform-service/v2/private/investors-and-acquirers/ACTIVE_INVESTORS',
    auth,
    payload,
    'https://my.pitchbook.com/dashboard/private',
  );

  const timestamp = Date.now();
  const outFile = resolve(CACHE_DIR, `active-investors-${timestamp}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary
  const items = result.data || [];
  console.log(`\nFound ${items.length} active investor(s):`);
  for (const item of items) {
    const inv = item.investor || {};
    const name = inv.name || '?';
    const count = item.investmentsCount ?? '?';
    const lastDate = item.lastInvestmentDate || '?';
    console.log(`  ${name} — ${count} investments, last: ${lastDate}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

function splitCsv(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

switch (command) {
  case 'auth': {
    const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL || 'http://localhost:9222';
    await doCdpAuth(cdpUrl);
    break;
  }
  case 'active': {
    await fetchActiveInvestors({
      days: flags.days || '365',
      verticals: splitCsv(flags.verticals),
      assetClasses: splitCsv(flags['asset-class']),
      dealTypes: splitCsv(flags['deal-types']),
      locations: splitCsv(flags.locations),
    });
    break;
  }
  default:
    console.log(`pitchbook-investors

Fetch active investors from Pitchbook.

Commands:
  auth                                     Capture session from Chrome via CDP
  active [options]                         Fetch active investors

Options for 'active':
  --days=365          Trailing range in days (default: 365)
  --verticals=VC,PE   Filter by verticals (comma-separated)
  --asset-class=VENTURE_CAPITAL  Filter by asset class (comma-separated)
  --locations=US      Filter by locations (comma-separated)

Examples:
  node pitchbook-investors.mjs active
  node pitchbook-investors.mjs active --days=30
  node pitchbook-investors.mjs active --verticals=VC,PE --locations=US`);
}
