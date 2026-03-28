#!/usr/bin/env node

/**
 * Fetch M&A comparable transactions for a company from Pitchbook.
 *
 * Usage:
 *   node pitchbook-mna-comps.mjs auth              # capture session from Chrome
 *   node pitchbook-mna-comps.mjs comps <pbId>       # fetch M&A comps for a company
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
// Comps
// ---------------------------------------------------------------------------

async function doComps(pbId) {
  const auth = await getAuth();
  checkCurl();
  console.log(`Fetching M&A comps for pbId: ${pbId}`);

  const url = `https://my.pitchbook.com/web-api/dashboard-platform-service/v2/private/mergers-and-acquisitions/comps?pbId=${pbId}`;
  const referer = 'https://my.pitchbook.com/dashboard/private';

  const result = await curlGet(url, auth, referer);

  const outFile = resolve(CACHE_DIR, `mna-comps-${pbId}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary
  const items = result.data || [];
  console.log(`\nFound ${items.length} comparable M&A transaction(s):`);
  for (const item of items) {
    const company = item.company;
    if (company) {
      console.log(`  ${company.name || '?'} — ID: ${company.pbId || '?'} (type: ${company.type || '?'})`);
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
  case 'comps': {
    const pbId = positional[0];
    if (!pbId) {
      console.error('Usage: node pitchbook-mna-comps.mjs comps <pbId>');
      process.exit(1);
    }
    await doComps(pbId);
    break;
  }
  default:
    console.log(`pitchbook-mna-comps

Fetch M&A comparable transactions for a company from Pitchbook.

Commands:
  auth                          Capture session from Chrome via CDP
  comps <pbId>                  Fetch M&A comps for a company

Examples:
  node pitchbook-mna-comps.mjs comps 46488-07
  node pitchbook-mna-comps.mjs comps 434438-06`);
}
