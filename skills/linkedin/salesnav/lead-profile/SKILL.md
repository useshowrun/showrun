---
name: salesnav-lead-profile
description: "Fetch comprehensive Sales Navigator lead profile data including contact info, positions, education, skills, Lead IQ insights, spotlights, timeline, notes, and warm intro paths."
---

# salesnav-lead-profile

Fetch comprehensive Sales Navigator lead profile data including contact info, positions, education, skills, Lead IQ insights, spotlights, timeline, notes, and warm intro paths.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled, and a logged-in `www.linkedin.com/sales/...` tab kept open
- [chrome-cdp skill]
- LinkedIn Sales Navigator subscription

Requests run **inside your Chrome tab** (via CDP), not from Node — this is what lets them past LinkedIn's `sales-api` edge. So a Sales Navigator tab must stay open for **every** command, not just `auth`. If no `/sales/` tab is open, open one (see chrome-cdp "Agent guidance"): `node skills/chrome-cdp/scripts/cdp.mjs open https://www.linkedin.com/sales/home`.

## Setup

One-time auth -- open Sales Navigator in Chrome, then:

```bash
node salesnav-lead-profile.mjs auth
```

Requires a Chrome tab open to any `linkedin.com/sales` page.

## Usage

### View full profile (all sections)

```bash
node salesnav-lead-profile.mjs view ACwAABJVBJEB...
```

### View profile with specific sections

```bash
node salesnav-lead-profile.mjs view ACwAABJVBJEB... --sections=basic,spotlights,lead-iq
```

### View profile using full URN (from search results)

```bash
node salesnav-lead-profile.mjs view "urn:li:fs_salesProfile:(ACwAABJVBJEB...,NAME_SEARCH,Yq9I)"
```

### Batch fetch profiles (max 25)

```bash
node salesnav-lead-profile.mjs batch ACwAABJVBJEB...,ACwAABJVBJEC...,ACwAABJVBJED...
```

### Individual sub-endpoints

```bash
node salesnav-lead-profile.mjs lead-iq ACwAABJVBJEB...
node salesnav-lead-profile.mjs spotlights ACwAABJVBJEB...
node salesnav-lead-profile.mjs highlights ACwAABJVBJEB...
node salesnav-lead-profile.mjs timeline ACwAABJVBJEB...
node salesnav-lead-profile.mjs notes ACwAABJVBJEB...
node salesnav-lead-profile.mjs warm-intro ACwAABJVBJEB...
node salesnav-lead-profile.mjs insights ACwAABJVBJEB...
```

## How it works

1. **auth** -- Uses CDP to find an open Sales Navigator tab, validates the session (`li_at` + `JSESSIONID`), and writes a marker `session.json`. Cookies stay in Chrome — every request runs in-page with `credentials:'include'`.

2. **view** -- Calls the main `salesApiProfiles` endpoint with a comprehensive decoration string to fetch core profile fields (name, headline, positions, education, skills, contact info). Then calls each sub-endpoint (spotlights, Lead IQ, highlights, insights, timeline, notes, warm intro) and merges all results into a single JSON output. Use `--sections` to limit which sub-endpoints are called.

3. **batch** -- Uses the batch `salesApiProfiles` endpoint with `ids=List(...)` to fetch up to 25 profiles in a single request. Returns basic profile data (no sub-endpoints).

4. **lead-iq** -- Calls `salesApiLeadIq` to get AI-generated insights about the lead, including talking points and context.

5. **spotlights** -- Calls `salesApiProfileSpotlights` to get spotlight badges (job changes, shared connections, etc.).

6. **highlights** -- Calls `salesApiProfileHighlights` to get shared connection and team member highlights.

7. **timeline** -- Calls `salesApiProfileTimeline` to get recent profile activity and changes.

8. **notes** -- Calls `salesApiEntityNote` to get any notes saved on this lead.

9. **warm-intro** -- Calls `salesApiWarmIntro` to find warm introduction paths through shared connections.

10. **insights** -- Calls `salesApiInsightsV2` to get recent posts and comments by the lead.

## Data storage

```
~/.local/share/showrun/data/salesnav-lead-profile/
  session.json                    Session marker (cookies stay in Chrome)
  cache/
    profile-<id>.json             Full profile data (view command)
    batch-<timestamp>.json        Batch profile results
    lead-iq-<id>.json             Lead IQ insights
    spotlights-<id>.json          Profile spotlights
    highlights-<id>.json          Profile highlights
    timeline-<id>.json            Profile timeline
    notes-<id>.json               Entity notes
    warm-intro-<id>.json          Warm intro paths
    insights-<id>.json            Posts and comments
```

## Session expiry

If you get 401/403 errors, re-run auth:

```bash
node salesnav-lead-profile.mjs auth
```

Sessions typically last several hours but may expire sooner if LinkedIn detects unusual activity.
