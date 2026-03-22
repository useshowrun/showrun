# Scraper Queue — Next TODO Items

This file is the canonical source for what needs to be built next.
Full history and session logs are in SCRAPER_PROGRESS.md.

## 🔴 Up Next (TODO)

| # | Service | Target Site | Notes |
|---|---------|-------------|-------|


| 53 | Threads Scraper | threads.net | Profile, posts, replies, likes |
| 54 | Rightmove Scraper | rightmove.co.uk | UK real estate — property search, listings, details |
| 55 | Zoopla Scraper | zoopla.co.uk | UK real estate — property search, price history |

## ✅ Done (recent)

| # | Service | Skills |
|---|---------|--------|
| 50 | Goodreads Scraper | goodreads-search, goodreads-book |

## ❌ Blocked (need residential proxy or auth cookies)

| # | Service | Reason |
| 52 | Quora | Cloudflare managed challenge on ALL endpoints incl. RSS feeds. 8 bypass strategies tried (curl, Node https, Googlebot UA, camoufox headless/non-headless, Playwright). Needs residential proxy. Code ready — set SOCKS5_PROXY=host:port. |
|---|---------|--------|
| 11 | Reddit | IP-blocked by Cloudflare — needs residential proxy |
| 18 | Indeed | Cloudflare managed challenge from Turkish IP |
| 19 | Zillow | PerimeterX from Turkish IP |
| 26 | LinkedIn Posts | Requires LI_COOKIES |
| 44 | G2 Scraper | DataDome bot protection on all pages from datacenter/Turkish IP. Visual CAPTCHA on product pages. Code ready — set SOCKS5_PROXY=host:port. |
| 47 | Capterra Scraper | Cloudflare Managed Challenge on all pages from datacenter/Turkish IP. Code ready — set SOCKS5_PROXY=host:port. Data in __NEXT_DATA__ (Next.js SSR). |
| 27 | Amazon Reviews | Requires AMZ_COOKIES |
| 35 | Upwork | Cloudflare Turnstile on all search URLs |
| 38 | LinkedIn Ads | Protechts.net bot detection |
| 43 | Realtor.com | Kasada bot protection — blocks Googlebot UA (despite SSR strategy); needs residential proxy |
| 49 | Fiverr Scraper | PerimeterX (pxAppId: PXK3bezZfO) — "It needs a human touch" on all pages from datacenter/Turkish IP. Code ready — set SOCKS5_PROXY=host:port. Data in __NEXT_DATA__ (Next.js SSR). |

## ✅ Done (42 skills)

Google Maps, Instagram, TikTok, Website Crawler, Facebook Posts/Comments/Pages/Ad Library/Marketplace,
YouTube (channel/video/search/comments/transcript), Twitter/X, Amazon (product/search/bestsellers),
LinkedIn (profile/company/jobs), Booking.com, Yelp, Tripadvisor, Airbnb, Trustpilot, Pinterest,
Glassdoor, Etsy, Shopify, Telegram, Product Hunt, Hacker News, Substack, Google Search, Reddit (code ready, blocked),
Craigslist (search + listing detail), Apple App Store (search + app detail + reviews),
**Google Play Store (search + app detail + reviews)**,
**GitHub (search + repo detail + user/org profile)**
