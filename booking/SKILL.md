# Booking.com Scraper Skills

Browser automation skills for scraping Booking.com hotel/property listings, prices, and reviews.

## Skills

### booking-search
Search Booking.com for hotels/properties in any city with check-in/checkout dates.

Returns up to 25 properties per page with: name, stars, review score, review count, price, address, distance, link.

### booking-hotel
Scrape full details for a specific hotel by URL or hotel slug.

Returns: name, stars, rating, reviews, description, facilities, photos, room info, nearby POIs, and more.

## Anti-Bot Notes

- Booking.com uses AWS WAF (bot challenge tokens). camoufox with headless Firefox
  passes the WAF challenge automatically.
- Search requires a valid `dest_id` parameter. The scraper auto-resolves this via
  Booking.com's autocomplete GraphQL API.
- Always navigate to homepage first to set cookies/session before accessing search pages.
- Hotel detail pages (e.g., `/hotel/tr/some-hotel.en-gb.html`) load directly without
  the WAF challenge when called from a prior homepage session.

## How Search Works

Booking.com renders search results **server-side** (SSR HTML), not via GraphQL.
The key is the `dest_id` URL parameter which identifies the destination.

1. Navigate to homepage to set cookies
2. POST GraphQL `autoCompleteSuggestions` to get dest_id for the search location
3. Navigate to searchresults URL with dest_id to get SSR hotel cards
4. Extract data from `[data-testid="property-card"]` elements

## Selectors Used (All Stable)

### Search Cards
- `[data-testid="property-card"]` — card container
- `[data-testid="title"]` — hotel name
- `[data-testid="review-score"]` — review score + count text (e.g., "Scored 8.7 8.7Fabulous 3,095 reviews")
- `[data-testid="secondary-review-score-link"]` — secondary score (e.g., "Location 9.5")
- `[data-testid="price-and-discounted-price"]` — best price
- `[data-testid="taxes-and-charges"]` — tax note
- `[data-testid="address-link"]` — hotel address/district
- `[data-testid="distance"]` — distance from centre
- `[data-testid="title-link"]` — hotel URL
- `[data-testid="rating-squares"]` or `[data-testid="rating-stars"]` with aria-label — star rating
- `[data-testid="recommended-units"]` — room type
- `[data-testid="property-card-deal"]` — deal badge (e.g., Limited-time Deal)

### Hotel Detail Page
- JSON-LD `<script type="application/ld+json">` — name, address, rating, reviewCount, description, image, url
- `[data-testid="rating-stars"]` aria-label — star count
- `[data-testid="review-score-right-component"]` — review score + count
- `[data-testid="PropertyHeaderAddressDesktop-wrapper"]` — address + location score
- `[data-testid="property-description"]` — hotel description
- `[data-testid="property-most-popular-facilities-wrapper"]` — popular amenities
- `[data-testid="facility-icon"]` — individual facility items
- `[data-testid="review-subscore"]` — review category scores (e.g., "Free WiFi 9.5")
- `[data-testid="poi-block-list"]` — nearby places of interest
- `[data-testid="featuredreviewcard-text"]` — featured guest review
- `[data-testid="featuredreviewcard-avatar"]` — reviewer info
- `img[src*="bstatic.com"]` — hotel photos (bstatic is Booking.com's CDN)

## Auth
No login required for public data. `BOOKING_COOKIES` env var (JSON array) can be set
for authenticated access (Genius discounts, wishlist, etc.) but is not required.

## Known Limits
- Search returns max ~25 properties per page (pagination supported via `offset` param)
- Hotel pages load correctly after WAF challenge passes (~5-10s wait)
- Prices depend on dates and IP-based geo-detection (EUR shown from European IPs)
