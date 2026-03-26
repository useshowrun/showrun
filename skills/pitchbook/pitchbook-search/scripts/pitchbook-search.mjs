#!/usr/bin/env node

/**
 * Search Pitchbook for companies by domain, name, or any search term.
 *
 * Usage:
 *   node pitchbook-search.mjs auth                 # capture session from Chrome
 *   node pitchbook-search.mjs search <query>        # search companies
 *   node pitchbook-search.mjs search <query> --limit=10
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
// Search
// ---------------------------------------------------------------------------

function doSearch(query, limit = 5) {
  const auth = getAuth();
  checkCurl();
  console.log(`Searching Pitchbook for: ${query}`);

  const payload = {
    searchRequest: { limit, offset: 0, query },
    timeZoneOffset: '+00:00',
    excludeProhibitedWords: true,
  };

  const result = curlPost(
    'https://my.pitchbook.com/web-api/general-search/search/mixed',
    auth,
    payload,
    'https://my.pitchbook.com/dashboard/private',
  );

  const outFile = resolve(CACHE_DIR, `search-${query.replace(/[^a-zA-Z0-9.-]/g, '_')}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary
  const items = result.items || [];
  console.log(`\nFound ${items.length} result(s):`);
  for (const item of items) {
    const pr = item.value?.profileResult;
    if (pr) {
      console.log(`  ${pr.name || '?'} — ID: ${pr.id || '?'} (${item.matchParams?.matchType || '?'})`);
    }
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
  case 'search': {
    const query = positional[0];
    if (!query) {
      console.error('Usage: node pitchbook-search.mjs search <query> [--limit=5]');
      process.exit(1);
    }
    const limit = parseInt(flags.limit || '5', 10);
    doSearch(query, limit);
    break;
  }
  default:
    console.log(`pitchbook-search

Search Pitchbook for companies by domain, name, or keyword.

Commands:
  auth                          Capture session from Chrome via CDP
  search <query> [--limit=5]    Search companies

Examples:
  node pitchbook-search.mjs search openai.com
  node pitchbook-search.mjs search "Stripe Inc" --limit=10
  node pitchbook-search.mjs search anthropic`);
}
