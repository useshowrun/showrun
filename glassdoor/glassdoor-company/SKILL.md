# Glassdoor Company Search Scraper

Searches Glassdoor for company information by company name.
Returns company ratings, review counts, job counts, and salary counts.

## Strategy

Navigates to `glassdoor.com/Search/results.htm?keyword=<name>` and parses DOM:
- Company overview links (`a[href*="/Overview/Working-at-"]`)
- Link text contains: name, rating, job/review/salary counts
- Extracts employer ID from URL (used to construct review/salary page URLs)

### Why Search Page Only?

Individual company pages (`/Overview/`, `/Reviews/`, `/Salaries/`) are Cloudflare-protected
from datacenter IP ranges. The search results page is accessible and provides key summary data.

## Usage

\`\`\`bash
node glassdoor-company.mjs google
node glassdoor-company.mjs openai --max 3
node glassdoor-company.mjs microsoft
\`\`\`

## Output

\`\`\`json
{
  "query": "google",
  "companies": [
    {
      "name": "Google",
      "rating": 4.4,
      "jobCount": 6700,
      "reviewCount": 69200,
      "salaryCount": 189000,
      "overviewUrl": "https://www.glassdoor.com/Overview/Working-at-Google-EI_IE9079.11,17.htm",
      "employerId": "9079",
      "reviewsUrl": "https://www.glassdoor.com/Reviews/Google-Reviews-E9079.htm"
    }
  ],
  "meta": {
    "returned": 3,
    "hasMore": false,
    "note": "Individual company pages require GD_COOKIES or residential proxy."
  }
}
\`\`\`

## Known Limitations

- Individual company detail pages (reviews, salaries) are Cloudflare-blocked from datacenter IPs
- Set GD_COOKIES env var or use residential proxy for deeper data
- Companies with no reviews show `rating: null`
