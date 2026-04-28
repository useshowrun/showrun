#!/usr/bin/env node
// itch-auth.mjs — bootstrap itch.io session from the live Chrome tab.
//
// Usage: node itch-auth.mjs
// Requires: Chrome running with remote-debug, an itch.io tab logged in.

import { doAuth } from '../../lib/itch-lib.mjs';

doAuth().catch((e) => {
  console.error(`itch-auth failed: ${e.message}`);
  process.exit(1);
});
