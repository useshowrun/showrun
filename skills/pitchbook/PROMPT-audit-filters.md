# Prompt: Audit and fix API filters for a PitchBook skill

You are auditing a PitchBook skill's API filters to ensure they match what the PitchBook web UI offers. The goal is to make the CLI skill support every filter option available in the frontend — no missing filters, no missing values.

## Context

PitchBook skills in this repo call PitchBook's internal web APIs via curl. The APIs accept filter codes (short strings like `AIML`, `gUS`, `EVC`) that correspond to UI filter options (dropdowns, checkboxes, trees). The current scripts may have:
- Missing filter parameters that the UI supports
- Incomplete code lists (e.g., only 11 location codes when the UI has 435)
- Filters that don't work because the API requires companion parameters (e.g., `dealTypes` must be sent alongside `assetClasses`)

## Method: Capture a real request from the browser

The most reliable way to discover all filter codes is to capture what the PitchBook UI actually sends to the API.

### Step 1: Open PitchBook in Chrome with the relevant page loaded

The user should have PitchBook open and be logged in. Use CDP to navigate if needed:
```bash
node skills/chrome-cdp/scripts/cdp.mjs list
node skills/chrome-cdp/scripts/cdp.mjs nav <target> <url>
```

### Step 2: Ask the user to capture the API request

Ask the user to:
1. Open Chrome DevTools (F12) → Network tab
2. Select ALL options in every filter dropdown on the page (check every checkbox)
3. Click Apply / Submit
4. Find the API request in the Network tab (look for the endpoint the skill uses — check the skill's script)
5. Right-click → Copy → Copy as cURL
6. Paste it

This gives you the **complete set of all valid filter codes** in the request body.

### Step 3: Parse and organize the captured payload

Extract the `--data-raw` JSON body from the curl. Parse it and organize:
- Group codes by filter parameter
- Identify hierarchical relationships (parent/child codes)
- Note prefix conventions (e.g., `g` = region, `sg` = subregion, `c` = country)
- Identify which codes map to which asset class or category

### Step 4: Compare with the current skill

Read the skill's script and SKILL.md. Identify:
- Which filter parameters does the script send? Which are missing?
- Which code values are documented? Which are missing?
- Does the script need to send companion parameters? (e.g., deal feed requires both `assetClasses` AND `dealTypes`)

### Step 5: Create a filter-codes.json reference file

Store all discovered codes in a `filter-codes.json` file alongside the skill's SKILL.md. Structure:
- Group by filter parameter name
- Include hierarchy (regions → subregions → codes)
- Add `_allCodes` arrays for each group (easy programmatic access)
- Add `_label` annotations where the label is obvious from the code
- Add convenience presets for common queries

Example from the deal-feed skill:
```json
{
  "presets": {
    "vc-early": {
      "_description": "Pre-seed through Series A",
      "_codes": ["PAI","POF","SEED","ANG","ANG_A","EVC","EVC_A","SRSEED","A"]
    }
  }
}
```

### Step 6: Update the script

- Load `filter-codes.json` at startup
- Add preset resolution logic (expand preset names to code arrays)
- Auto-populate companion parameters (e.g., set `dealTypes` from `assetClasses`)
- Update help text with new options and preset names

### Step 7: Update SKILL.md

- Keep it concise — reference `filter-codes.json` for full code lists
- Document presets and common examples
- Add a "quick reference" section with the most-used codes
- Tell agents to grep filter-codes.json for specific codes

### Step 8: Test

Run the skill with different filter combinations and verify:
- Preset filters return only the expected deal types
- Raw code filters work
- Companion parameters are auto-set
- Results match what the UI would show

## Important notes

- **Be respectful of the account** — don't save searches, delete anything, or make rapid requests. Wait 3+ seconds between API calls.
- **The API request body is the source of truth** — don't guess codes from JS bundles or DOM inspection. The captured request has the exact codes the UI sends.
- **Labels may not match codes** — PitchBook uses internal codes (e.g., `AIML` for "AI & Machine Learning"). Don't try to reverse-engineer labels for obscure codes. The codes work regardless of what we name them.
- **Hierarchy matters** — some filters have parent/child relationships (asset class → deal types, region → subregion → country). The script may need to send both parent and child codes.
- **Store codes externally** — don't inline hundreds of codes in the script or SKILL.md. Use a JSON file that agents can grep.

## Reference implementation

See `pitchbook-deal-feed/` for a completed example:
- `filter-codes.json` — 176 deal types, 59 verticals, 435 locations with presets
- `scripts/pitchbook-deal-feed.mjs` — `resolveFilters()` function handles presets and auto-population
- `SKILL.md` — concise docs pointing to the JSON file

## Skills to audit

Apply this method to each PitchBook skill that accepts filter parameters:
- [ ] `pitchbook-deal-feed` — **DONE** (deal types, verticals, locations, asset classes)
- [ ] `pitchbook-investors` — verticals, locations, asset classes
- [ ] `pitchbook-valuations` — needs investigation
- [ ] `pitchbook-advanced-search` — search type, criteria filters
- [ ] `pitchbook-market-maps` — category filters
- [ ] `pitchbook-company` — sections filter
- [ ] `pitchbook-mna-comps` — filter parameters
