#!/usr/bin/env node

/**
 * Fetch recent deals from Pitchbook's deal feed.
 *
 * Usage:
 *   node pitchbook-deal-feed.mjs auth                          # capture session from Chrome
 *   node pitchbook-deal-feed.mjs feed                          # fetch recent deals
 *   node pitchbook-deal-feed.mjs feed --limit=10 --days=365
 *   node pitchbook-deal-feed.mjs feed --verticals=VC,PE --asset-class=VENTURE_CAPITAL --locations=US
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
// Deal Feed
// ---------------------------------------------------------------------------

async function fetchDealFeed({ limit = 10, days = 365, verticals = [], assetClasses = [], dealTypes = [], locations = [] }) {
  const auth = await getAuth();
  checkCurl();
  console.log(`Fetching recent deals (limit=${limit}, days=${days})`);

  const payload = {
    assetClasses,
    verticals,
    dealTypes,
    locations,
    gecsIndustries: [],
    trailingRange: days,
    resolvedFilter: {
      verticals,
      dealTypes,
      locations,
      gecsIndustries: [],
      trailingRange: days,
    },
  };

  const url = `https://my.pitchbook.com/web-api/dashboard-platform-service/v3/private/data-sourcing/recent-deals?limit=${limit}`;

  const result = await curlPost(
    url,
    auth,
    payload,
    'https://my.pitchbook.com/dashboard/private',
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = resolve(CACHE_DIR, `deal-feed-${timestamp}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary
  const deals = Array.isArray(result) ? result : (result.deals || result.results || []);
  console.log(`\nFound ${deals.length} deal(s):`);
  for (const deal of deals) {
    const companyName = deal.company?.name || '?';
    const dealType = deal.dealType || '?';
    const date = deal.lastFinancingDate || '?';
    const sizeObj = deal.lastFinancingSize;
    const size = sizeObj && sizeObj.amount != null
      ? `${sizeObj.currency || ''} ${Number(sizeObj.amount).toLocaleString()}`
      : 'undisclosed';
    console.log(`  ${companyName} -- ${dealType} -- ${date} -- ${size}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;
const { flags } = parseFlags(args);

switch (command) {
  case 'auth': {
    const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL || 'http://localhost:9222';
    await doCdpAuth(cdpUrl);
    break;
  }
  case 'feed': {
    const limit = parseInt(flags.limit || '10', 10);
    const days = parseInt(flags.days || '365', 10);
    const verticals = flags.verticals ? flags.verticals.split(',') : [];
    const assetClasses = flags['asset-class'] ? flags['asset-class'].split(',') : [];
    const dealTypes = flags['deal-types'] ? flags['deal-types'].split(',') : [];
    const locations = flags.locations ? flags.locations.split(',') : [];
    await fetchDealFeed({ limit, days, verticals, assetClasses, dealTypes, locations });
    break;
  }
  default:
    console.log(`pitchbook-deal-feed

Fetch recent deals from Pitchbook's deal feed.

Commands:
  auth                                    Capture session from Chrome via CDP
  feed [options]                          Fetch recent deals

Options for feed:
  --limit=10                              Number of deals to fetch (default: 10)
  --days=365                              Trailing range in days (default: 365)
  --verticals=VC,PE                       Filter by verticals (comma-separated)
  --asset-class=VENTURE_CAPITAL            Filter by asset class (comma-separated)
  --locations=US,UK                       Filter by locations (comma-separated)

Examples:
  node pitchbook-deal-feed.mjs feed
  node pitchbook-deal-feed.mjs feed --limit=5 --days=30
  node pitchbook-deal-feed.mjs feed --verticals=VC --asset-class=VENTURE_CAPITAL --locations=US`);
}
