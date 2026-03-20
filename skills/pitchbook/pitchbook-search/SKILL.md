# Pitchbook Search

Search Pitchbook for companies by domain, name, or any search term.

## Prerequisites

- Valid session in `~/.pitchbook-session.json` (run login/capture-headers first)
- `curl` with HTTP/2 + TLS v1.3 support

## Usage

```bash
node pitchbook-search/scripts/pitchbook-search.mjs <query>
```

**Examples:**
```bash
node pitchbook-search/scripts/pitchbook-search.mjs openai.com
node pitchbook-search/scripts/pitchbook-search.mjs "Stripe Inc"
node pitchbook-search/scripts/pitchbook-search.mjs anthropic
```

The query is passed directly to the Pitchbook search API with no post-processing.

## Output

Emits the raw Pitchbook API response as `RESULT:{json}` on stdout. The response contains an `items` array with search results. Each item includes:

- `value.profileResult.id` — Pitchbook company ID (use with `pitchbook-company`)
- `value.profileResult.name` — company name
- `matchParams.matchType` — e.g. `EXACT`, `PARTIAL`
- `matchParams.nameType` — e.g. `WEBSITE`, `LEGAL_NAME`

The caller/agent decides how to interpret and filter results.

## Error Codes

| Code | Meaning |
|------|---------|
| `SESSION_EXPIRED` | Session is invalid or expired — re-run login |
| `MISSING_ARG` | No query argument provided |
