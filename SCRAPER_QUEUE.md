# Scraper Queue — Next TODO Items

This file is the canonical source for what needs to be built next.
Full history and session logs are in SCRAPER_PROGRESS.md.

## 🔴 Up Next (TODO)

| # | Service | Target Site | Notes |
|---|---------|-------------|-------|
| 41 | Google Maps Reviews Scraper | maps.google.com | Paginate all reviews for a place — go beyond the 10 inline |
| 42 | Craigslist Scraper | craigslist.org | Listings by city+category, title/price/location/description/images |
| 43 | Realtor.com Scraper | realtor.com | US real estate — search by location, price, beds/baths |
| 44 | G2 Scraper | g2.com | Software reviews — product search, ratings, reviews, pricing |
| 45 | Apple App Store Scraper | apps.apple.com | iOS app metadata + reviews |
| 46 | Google Play Store Scraper | play.google.com | Android app metadata + reviews |
| 47 | Capterra Scraper | capterra.com | B2B software reviews — ratings, reviews, pricing, features |
| 48 | GitHub Scraper | github.com | Repos (stars, forks, issues, topics, README), user profiles, search |
| 49 | Fiverr Scraper | fiverr.com | Freelance gigs — search, gig details, seller info, reviews |
| 50 | Goodreads Scraper | goodreads.com | Book metadata + reviews — title, author, rating, genres |
| 51 | Medium Scraper | medium.com | Blog posts by tag/author — title, content, claps, published date |
| 52 | Quora Scraper | quora.com | Q&A content — questions by topic, answers, upvotes |
| 53 | Threads Scraper | threads.net | Profile, posts, replies, likes |
| 54 | Rightmove Scraper | rightmove.co.uk | UK real estate — property search, listings, details |
| 55 | Zoopla Scraper | zoopla.co.uk | UK real estate — property search, price history |

## ❌ Blocked (need residential proxy or auth cookies)

| # | Service | Reason |
|---|---------|--------|
| 11 | Reddit | IP-blocked by Cloudflare — needs residential proxy |
| 18 | Indeed | Cloudflare managed challenge from Turkish IP |
| 19 | Zillow | PerimeterX from Turkish IP |
| 26 | LinkedIn Posts | Requires LI_COOKIES |
| 27 | Amazon Reviews | Requires AMZ_COOKIES |
| 35 | Upwork | Cloudflare Turnstile on all search URLs |
| 38 | LinkedIn Ads | Protechts.net bot detection |

## ✅ Done (34 skills)

Google Maps, Instagram, TikTok, Website Crawler, Facebook Posts/Comments/Pages/Ad Library/Marketplace,
YouTube (channel/video/search/comments/transcript), Twitter/X, Amazon (product/search/bestsellers),
LinkedIn (profile/company/jobs), Booking.com, Yelp, Tripadvisor, Airbnb, Trustpilot, Pinterest,
Glassdoor, Etsy, Shopify, Telegram, Product Hunt, Hacker News, Substack, Google Search, Reddit (code ready, blocked)
