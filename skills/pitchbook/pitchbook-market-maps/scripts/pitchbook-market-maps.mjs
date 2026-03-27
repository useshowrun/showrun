#!/usr/bin/env node

/**
 * Fetch published market maps from Pitchbook.
 *
 * Usage:
 *   node pitchbook-market-maps.mjs auth                          # capture session from Chrome
 *   node pitchbook-market-maps.mjs list                          # list published market maps
 *   node pitchbook-market-maps.mjs list --verticals=AI           # filter by vertical
 *   node pitchbook-market-maps.mjs list --verticals=AI,FT        # filter by verticals
 *   node pitchbook-market-maps.mjs list --locations=US           # filter by location
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
// List published market maps
// ---------------------------------------------------------------------------

function listMarketMaps({ verticals = [], dealTypes = [], locations = [] } = {}) {
  const auth = getAuth();
  checkCurl();
  console.log('Fetching published market maps from Pitchbook...');

  const payload = {
    dealTypes,
    locations,
    verticals,
  };

  const result = curlPost(
    'https://my.pitchbook.com/web-api/market-map-bff/api/v1/market-map-dashboard/published',
    auth,
    payload,
    'https://my.pitchbook.com/dashboard/private',
  );

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = resolve(CACHE_DIR, `market-maps-${ts}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary — handle both array and object responses
  if (Array.isArray(result)) {
    console.log(`\nFound ${result.length} market map(s):`);
    for (const item of result) {
      const name = item.name || item.title || item.mapName || JSON.stringify(item).slice(0, 80);
      console.log(`  - ${name}`);
    }
  } else if (result && typeof result === 'object') {
    const keys = Object.keys(result);
    console.log(`\nResponse keys: ${keys.join(', ')}`);
    for (const key of keys) {
      const val = result[key];
      if (Array.isArray(val)) {
        console.log(`  ${key}: ${val.length} item(s)`);
        for (const item of val.slice(0, 10)) {
          const name = item.name || item.title || item.mapName || JSON.stringify(item).slice(0, 80);
          console.log(`    - ${name}`);
        }
        if (val.length > 10) console.log(`    ... and ${val.length - 10} more`);
      } else {
        console.log(`  ${key}: ${JSON.stringify(val).slice(0, 100)}`);
      }
    }
  } else {
    console.log('\nUnexpected response format:', typeof result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvToArray(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
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
  case 'list': {
    listMarketMaps({
      verticals: csvToArray(flags.verticals),
      dealTypes: csvToArray(flags['deal-types']),
      locations: csvToArray(flags.locations),
    });
    break;
  }
  default:
    console.log(`pitchbook-market-maps

Fetch published market maps from Pitchbook.

Commands:
  auth                                    Capture session from Chrome via CDP
  list [--verticals=X] [--locations=X]
                                          List published market maps

Examples:
  node pitchbook-market-maps.mjs auth
  node pitchbook-market-maps.mjs list
  node pitchbook-market-maps.mjs list --verticals=AI
  node pitchbook-market-maps.mjs list --verticals=AI --locations=gUS`);
}
