# Google Maps Agent Browser Skills

Scrape Google Maps business listings and place details using camoufox-js browser automation.
No API key required — uses the public Google Maps web interface.

## Prerequisites

### Node.js 22+
Required for ES modules. Check with `node --version`.

### Install Dependencies
```bash
cd google-maps && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Search](google-maps-search/SKILL.md) | `google-maps-search/scripts/google-maps-search.mjs` | Search for businesses by query + location |
| [Details](google-maps-details/SKILL.md) | `google-maps-details/scripts/google-maps-details.mjs` | Get full details for a place by placeId or URL |

## Typical Workflow

```
1. Search for places   →  node google-maps-search/scripts/google-maps-search.mjs "coffee" "Ankara" 20
2. Get place details   →  node google-maps-details/scripts/google-maps-details.mjs <placeId>
```

## Output Format

All scripts write `RESULT:{json}` to stdout. Logs go to stderr.

```javascript
// Parse results from a script
const output = execSync("node google-maps-search.mjs ...", { encoding: "utf-8" });
const resultLine = output.split("\n").find(l => l.startsWith("RESULT:"));
const data = JSON.parse(resultLine.slice(7));
```

## Data Available

### Search Results
Each place includes:
- `name` — business name
- `address` — street address
- `rating` — float (e.g., 4.8)
- `reviewCount` — integer
- `category` — business type (e.g., "Coffee shop", "Restaurant")
- `openStatus` — current status (e.g., "Open · Closes 9:30 pm")
- `placeId` — ChIJ... format Google place ID
- `url` — full Google Maps URL
- `thumbnail` — thumbnail image URL

### Details
In addition to search fields:
- `phone` — phone number
- `website` — business website URL
- `hours` — `{Monday: "8 am to 11 pm", ...}` by day
- `coordinates` — `{lat: 39.92, lng: 32.85}`
- `photos` — array of Google photo URLs
- `reviews` — array of `{author, rating, text, time, reviewerCount}`

## Anti-Bot Notes

Google Maps does not aggressively block scrapers for basic searches.
camoufox-js (Firefox-based anti-detect browser) handles fingerprinting.
No API key, session, or login required.

Rate limiting: allow ~5-10 seconds between requests to be polite.
