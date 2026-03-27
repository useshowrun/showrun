# Pitchbook Market Intelligence Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 7 new Pitchbook skills for market intelligence: deal-feed, advanced-search, mna-comps, investors, valuations, hover, and market-maps.

**Architecture:** Each skill follows the existing pitchbook pattern — a directory under `skills/pitchbook/` with `scripts/<name>.mjs` and `SKILL.md`. All skills import shared utilities from `../../lib/utils.mjs` (curlGet, curlPost, getAuth, checkCurl, saveJson, parseFlags, delay). Each script has a CLI with `auth` and one primary command. Testing is manual: run each command 3 times with 8s delays, re-auth on 401.

**Tech Stack:** Node.js 22+, curl with HTTP/2, shared `lib/utils.mjs`

---

## File Structure

```
skills/pitchbook/
├── lib/utils.mjs                                          # EXISTING — shared utils
├── pitchbook-deal-feed/
│   ├── SKILL.md                                           # CREATE
│   └── scripts/pitchbook-deal-feed.mjs                    # CREATE
├── pitchbook-mna-comps/
│   ├── SKILL.md                                           # CREATE
│   └── scripts/pitchbook-mna-comps.mjs                    # CREATE
├── pitchbook-investors/
│   ├── SKILL.md                                           # CREATE
│   └── scripts/pitchbook-investors.mjs                    # CREATE
├── pitchbook-valuations/
│   ├── SKILL.md                                           # CREATE
│   └── scripts/pitchbook-valuations.mjs                   # CREATE
├── pitchbook-hover/
│   ├── SKILL.md                                           # CREATE
│   └── scripts/pitchbook-hover.mjs                        # CREATE
├── pitchbook-market-maps/
│   ├── SKILL.md                                           # CREATE
│   └── scripts/pitchbook-market-maps.mjs                  # CREATE
├── pitchbook-advanced-search/
│   ├── SKILL.md                                           # CREATE
│   └── scripts/pitchbook-advanced-search.mjs              # CREATE
└── SKILL.md                                               # MODIFY — add new skills to table
```

---

### Task 1: pitchbook-deal-feed

**Files:**
- Create: `skills/pitchbook/pitchbook-deal-feed/scripts/pitchbook-deal-feed.mjs`
- Create: `skills/pitchbook/pitchbook-deal-feed/SKILL.md`

**Endpoint:** `POST /web-api/dashboard-platform-service/v3/private/data-sourcing/recent-deals?limit={limit}`

**Request body:**
```json
{
  "assetClasses": [],
  "verticals": [],
  "dealTypes": [],
  "locations": [],
  "gecsIndustries": [],
  "trailingRange": 365,
  "resolvedFilter": {
    "verticals": [],
    "dealTypes": [],
    "locations": [],
    "gecsIndustries": [],
    "trailingRange": 365
  }
}
```

**Response:** Array of deal objects: `{ company: { pbId, name, type }, dealSynopsis, lastFinancingDate, lastFinancingSize, totalRaised, dealType }`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/pitchbook/pitchbook-deal-feed/scripts
```

- [ ] **Step 2: Write pitchbook-deal-feed.mjs**

```javascript
#!/usr/bin/env node

