---
name: yahoofinance-sectors
description: "Fetch Yahoo Finance sector and industry data including overview, top companies, ETFs, mutual funds, and industry breakdowns."
---

# yahoofinance-sectors

Fetch Yahoo Finance sector and industry data including overview, top companies, ETFs, mutual funds, and industry breakdowns.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance accessible in Chrome (logged in or cookie present)

## Setup

```bash
node yahoofinance-sectors.mjs auth
```

## Usage

```bash
# List all sector keys
node yahoofinance-sectors.mjs list

# View sector overview (top companies, ETFs, mutual funds, industries)
node yahoofinance-sectors.mjs view technology
node yahoofinance-sectors.mjs view healthcare
node yahoofinance-sectors.mjs view financial-services

# View industry detail (top companies, performance, growth)
node yahoofinance-sectors.mjs industry technology/software-application
node yahoofinance-sectors.mjs industry financial-services/banks-diversified
node yahoofinance-sectors.mjs industry healthcare/biotechnology
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP, fetches crumb from Yahoo API
2. `list` — Prints all 11 sector keys
3. `view` — Fetches sector data from `GET /v1/finance/sectors/{key}` and displays overview, top companies, ETFs, mutual funds, and industries
4. `industry` — Fetches industry data from `GET /v1/finance/industries/{key}` and displays overview, top companies, performing companies, growth companies

Available sectors: technology, financial-services, consumer-cyclical, communication-services, healthcare, industrials, consumer-defensive, energy, basic-materials, real-estate, utilities

## Data storage

```
~/.local/share/showrun/data/yahoofinance-sectors/
├── session.json     Auth cookies & crumb
└── cache/           Sector & industry JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
