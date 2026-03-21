# Website Contact Info Scraper

Extracts contact information from any website: emails, phone numbers, physical address, social media links, and contact form URL.

## Strategy

1. Navigate to the target URL with camoufox (fingerprinted Firefox)
2. Also try `/contact`, `/about`, `/contact-us` pages (configurable)
3. Data extraction methods (in order of quality):
   - **Schema.org JSON-LD** — highest quality; parses `Organization.email`, `telephone`, `address`, `sameAs`
   - **`mailto:` links** — directly actionable email links
   - **`tel:` links** — directly actionable phone links
   - **Social domain link scanning** — detect social profile links by domain
   - **Text regex patterns** — email regex and phone number regex on full page text
   - **Open Graph / meta tags** — `og:site_name`, `og:description`, `meta[name=description]`
4. Deduplicate and normalize (phones by digits, emails by address, social by platform)

### Self-Reference Filtering

When a website (e.g., github.com) has links to its own domain (e.g., github.com/events/...), those are filtered out from social links to avoid false positives.

### Schema.org Support

The best results come from sites that include `application/ld+json` structured data with:
```json
{
  "@type": "Organization",
  "email": "info@company.com",
  "telephone": "+1-555-123-4567",
  "address": { "streetAddress": "...", "addressLocality": "...", ... },
  "sameAs": ["https://twitter.com/company", "https://instagram.com/company"]
}
```

## Usage

```bash
# Basic: check main page + common contact subpages
node contact-info.mjs https://example.com

# Skip extra pages (faster, main page only)
node contact-info.mjs https://example.com --no-contact-pages

# Check more pages (up to 3)
node contact-info.mjs https://example.com --depth 3

# Works without https:// prefix
node contact-info.mjs example.com
```

## Output

```json
{
  "url": "https://stripe.com/nl",
  "name": "Stripe",
  "description": "Stripe is een platform voor financiële diensten...",
  "emails": ["sales@stripe.com"],
  "phones": [],
  "address": null,
  "social": {
    "github": "https://github.com/stripe",
    "youtube": "https://www.youtube.com/watch?v=...",
    "linkedin": "https://linkedin.com/company/stripe",
    "twitter": "https://x.com/stripe",
    "facebook": "https://www.facebook.com/stripedevelopers",
    "instagram": "https://www.instagram.com/stripe"
  },
  "contactFormUrl": "https://stripe.com/nl/contact/sales",
  "pagesChecked": ["https://stripe.com/nl", "https://stripe.com/nl/contact/sales"]
}
```

## Supported Social Platforms

| Platform | Domains Detected |
|----------|-----------------|
| instagram | instagram.com |
| twitter | twitter.com, x.com |
| facebook | facebook.com, fb.com |
| linkedin | linkedin.com |
| tiktok | tiktok.com |
| youtube | youtube.com, youtu.be |
| pinterest | pinterest.com |
| snapchat | snapchat.com |
| discord | discord.gg, discord.com |
| github | github.com |
| crunchbase | crunchbase.com |
| twitch | twitch.tv |
| telegram | t.me, telegram.me |
| whatsapp | wa.me, api.whatsapp.com |

## Selector Stability

- **Zero CSS class selectors** — all data from link href attributes and text content
- `mailto:` and `tel:` link extraction: stable web standard
- Schema.org JSON-LD: stable structured data standard
- Social link detection by hostname: stable (domains don't change)
- Text regex: fallback, handles unlabeled contact data

## Known Limitations

- Sites that load contact info dynamically after interaction may miss data (requires `--depth 3` or more)
- Phone regex may produce false positives (e.g., product SKUs, dates)
- Email regex may find example/placeholder emails in docs/demo pages
- Very SPA-heavy sites may need extra delay (not currently configurable)
- Some sites block all scrapers (Cloudflare, etc.) — returns what's available before blocking

## Files

- `scripts/contact-info.mjs` — main scraper script
- `../../lib/utils.mjs` — shared utilities (normalizeUrl, emitResult, etc.)
