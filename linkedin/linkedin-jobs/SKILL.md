# LinkedIn Jobs Search Scraper

Searches LinkedIn public job listings by keyword and location.

## Usage

```bash
node linkedin-jobs/scripts/linkedin-jobs.mjs <keywords> [location] [options]
```

## Examples

```bash
# Basic search
node linkedin-jobs/scripts/linkedin-jobs.mjs "software engineer" "United States"

# Remote jobs only
node linkedin-jobs/scripts/linkedin-jobs.mjs "data scientist" "Remote" --remote

# With job type filter
node linkedin-jobs/scripts/linkedin-jobs.mjs "product manager" "New York" --type full-time

# With seniority filter
node linkedin-jobs/scripts/linkedin-jobs.mjs "ML engineer" --level entry_level --max 50

# With full job descriptions
node linkedin-jobs/scripts/linkedin-jobs.mjs "backend engineer" "San Francisco" --detail --max 10

# Pagination
node linkedin-jobs/scripts/linkedin-jobs.mjs "frontend developer" --start 25 --max 25
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `keywords` | ✅ | Job title or keywords to search |
| `location` | ❌ | City, state, country, or "Remote" |

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--max N` | 25 | Maximum results to return |
| `--start N` | 0 | Start at result index N (pagination) |
| `--detail` | off | Fetch full description for each job (~2s each) |
| `--type X` | any | Filter: full-time, part-time, contract, temporary, volunteer, internship |
| `--level X` | any | Filter: internship, entry_level, associate, mid_senior_level, director, executive |
| `--remote` | off | Filter for remote jobs only |

## Output

```json
{
  "jobs": [
    {
      "jobId": "4374834620",
      "urn": "urn:li:jobPosting:4374834620",
      "title": "Software Engineer (New Grads) - New York",
      "company": "Giga",
      "location": "New York, NY",
      "postedAt": "2 days ago",
      "isEasyApply": false,
      "applicantCount": null,
      "url": "https://www.linkedin.com/jobs/view/software-engineer-new-grads-new-york-at-giga-4374834620",
      "logoImg": "https://media.licdn.com/...",
      "description": "About Giga...",  // only with --detail
      "criteria": {                     // only with --detail
        "seniorityLevel": "Entry level",
        "employmentType": "Full-time",
        "jobFunction": "Engineering and Information Technology",
        "industries": "Software Development"
      }
    }
  ],
  "totalResults": 88000,
  "meta": {
    "keywords": "software engineer",
    "location": "United States",
    "start": 0,
    "returned": 25,
    "scrapedAt": "2026-03-21T...",
    "authenticated": false,
    "filters": {
      "jobType": null,
      "seniorityLevel": null,
      "remote": false
    }
  }
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `MISSING_ARG` | No keywords provided |
| `AUTH_REQUIRED` | LinkedIn redirected to login wall |
| `SCRAPER_ERROR` | Unexpected error |

## Strategy

1. Navigate to `https://www.linkedin.com/jobs/search/?keywords=...&location=...`
2. Extract job cards via `[class*="job-search-card"][data-entity-urn]` (stable selector)
   - `data-entity-urn` contains the job posting URN (e.g., `urn:li:jobPosting:4374834620`)
   - `h3` → job title (semantic, always present)
   - `h4` → company name (semantic, always present)
   - `[class*="metadata"]` → location + posted date
   - `time` element → posted date (when present)
   - `img` → company logo
   - `a[href*="/jobs/view/"]` → job detail URL
3. For `--detail`: navigate to each job URL, extract description + criteria
   - `[class*="show-more-less-html__markup"]` → job description (full HTML → text)
   - `[class*="description__job-criteria-item"]` → seniority/type/function/industries
   - `[class*="topcard__org-name"]` → company name
   - `[class*="topcard__flavor--bullet"]` → location

## Pagination

LinkedIn shows 25 results per page. Use `--start` to paginate:
```bash
# Page 1: results 1-25
node linkedin-jobs.mjs "engineer" --max 25 --start 0

# Page 2: results 26-50
node linkedin-jobs.mjs "engineer" --max 25 --start 25
```

## Notes

- No login required for public job listings
- All fields are from stable DOM structure: data-entity-urn, h3/h4, semantic elements
- LinkedIn URL query parameters: `f_JT` (job type), `f_E` (experience level), `f_WT=2` (remote)
- Job detail URLs contain tracking params; these are automatically cleaned in output
