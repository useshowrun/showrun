# Pitchbook Company

Fetch a full company profile from Pitchbook by company ID.

## Prerequisites

- Valid session in `~/.pitchbook-session.json` (run login/capture-headers first)
- Pitchbook company ID (obtain via `pitchbook-search`)
- `curl` with HTTP/2 + TLS v1.3 support

## Usage

```bash
node pitchbook-company/scripts/pitchbook-company.mjs <companyId>
```

## Endpoints Fetched

The script sequentially fetches 6 API endpoints with a 6-second delay between each (~36 seconds total):

| Key | Endpoint |
|-----|----------|
| `generalInfo` | `/web-api/profiles/{id}/company/general-info` |
| `dealHistory` | `/web-api/deal-debt-experience-bff/companies/{id}/deal-history` |
| `currentTeam` | `/web-api/profiles/{id}/company/executives/current?page=1&pageSize=100` |
| `formerTeam` | `/web-api/profiles/{id}/company/executives/former?page=1&pageSize=100` |
| `currentBoardMembers` | `/web-api/profiles/{id}/company/board-members/current?page=1&pageSize=100` |
| `formerBoardMembers` | `/web-api/profiles/{id}/company/board-members/former?page=1&pageSize=100` |

## Output

Emits `RESULT:{json}` on stdout with the full company object:

```json
{
  "companyId": "123456-78",
  "generalInfo": { ... },
  "dealHistory": { ... },
  "currentTeam": { ... },
  "formerTeam": { ... },
  "currentBoardMembers": { ... },
  "formerBoardMembers": { ... }
}
```

If a non-auth endpoint fails, its value is `null` and the script continues with remaining endpoints.

## Error Codes

| Code | Meaning |
|------|---------|
| `SESSION_EXPIRED` | Session expired mid-fetch — re-run login, then retry |
| `MISSING_ARG` | No company ID argument provided |
