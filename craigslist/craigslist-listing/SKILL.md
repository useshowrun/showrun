# craigslist-listing

Fetch full details for a single Craigslist listing URL, including description, all images, attributes, and dates.

## Usage

```bash
node craigslist-listing/scripts/craigslist-listing.mjs <listing-url>
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<listing-url>` | Full Craigslist listing URL |

## Examples

```bash
# Fetch a for-sale listing
node craigslist-listing/scripts/craigslist-listing.mjs \
  "https://sfbay.craigslist.org/nby/bik/d/petaluma-retrospec-sully-bmx-kruiser/7912241254.html"

# Fetch a housing listing
node craigslist-listing/scripts/craigslist-listing.mjs \
  "https://newyork.craigslist.org/brk/reo/d/brooklyn-bedroom-available/7920808455.html"

# Fetch a job listing
node craigslist-listing/scripts/craigslist-listing.mjs \
  "https://chicago.craigslist.org/nch/sof/d/waukegan-application-architect/7920252528.html"
```

## Output Schema

```json
{
  "id": "7912241254",
  "url": "https://sfbay.craigslist.org/nby/bik/d/...",
  "title": "Retrospec Sully BMX Kruiser",
  "price": 275,
  "currency": "USD",
  "location": "Petaluma, CA",
  "lat": 38.2507,
  "lng": -122.6155,
  "description": "Brand new still in the box Retrospec full size Sully BMX Kruiser...",
  "images": [
    "https://images.craigslist.org/00b0b_47hg7cuHCNg_0Mo0Mo_1200x900.jpg"
  ],
  "postedAt": "2026-01-31T12:36:59-0800",
  "updatedAt": "2026-03-22T08:19:25-0700",
  "attributes": {
    "bicycle_type": "cruiser",
    "condition": "new",
    "make_/_manufacturer": "Retrospec",
    "model_name_/_number": "Sully"
  },
  "city": "sfbay",
  "subcategory": "nby"
}
```

**Notes:**
- `updatedAt` is only set if different from `postedAt` (listing was edited after posting)
- `attributes` varies by category: for-sale has make/model/condition, housing has housing_type/laundry/parking, jobs have compensation/employment_type
- `housing` listings include a `summary` attribute (e.g., `"3BR / 1Ba, 600ft²"`)
- Images are returned at maximum available resolution (1200x900)
- Expired/deleted listings return `{"expired": true}` or `{"error": true, "code": "NOT_FOUND"}`

## Error Responses

```json
// Listing not found (deleted or expired)
{ "url": "...", "id": "...", "error": true, "code": "NOT_FOUND", "message": "..." }

// Listing expired
{ "url": "...", "id": "...", "expired": true, "message": "This listing has expired or been deleted." }

// Invalid URL
{ "error": true, "code": "INVALID_URL", "message": "..." }
```
