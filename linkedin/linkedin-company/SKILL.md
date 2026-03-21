# LinkedIn Company Scraper

Scrapes a public LinkedIn company page.

## Usage

```bash
node linkedin-company/scripts/linkedin-company.mjs <company-slug>
```

## Examples

```bash
node linkedin-company/scripts/linkedin-company.mjs microsoft
node linkedin-company/scripts/linkedin-company.mjs openai
node linkedin-company/scripts/linkedin-company.mjs google
node linkedin-company/scripts/linkedin-company.mjs anthropic
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `company-slug` | ✅ | Company URL slug (from /company/<slug> URL) |

## Output

```json
{
  "slug": "microsoft",
  "name": "Microsoft",
  "profileUrl": "https://www.linkedin.com/company/microsoft",
  "profileImage": "https://media.licdn.com/...",
  "industry": "Software Development",
  "followerCount": 27841406,
  "employeeCount": 227650,
  "about": "Every company has a mission. What's ours? To empower every person...",
  "website": "https://news.microsoft.com/",
  "companySize": "10,001+ employees",
  "headquarters": "Redmond, Washington",
  "companyType": "Public Company",
  "founded": null,
  "specialties": "Business Software, Developer Tools, ...",
  "locations": [
    "1 Microsoft Way, Redmond, Washington 98052, US",
    "..."
  ],
  "meta": {
    "scrapedAt": "2026-03-21T...",
    "authenticated": false
  }
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `MISSING_ARG` | No company slug provided |
| `NOT_FOUND` | Company page does not exist |
| `AUTH_REQUIRED` | LinkedIn redirected to login wall |
| `EXTRACTION_FAILED` | Could not parse company data |
| `SCRAPER_ERROR` | Unexpected error |

## Strategy

1. Navigate to `https://www.linkedin.com/company/<slug>`
2. Extract from **meta tags**: OG title, description, image
3. Extract from **semantic DOM**:
   - `h1` → company name
   - `h2` (industry-like, non-nav) → industry category  
   - Body text pattern `"X followers"` → followerCount
   - Body text pattern `"View all X employees"` → employeeCount
   - `section` with h2 "About us" → description + detail items
   - Detail items: `dt` label / next sibling `dd` value pairs for website/industry/size/etc.
   - Fallback: newline-separated label/value parsing from section text
   - `section` with h2 "Locations" → office location addresses

## Data Notes

- All company data is available without login (LinkedIn makes company info fully public)
- Employee count: "View all X employees" is visible without login
- Follower count: shown in subtitle text
- The "About us" section contains all structured company details
