# LinkedIn Profile Scraper

Scrapes a public LinkedIn person profile.

## Usage

```bash
node linkedin-profile/scripts/linkedin-profile.mjs <username>
```

## Examples

```bash
node linkedin-profile/scripts/linkedin-profile.mjs williamhgates
node linkedin-profile/scripts/linkedin-profile.mjs satyanadella
node linkedin-profile/scripts/linkedin-profile.mjs elonmusk
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `username` | ✅ | LinkedIn username (from /in/<username> URL) |

## Output

```json
{
  "username": "williamhgates",
  "name": "Bill Gates",
  "headline": "Chair, Gates Foundation and Founder, Breakthrough Energy",
  "location": "Seattle, Washington, United States",
  "profileImage": "https://media.licdn.com/...",
  "about": "Chair of the Gates Foundation. Founder of Breakthrough Energy...",
  "profileUrl": "https://www.linkedin.com/in/williamhgates",
  "experiences": [
    {
      "title": "Co-chair",
      "company": "Gates Foundation",
      "startDate": "2000",
      "endDate": "Present",
      "duration": "26 years",
      "location": null,
      "description": null
    }
  ],
  "education": [
    {
      "school": "Harvard University",
      "degree": null,
      "startDate": "1973",
      "endDate": "1975",
      "description": null
    }
  ],
  "articles": [
    {
      "title": "A phone call that saves lives",
      "url": "https://www.linkedin.com/pulse/...",
      "publishedAt": "2026-03-08T01:47:00.000+00:00",
      "likeCount": 5198
    }
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
| `MISSING_ARG` | No username provided |
| `NOT_FOUND` | Profile does not exist |
| `AUTH_REQUIRED` | LinkedIn redirected to login wall |
| `EXTRACTION_FAILED` | Could not parse profile data |
| `SCRAPER_ERROR` | Unexpected error |

## Strategy

1. Navigate to `https://www.linkedin.com/in/<username>`
2. Extract from **meta tags**: OG title, description, image, profile:first_name/last_name
3. Extract from **JSON-LD**: article items with dates and like counts
4. Extract from **semantic DOM**:
   - `h1` → person name (always present)
   - `h2` (non-auth) → headline
   - `.profile-info-subheader` → location
   - `img.top-card-layout__entity-image` → profile photo
   - `section` with h2 "About" → bio text
   - `section` with h2 "Experience" → experience items (h3=title, h4=company, [class*="date-range"]=dates)
   - `section` with h2 "Education" → education items (h3=school, h4=degree)
   - `section` with h2 "Articles by X" → recent articles (h3=title, a=url, time=date)