/**
 * Fetch recent deals from Pitchbook dashboard.
 *
 * Usage:
 *   node pitchbook-deal-feed.mjs auth                        # capture session
 *   node pitchbook-deal-feed.mjs feed [--limit=10] [--days=365] [--verticals=VC,PE]
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

const BASE = 'https://my.pitchbook.com';
const REFERER = `${BASE}/dashboard/private`;

function doFeed(limit = 10, days = 365, verticals = [], dealTypes = [], locations = []) {
  const auth = getAuth();
  checkCurl();
  console.log(`Fetching recent deals (limit=${limit}, trailing=${days}d)`);

  const payload = {
    assetClasses: [],
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

  const result = curlPost(
    `${BASE}/web-api/dashboard-platform-service/v3/private/data-sourcing/recent-deals?limit=${limit}`,
    auth,
    payload,
    REFERER,
  );

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outFile = resolve(CACHE_DIR, `deal-feed-${ts}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary
  const deals = Array.isArray(result) ? result : [];
  console.log(`\n${deals.length} deal(s):`);
  for (const d of deals) {
    const name = d.company?.name || '?';
    const type = d.dealType || '?';
    const date = d.lastFinancingDate || '?';
    const size = d.lastFinancingSize ? `$${d.lastFinancingSize}` : 'undisclosed';
    console.log(`  ${name} — ${type} (${date}) ${size}`);
  }

  return result;
}

// CLI
const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth': {
    await doCdpAuth();
    break;
  }
  case 'feed': {
    const limit = parseInt(flags.limit || '10', 10);
    const days = parseInt(flags.days || '365', 10);
    const verticals = flags.verticals ? flags.verticals.split(',').map(s => s.trim()) : [];
    const dealTypes = flags['deal-types'] ? flags['deal-types'].split(',').map(s => s.trim()) : [];
    const locations = flags.locations ? flags.locations.split(',').map(s => s.trim()) : [];
    doFeed(limit, days, verticals, dealTypes, locations);
    break;
  }
  default:
    console.log(`pitchbook-deal-feed

Fetch recent deal flow from Pitchbook.

Commands:
  auth                                  Capture session from Chrome via CDP
  feed [options]                        Fetch recent deals

Options:
  --limit=10                            Number of deals to return
  --days=365                            Trailing range in days
  --verticals=VC,PE                     Filter by vertical
  --deal-types=SERIES_A,SERIES_B        Filter by deal type
  --locations=US,UK                     Filter by location

Examples:
  node pitchbook-deal-feed.mjs feed
  node pitchbook-deal-feed.mjs feed --limit=20 --days=90
  node pitchbook-deal-feed.mjs feed --verticals=VC --limit=5`);
}
```

- [ ] **Step 3: Write SKILL.md**

```markdown
# pitchbook-deal-feed

Fetch recent deal flow from Pitchbook's dashboard data sourcing API.

## Prerequisites

- Node.js 22+
- `curl` with HTTP/2 support
- Valid session (run login first)

## Setup

```bash
node ../pitchbook-login/scripts/pitchbook-login.mjs auth
```

## Usage

### Fetch recent deals

```bash
node scripts/pitchbook-deal-feed.mjs feed [--limit=10] [--days=365]
```

**Examples:**
```bash
node scripts/pitchbook-deal-feed.mjs feed
node scripts/pitchbook-deal-feed.mjs feed --limit=20 --days=90
node scripts/pitchbook-deal-feed.mjs feed --verticals=VC --limit=5
```

## How it works

**`feed`** — POSTs to `web-api/dashboard-platform-service/v3/private/data-sourcing/recent-deals` with filter criteria. Returns an array of deal objects, each containing:
- `company.pbId` / `company.name` — the company involved
- `dealType` — e.g. Early Stage VC, Later Stage VC, M&A
- `dealSynopsis` — brief description
- `lastFinancingDate` / `lastFinancingSize` — date and amount
- `totalRaised` — cumulative funding

## Data storage

```
~/.local/share/showrun/data/pitchbook/cache/
└── deal-feed-<timestamp>.json
```

## Output handling (important for agents)

Always redirect output to a file:
```bash
node scripts/pitchbook-deal-feed.mjs feed --limit=20 > /tmp/pb-deals.json 2>&1
```

## Session expiry

If you see `Session expired`, re-authenticate via `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`.
```

- [ ] **Step 4: Test 3 times with 8s delays**

```bash
cd skills/pitchbook
export $(cat .env | xargs)

# Test 1: default feed
node pitchbook-deal-feed/scripts/pitchbook-deal-feed.mjs feed --limit=3 > /tmp/pb-deal-test1.json 2>&1
cat /tmp/pb-deal-test1.json
sleep 8

# Test 2: with days filter
node pitchbook-deal-feed/scripts/pitchbook-deal-feed.mjs feed --limit=5 --days=30 > /tmp/pb-deal-test2.json 2>&1
cat /tmp/pb-deal-test2.json
sleep 8

# Test 3: with limit variation
node pitchbook-deal-feed/scripts/pitchbook-deal-feed.mjs feed --limit=1 > /tmp/pb-deal-test3.json 2>&1
cat /tmp/pb-deal-test3.json
```

Expected: Each test should print deal summaries with company names, deal types, dates. If 401, re-auth first.

- [ ] **Step 5: Commit**

```bash
git add skills/pitchbook/pitchbook-deal-feed/
git commit -m "feat: add pitchbook-deal-feed skill for recent deal flow"
```

---

### Task 2: pitchbook-mna-comps

**Files:**
- Create: `skills/pitchbook/pitchbook-mna-comps/scripts/pitchbook-mna-comps.mjs`
- Create: `skills/pitchbook/pitchbook-mna-comps/SKILL.md`

**Endpoint:** `GET /web-api/dashboard-platform-service/v2/private/mergers-and-acquisitions/comps?pbId={pbId}`

**Response:** `{ data: [{ company: { pbId, name, type }, ... }] }` — array of 5 comparable M&A transactions.

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/pitchbook/pitchbook-mna-comps/scripts
```

- [ ] **Step 2: Write pitchbook-mna-comps.mjs**

```javascript
#!/usr/bin/env node

/**
 * Fetch M&A comparable transactions from Pitchbook.
 *
 * Usage:
 *   node pitchbook-mna-comps.mjs auth                # capture session
 *   node pitchbook-mna-comps.mjs comps <pbId>         # fetch comps for a company
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

const BASE = 'https://my.pitchbook.com';
const REFERER = `${BASE}/dashboard/private`;

function doComps(pbId) {
  const auth = getAuth();
  checkCurl();
  console.log(`Fetching M&A comps for: ${pbId}`);

  const result = curlGet(
    `${BASE}/web-api/dashboard-platform-service/v2/private/mergers-and-acquisitions/comps?pbId=${pbId}`,
    auth,
    REFERER,
  );

  const outFile = resolve(CACHE_DIR, `mna-comps-${pbId}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  const comps = result.data || [];
  console.log(`\n${comps.length} comparable transaction(s):`);
  for (const c of comps) {
    const name = c.company?.name || '?';
    const id = c.company?.pbId || '?';
    console.log(`  ${name} (${id})`);
  }

  return result;
}

// CLI
const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth':
    await doCdpAuth();
    break;
  case 'comps': {
    const pbId = positional[0];
    if (!pbId) {
      console.error('Usage: node pitchbook-mna-comps.mjs comps <pbId>');
      process.exit(1);
    }
    doComps(pbId);
    break;
  }
  default:
    console.log(`pitchbook-mna-comps

Fetch M&A comparable transactions for a company.

Commands:
  auth                Capture session from Chrome via CDP
  comps <pbId>        Fetch comparable M&A transactions

Examples:
  node pitchbook-mna-comps.mjs comps 434438-06
  node pitchbook-mna-comps.mjs comps 46488-07`);
}
```

- [ ] **Step 3: Write SKILL.md**

SKILL.md follows same template as Task 1. Documents the `comps` command, `pbId` param (required), endpoint, response fields, cache path `mna-comps-<pbId>.json`.

- [ ] **Step 4: Test 3 times with 8s delays**

```bash
# Test 1: known company (from dashboard discovery: 46488-07)
node pitchbook-mna-comps/scripts/pitchbook-mna-comps.mjs comps 46488-07 > /tmp/pb-comps-test1.json 2>&1
cat /tmp/pb-comps-test1.json
sleep 8

# Test 2: OpenAI (434438-06)
node pitchbook-mna-comps/scripts/pitchbook-mna-comps.mjs comps 434438-06 > /tmp/pb-comps-test2.json 2>&1
cat /tmp/pb-comps-test2.json
sleep 8

# Test 3: another company
node pitchbook-mna-comps/scripts/pitchbook-mna-comps.mjs comps 11984-28 > /tmp/pb-comps-test3.json 2>&1
cat /tmp/pb-comps-test3.json
```

- [ ] **Step 5: Commit**

```bash
git add skills/pitchbook/pitchbook-mna-comps/
git commit -m "feat: add pitchbook-mna-comps skill for M&A comparables"
```

---

### Task 3: pitchbook-investors

**Files:**
- Create: `skills/pitchbook/pitchbook-investors/scripts/pitchbook-investors.mjs`
- Create: `skills/pitchbook/pitchbook-investors/SKILL.md`

**Endpoint:** `POST /web-api/dashboard-platform-service/v2/private/investors-and-acquirers/ACTIVE_INVESTORS`

**Request body:** Same filter object as deal-feed (assetClasses, verticals, dealTypes, locations, gecsIndustries, trailingRange, resolvedFilter).

**Response:** `{ data: [{ type, investor: { pbId, name, type }, investmentsCount, lastInvestmentDate }] }`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/pitchbook/pitchbook-investors/scripts
```

- [ ] **Step 2: Write pitchbook-investors.mjs**

```javascript
#!/usr/bin/env node

/**
 * Fetch active investors from Pitchbook.
 *
 * Usage:
 *   node pitchbook-investors.mjs auth                              # capture session
 *   node pitchbook-investors.mjs active [--days=365] [--verticals=VC]
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

const BASE = 'https://my.pitchbook.com';
const REFERER = `${BASE}/dashboard/private`;

function doActive(days = 365, verticals = [], dealTypes = [], locations = []) {
  const auth = getAuth();
  checkCurl();
  console.log(`Fetching active investors (trailing=${days}d)`);

  const payload = {
    assetClasses: [],
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

  const result = curlPost(
    `${BASE}/web-api/dashboard-platform-service/v2/private/investors-and-acquirers/ACTIVE_INVESTORS`,
    auth,
    payload,
    REFERER,
  );

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outFile = resolve(CACHE_DIR, `active-investors-${ts}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  const investors = result.data || [];
  console.log(`\n${investors.length} active investor(s):`);
  for (const inv of investors) {
    const name = inv.investor?.name || '?';
    const count = inv.investmentsCount || 0;
    const lastDate = inv.lastInvestmentDate || '?';
    console.log(`  ${name} — ${count} investments, last: ${lastDate}`);
  }

  return result;
}

// CLI
const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth':
    await doCdpAuth();
    break;
  case 'active': {
    const days = parseInt(flags.days || '365', 10);
    const verticals = flags.verticals ? flags.verticals.split(',').map(s => s.trim()) : [];
    const dealTypes = flags['deal-types'] ? flags['deal-types'].split(',').map(s => s.trim()) : [];
    const locations = flags.locations ? flags.locations.split(',').map(s => s.trim()) : [];
    doActive(days, verticals, dealTypes, locations);
    break;
  }
  default:
    console.log(`pitchbook-investors

Fetch active investors from Pitchbook.

Commands:
  auth                              Capture session from Chrome via CDP
  active [options]                  Fetch most active investors

Options:
  --days=365                        Trailing range in days
  --verticals=VC,PE                 Filter by vertical
  --deal-types=SERIES_A,SERIES_B    Filter by deal type
  --locations=US,UK                 Filter by location

Examples:
  node pitchbook-investors.mjs active
  node pitchbook-investors.mjs active --days=90 --verticals=VC`);
}
```

- [ ] **Step 3: Write SKILL.md**

Same template. Documents `active` command, filter options, endpoint, response fields, cache path `active-investors-<timestamp>.json`.

- [ ] **Step 4: Test 3 times with 8s delays**

```bash
# Test 1: default
node pitchbook-investors/scripts/pitchbook-investors.mjs active > /tmp/pb-inv-test1.json 2>&1
cat /tmp/pb-inv-test1.json
sleep 8

# Test 2: short trailing range
node pitchbook-investors/scripts/pitchbook-investors.mjs active --days=30 > /tmp/pb-inv-test2.json 2>&1
cat /tmp/pb-inv-test2.json
sleep 8

# Test 3: default again (consistency check)
node pitchbook-investors/scripts/pitchbook-investors.mjs active > /tmp/pb-inv-test3.json 2>&1
cat /tmp/pb-inv-test3.json
```

- [ ] **Step 5: Commit**

```bash
git add skills/pitchbook/pitchbook-investors/
git commit -m "feat: add pitchbook-investors skill for active investor discovery"
```

---

### Task 4: pitchbook-valuations

**Files:**
- Create: `skills/pitchbook/pitchbook-valuations/scripts/pitchbook-valuations.mjs`
- Create: `skills/pitchbook/pitchbook-valuations/SKILL.md`

**Endpoint:** `POST /web-api/dashboard-platform-service/v2/private/valuations/recent-deal-multiples`

**Request body:** `{ verticals: [], dealTypes: [], locations: [], gecsIndustries: [], trailingRange: 365 }` (smaller filter — no assetClasses or resolvedFilter wrapper)

**Response:** `{ data: [{ year, dealCount, capitalInvestedMedian, preMoneyValuationMedian, postValuationMedian, valuationEbitdaMedian, valuationRevenueMedian }] }`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/pitchbook/pitchbook-valuations/scripts
```

- [ ] **Step 2: Write pitchbook-valuations.mjs**

```javascript
#!/usr/bin/env node

/**
 * Fetch recent deal valuation multiples from Pitchbook.
 *
 * Usage:
 *   node pitchbook-valuations.mjs auth                        # capture session
 *   node pitchbook-valuations.mjs multiples [--days=365]      # fetch deal multiples
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

const BASE = 'https://my.pitchbook.com';
const REFERER = `${BASE}/dashboard/private`;

function doMultiples(days = 365, verticals = [], dealTypes = [], locations = []) {
  const auth = getAuth();
  checkCurl();
  console.log(`Fetching deal multiples (trailing=${days}d)`);

  const payload = {
    verticals,
    dealTypes,
    locations,
    gecsIndustries: [],
    trailingRange: days,
  };

  const result = curlPost(
    `${BASE}/web-api/dashboard-platform-service/v2/private/valuations/recent-deal-multiples`,
    auth,
    payload,
    REFERER,
  );

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outFile = resolve(CACHE_DIR, `valuations-${ts}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  const data = result.data || [];
  console.log(`\n${data.length} year(s) of multiples:`);
  for (const d of data) {
    const ev = d.valuationEbitdaMedian != null ? `${d.valuationEbitdaMedian.toFixed(1)}x EV/EBITDA` : 'N/A';
    const rev = d.valuationRevenueMedian != null ? `${d.valuationRevenueMedian.toFixed(1)}x EV/Rev` : 'N/A';
    console.log(`  ${d.year}: ${d.dealCount} deals — ${ev}, ${rev}`);
  }

  return result;
}

// CLI
const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth':
    await doCdpAuth();
    break;
  case 'multiples': {
    const days = parseInt(flags.days || '365', 10);
    const verticals = flags.verticals ? flags.verticals.split(',').map(s => s.trim()) : [];
    const dealTypes = flags['deal-types'] ? flags['deal-types'].split(',').map(s => s.trim()) : [];
    const locations = flags.locations ? flags.locations.split(',').map(s => s.trim()) : [];
    doMultiples(days, verticals, dealTypes, locations);
    break;
  }
  default:
    console.log(`pitchbook-valuations

Fetch recent deal valuation multiples from Pitchbook.

Commands:
  auth                              Capture session from Chrome via CDP
  multiples [options]               Fetch deal multiples by year

Options:
  --days=365                        Trailing range in days
  --verticals=VC,PE                 Filter by vertical
  --deal-types=SERIES_A             Filter by deal type
  --locations=US                    Filter by location

Examples:
  node pitchbook-valuations.mjs multiples
  node pitchbook-valuations.mjs multiples --days=1095`);
}
```

- [ ] **Step 3: Write SKILL.md**

Same template. Documents `multiples` command, endpoint, response fields (year, dealCount, EBITDA/Revenue multiples), cache path.

- [ ] **Step 4: Test 3 times with 8s delays**

```bash
# Test 1: default (1 year)
node pitchbook-valuations/scripts/pitchbook-valuations.mjs multiples > /tmp/pb-val-test1.json 2>&1
cat /tmp/pb-val-test1.json
sleep 8

# Test 2: 3-year range
node pitchbook-valuations/scripts/pitchbook-valuations.mjs multiples --days=1095 > /tmp/pb-val-test2.json 2>&1
cat /tmp/pb-val-test2.json
sleep 8

# Test 3: default again
node pitchbook-valuations/scripts/pitchbook-valuations.mjs multiples > /tmp/pb-val-test3.json 2>&1
cat /tmp/pb-val-test3.json
```

- [ ] **Step 5: Commit**

```bash
git add skills/pitchbook/pitchbook-valuations/
git commit -m "feat: add pitchbook-valuations skill for deal multiples"
```

---

### Task 5: pitchbook-hover

**Files:**
- Create: `skills/pitchbook/pitchbook-hover/scripts/pitchbook-hover.mjs`
- Create: `skills/pitchbook/pitchbook-hover/SKILL.md`

**Endpoint:** `GET /web-api/entity-hover-platform-service/company/{pbId}`

**Response:** Rich company summary — `{ entityType, entityName: { name, symbol, stockExchange }, officialName, description, location, website, primaryIndustry, gecsIndustry, verticals[], activeInvestors[], formerInvestors[], businessStatus, financingStatus, ownershipStatus, countOfCompetitors, lastFinancingDate }`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/pitchbook/pitchbook-hover/scripts
```

- [ ] **Step 2: Write pitchbook-hover.mjs**

```javascript
#!/usr/bin/env node

/**
 * Fetch lightweight company summary (hover card) from Pitchbook.
 *
 * Usage:
 *   node pitchbook-hover.mjs auth                # capture session
 *   node pitchbook-hover.mjs get <pbId>           # fetch company hover card
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

const BASE = 'https://my.pitchbook.com';
const REFERER = `${BASE}/dashboard/private`;

function doGet(pbId) {
  const auth = getAuth();
  checkCurl();
  console.log(`Fetching hover card for: ${pbId}`);

  const result = curlGet(
    `${BASE}/web-api/entity-hover-platform-service/company/${pbId}`,
    auth,
    REFERER,
  );

  const outFile = resolve(CACHE_DIR, `hover-${pbId}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary
  const name = result.entityName?.name || result.officialName || '?';
  console.log(`\n${name}`);
  if (result.description) console.log(`  ${result.description.substring(0, 200)}...`);
  if (result.location) console.log(`  Location: ${result.location}`);
  if (result.website) console.log(`  Website: ${result.website}`);
  if (result.primaryIndustry) console.log(`  Industry: ${result.primaryIndustry}`);
  if (result.businessStatus) console.log(`  Status: ${result.businessStatus}`);
  if (result.financingStatus) console.log(`  Financing: ${result.financingStatus}`);
  if (result.ownershipStatus) console.log(`  Ownership: ${result.ownershipStatus}`);
  if (result.lastFinancingDate) console.log(`  Last financing: ${result.lastFinancingDate}`);
  const activeInv = result.activeInvestors || [];
  if (activeInv.length > 0) {
    console.log(`  Active investors (${activeInv.length}): ${activeInv.map(i => i.name).join(', ')}`);
  }

  return result;
}

// CLI
const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth':
    await doCdpAuth();
    break;
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

Fetch a lightweight company summary (hover card) from Pitchbook.
Much faster than a full company profile — returns key metrics in one call.

Commands:
  auth              Capture session from Chrome via CDP
  get <pbId>        Fetch company hover card

Examples:
  node pitchbook-hover.mjs get 434438-06      # OpenAI
  node pitchbook-hover.mjs get 99587-80       # Company from dashboard`);
}
```

- [ ] **Step 3: Write SKILL.md**

Same template. Documents `get` command, `pbId` required param, response fields, cache path `hover-<pbId>.json`. Notes this is much faster than full profile (1 endpoint vs 6).

- [ ] **Step 4: Test 3 times with 8s delays**

```bash
# Test 1: company from discovery (99587-80)
node pitchbook-hover/scripts/pitchbook-hover.mjs get 99587-80 > /tmp/pb-hover-test1.json 2>&1
cat /tmp/pb-hover-test1.json
sleep 8

# Test 2: OpenAI (434438-06)
node pitchbook-hover/scripts/pitchbook-hover.mjs get 434438-06 > /tmp/pb-hover-test2.json 2>&1
cat /tmp/pb-hover-test2.json
sleep 8

# Test 3: different company
node pitchbook-hover/scripts/pitchbook-hover.mjs get 46488-07 > /tmp/pb-hover-test3.json 2>&1
cat /tmp/pb-hover-test3.json
```

- [ ] **Step 5: Commit**

```bash
git add skills/pitchbook/pitchbook-hover/
git commit -m "feat: add pitchbook-hover skill for fast company summaries"
```

---

### Task 6: pitchbook-market-maps

**Files:**
- Create: `skills/pitchbook/pitchbook-market-maps/scripts/pitchbook-market-maps.mjs`
- Create: `skills/pitchbook/pitchbook-market-maps/SKILL.md`

**Endpoint:** `POST /web-api/market-map-bff/api/v1/market-map-dashboard/published`

**Request body:** `{ dealTypes: [], locations: [], verticals: [] }`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/pitchbook/pitchbook-market-maps/scripts
```

- [ ] **Step 2: Write pitchbook-market-maps.mjs**

```javascript
#!/usr/bin/env node

/**
 * Fetch published market maps from Pitchbook.
 *
 * Usage:
 *   node pitchbook-market-maps.mjs auth                          # capture session
 *   node pitchbook-market-maps.mjs list [--verticals=VC,PE]      # list published maps
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

const BASE = 'https://my.pitchbook.com';
const REFERER = `${BASE}/dashboard/private`;

function doList(verticals = [], dealTypes = [], locations = []) {
  const auth = getAuth();
  checkCurl();
  console.log('Fetching published market maps...');

  const payload = {
    dealTypes,
    locations,
    verticals,
  };

  const result = curlPost(
    `${BASE}/web-api/market-map-bff/api/v1/market-map-dashboard/published`,
    auth,
    payload,
    REFERER,
  );

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outFile = resolve(CACHE_DIR, `market-maps-${ts}.json`);
  saveJson(outFile, result);
  console.log(`Results saved to: ${outFile}`);

  // Print summary — structure may vary, handle both array and object
  if (Array.isArray(result)) {
    console.log(`\n${result.length} market map(s)`);
    for (const m of result.slice(0, 20)) {
      console.log(`  ${m.name || m.title || JSON.stringify(m).substring(0, 100)}`);
    }
  } else if (result && typeof result === 'object') {
    const keys = Object.keys(result);
    console.log(`\nResponse keys: ${keys.join(', ')}`);
    for (const key of keys.slice(0, 10)) {
      const val = result[key];
      const summary = Array.isArray(val) ? `[${val.length} items]` : typeof val;
      console.log(`  ${key}: ${summary}`);
    }
  }

  return result;
}

// CLI
const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth':
    await doCdpAuth();
    break;
  case 'list': {
    const verticals = flags.verticals ? flags.verticals.split(',').map(s => s.trim()) : [];
    const dealTypes = flags['deal-types'] ? flags['deal-types'].split(',').map(s => s.trim()) : [];
    const locations = flags.locations ? flags.locations.split(',').map(s => s.trim()) : [];
    doList(verticals, dealTypes, locations);
    break;
  }
  default:
    console.log(`pitchbook-market-maps

Fetch published market maps from Pitchbook.

Commands:
  auth                              Capture session from Chrome via CDP
  list [options]                    List published market maps

Options:
  --verticals=VC,PE                 Filter by vertical
  --deal-types=SERIES_A             Filter by deal type
  --locations=US                    Filter by location

Examples:
  node pitchbook-market-maps.mjs list
  node pitchbook-market-maps.mjs list --verticals=VC`);
}
```

- [ ] **Step 3: Write SKILL.md**

Same template. Documents `list` command, filter options, endpoint, cache path `market-maps-<timestamp>.json`.

- [ ] **Step 4: Test 3 times with 8s delays**

```bash
# Test 1: default (no filters)
node pitchbook-market-maps/scripts/pitchbook-market-maps.mjs list > /tmp/pb-mm-test1.json 2>&1
cat /tmp/pb-mm-test1.json
sleep 8

# Test 2: default again (consistency)
node pitchbook-market-maps/scripts/pitchbook-market-maps.mjs list > /tmp/pb-mm-test2.json 2>&1
cat /tmp/pb-mm-test2.json
sleep 8

# Test 3: default again
node pitchbook-market-maps/scripts/pitchbook-market-maps.mjs list > /tmp/pb-mm-test3.json 2>&1
cat /tmp/pb-mm-test3.json
```

- [ ] **Step 5: Commit**

```bash
git add skills/pitchbook/pitchbook-market-maps/
git commit -m "feat: add pitchbook-market-maps skill for published market maps"
```

---

### Task 7: pitchbook-advanced-search

**BLOCKED:** Waiting for discovery of the search results endpoint. The discovery agent is running a camoufox session to capture what endpoint returns actual rows of search results (companies/investors/deals) after creating a search session.

**Known endpoints (from prior discovery):**
- `POST /web-api/advanced-search-api/searches` — Create search (returns searchId)
- `GET /web-api/advanced-search-api/searches/{searchId}` — Get search metadata
- `GET /web-api/advanced-search-api/searches/{searchId}/count?criteriaKey=...` — Get result count
- `GET /web-api/advanced-search-api/searches/{searchId}/tabs` — Get available result tabs
- `GET /web-api/advanced-search-api-bff/api/v1/search-criteria/{searchId}?criteriaKey=...` — Get/modify criteria
- **MISSING:** The endpoint that returns actual result rows with pagination

**Files (to be created after discovery):**
- Create: `skills/pitchbook/pitchbook-advanced-search/scripts/pitchbook-advanced-search.mjs`
- Create: `skills/pitchbook/pitchbook-advanced-search/SKILL.md`

**Expected commands:**
- `create <searchType>` — Create a new search session (COMPANIES, DEALS, INVESTORS)
- `results <searchId> [--page=1] [--pageSize=25]` — Fetch results for a search
- `count <searchId>` — Get result count

This task will be completed once the discovery agent returns the results endpoint structure.

---

### Task 8: Update parent SKILL.md

**Files:**
- Modify: `skills/pitchbook/SKILL.md`

- [ ] **Step 1: Add new skills to the table**

Add these rows to the `## Available skills` table in `skills/pitchbook/SKILL.md`:

```markdown
| [Deal Feed](pitchbook-deal-feed/SKILL.md) | `pitchbook-deal-feed/scripts/pitchbook-deal-feed.mjs` | Fetch recent deal flow with filters |
| [M&A Comps](pitchbook-mna-comps/SKILL.md) | `pitchbook-mna-comps/scripts/pitchbook-mna-comps.mjs` | Fetch comparable M&A transactions |
| [Investors](pitchbook-investors/SKILL.md) | `pitchbook-investors/scripts/pitchbook-investors.mjs` | Discover active investors |
| [Valuations](pitchbook-valuations/SKILL.md) | `pitchbook-valuations/scripts/pitchbook-valuations.mjs` | Deal valuation multiples by year |
| [Hover](pitchbook-hover/SKILL.md) | `pitchbook-hover/scripts/pitchbook-hover.mjs` | Fast company summary (single endpoint) |
| [Market Maps](pitchbook-market-maps/SKILL.md) | `pitchbook-market-maps/scripts/pitchbook-market-maps.mjs` | Published market map listings |
```

- [ ] **Step 2: Commit**

```bash
git add skills/pitchbook/SKILL.md
git commit -m "docs: add new market intelligence skills to pitchbook index"
```

---

## Testing Protocol

For each skill during testing:
1. **If 401 received:** Re-authenticate via `node pitchbook-login/scripts/pitchbook-login.mjs auth` (or camoufox if CDP unavailable)
2. **Wait 8 seconds** between each API call
3. **Run each command 3 times** to verify consistency
4. **Check for warnings** in response about account usage, rate limits, or CAPTCHAs
5. **Redirect output to file** — never let raw JSON fill the conversation
6. **Verify cache files** are written correctly to `~/.local/share/showrun/data/pitchbook/cache/`
