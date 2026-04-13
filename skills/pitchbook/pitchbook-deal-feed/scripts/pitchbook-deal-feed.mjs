#!/usr/bin/env node

/**
 * Fetch recent deals from Pitchbook's deal feed.
 *
 * Usage:
 *   node pitchbook-deal-feed.mjs feed                                     # fetch recent deals
 *   node pitchbook-deal-feed.mjs feed --limit=10 --days=30
 *   node pitchbook-deal-feed.mjs feed --asset-class=VENTURE_CAPITAL       # auto-populates dealTypes
 *   node pitchbook-deal-feed.mjs feed --deal-types=vc-early               # preset: pre-seed to Series A
 *   node pitchbook-deal-feed.mjs feed --verticals=AIML,FT --locations=gUS
 *   node pitchbook-deal-feed.mjs auth                                     # capture session from Chrome
 *
 * Filter codes are in filter-codes.json (same directory as SKILL.md).
 */

import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
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
// Load filter codes reference
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const filterCodes = JSON.parse(readFileSync(resolve(SCRIPT_DIR, '../filter-codes.json'), 'utf8'));

/**
 * Resolve deal type codes and asset classes from presets.
 * When an asset class is selected but no explicit dealTypes are given,
 * auto-populate with all dealTypes for that asset class (matching the UI behavior).
 * When a preset implies an asset class, auto-set it.
 */
function resolveFilters(assetClasses, dealTypesRaw) {
  const resolvedAssetClasses = [...assetClasses];
  let resolvedDealTypes = [];

  if (dealTypesRaw.length > 0) {
    for (const dt of dealTypesRaw) {
      const preset = filterCodes.presets?.[dt];
      if (preset) {
        if (preset._codes) {
          resolvedDealTypes.push(...preset._codes);
        }
        if (preset._assetClass) {
          const allCodes = filterCodes.dealTypes?.[preset._assetClass]?._allCodes;
          if (allCodes) resolvedDealTypes.push(...allCodes);
          if (!resolvedAssetClasses.includes(preset._assetClass)) {
            resolvedAssetClasses.push(preset._assetClass);
          }
        }
        // Auto-set asset class for vc-* presets
        if (dt.startsWith('vc-') && !resolvedAssetClasses.includes('VENTURE_CAPITAL')) {
          resolvedAssetClasses.push('VENTURE_CAPITAL');
        }
        if (dt.startsWith('mna-') && !resolvedAssetClasses.includes('MNA')) {
          resolvedAssetClasses.push('MNA');
        }
        if (dt.startsWith('pe-') && !resolvedAssetClasses.includes('PRIVATE_EQUITY')) {
          resolvedAssetClasses.push('PRIVATE_EQUITY');
        }
      } else {
        resolvedDealTypes.push(dt);
      }
    }
    resolvedDealTypes = [...new Set(resolvedDealTypes)];
  } else if (resolvedAssetClasses.length > 0) {
    // No explicit dealTypes — auto-populate from asset classes
    for (const ac of resolvedAssetClasses) {
      const allCodes = filterCodes.dealTypes?.[ac]?._allCodes;
      if (allCodes) resolvedDealTypes.push(...allCodes);
    }
    resolvedDealTypes = [...new Set(resolvedDealTypes)];
  }

  return { assetClasses: resolvedAssetClasses, dealTypes: resolvedDealTypes };
}

// ---------------------------------------------------------------------------
// Deal Feed
// ---------------------------------------------------------------------------

async function fetchDealFeed({ limit = 10, days = 365, verticals = [], assetClasses = [], dealTypes = [], locations = [] }) {
  const auth = await getAuth();
  checkCurl();

  // Resolve dealTypes and asset classes from presets
  const resolved = resolveFilters(assetClasses, dealTypes);

  console.log(`Fetching recent deals (limit=${limit}, days=${days})`);
  if (resolved.assetClasses.length) console.log(`  Asset classes: ${resolved.assetClasses.join(', ')}`);
  if (resolved.dealTypes.length) console.log(`  Deal types: ${resolved.dealTypes.length} codes`);
  if (verticals.length) console.log(`  Verticals: ${verticals.join(', ')}`);
  if (locations.length) console.log(`  Locations: ${locations.join(', ')}`);

  const payload = {
    assetClasses: resolved.assetClasses,
    verticals,
    dealTypes: resolved.dealTypes,
    locations,
    gecsIndustries: [],
    trailingRange: days,
    resolvedFilter: {
      verticals,
      dealTypes: resolved.dealTypes,
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
    await doCdpAuth();
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
  --asset-class=VENTURE_CAPITAL           Filter by asset class (auto-populates deal types)
  --deal-types=vc-early                   Filter by deal type preset or raw codes
  --verticals=AIML,FT                     Filter by verticals (comma-separated codes)
  --locations=gUS,sCA                     Filter by locations (comma-separated codes)

Asset classes: VENTURE_CAPITAL, MNA, PRIVATE_EQUITY

Deal type presets (use with --deal-types):
  vc-all          All VC deal types
  vc-early        Pre-seed through Series A
  vc-late         Series B+ and later stage
  vc-seed         Seed and pre-seed only
  vc-series-a     Series A only
  mna-all         All M&A deal types
  pe-all          All PE deal types

Or pass raw codes: --deal-types=SEED,EVC,EVC_A,EVC_B,A

Full filter code reference: see filter-codes.json

Examples:
  node pitchbook-deal-feed.mjs feed --limit=20 --days=14 --deal-types=vc-early
  node pitchbook-deal-feed.mjs feed --asset-class=VENTURE_CAPITAL --verticals=AIML
  node pitchbook-deal-feed.mjs feed --deal-types=SEED,EVC,A --locations=gUS --days=30
  node pitchbook-deal-feed.mjs feed --asset-class=MNA --locations=gEu`);
}
