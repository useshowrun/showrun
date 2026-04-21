# crunchbase-companies

Fetch detailed company profiles from Crunchbase including funding rounds, acquisitions, investors, employees, and tech stack.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Crunchbase account (logged in via Chrome)

## Setup

```bash
node crunchbase-companies.mjs auth
```

## Usage

```bash
# View company by permalink (from Crunchbase URL)
node crunchbase-companies.mjs view google
node crunchbase-companies.mjs view anthropic

# Pick which profile-page layout to request.
# Default is v3 (what crunchbase.com's web UI currently uses).
# v2 is an alternate layout with a different set of cards (more people/investor
# fields, fewer activity/FAQ cards).
# `both` fires v2 AND v3 in parallel and merges — ~117 unique cards on a
# mature company vs 92 for v3 alone. Costs one extra HTTP call.
node crunchbase-companies.mjs view anthropic --view=v2
node crunchbase-companies.mjs view anthropic --view=both

# View by UUID
node crunchbase-companies.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711

# Section commands (all support --count=N --after-id=UUID for pagination)
node crunchbase-companies.mjs investments <permalink|uuid>
node crunchbase-companies.mjs exits <permalink|uuid>
node crunchbase-companies.mjs funding_rounds <permalink|uuid>
node crunchbase-companies.mjs acquisitions <permalink|uuid>
node crunchbase-companies.mjs employees <permalink|uuid>
node crunchbase-companies.mjs advisors <permalink|uuid>
node crunchbase-companies.mjs news <permalink|uuid>
node crunchbase-companies.mjs sub_organizations <permalink|uuid>
node crunchbase-companies.mjs alumni <permalink|uuid>
node crunchbase-companies.mjs funds <permalink|uuid>
node crunchbase-companies.mjs products <permalink|uuid>

# Examples with options
node crunchbase-companies.mjs funding_rounds anthropic --count=20
node crunchbase-companies.mjs acquisitions google --count=50
node crunchbase-companies.mjs employees openai
node crunchbase-companies.mjs news google --count=20
node crunchbase-companies.mjs exits berkshire-hathaway
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/organizations/{uuid}?layout_mode=view_v3` (or `view_v2` or both, per `--view` flag). The `layout_mode` parameter triggers the server's full profile-page card set regardless of which `card_ids` you pass — the `card_ids` parameter is additive for anything not in that default set (e.g. `news_list`). Per-layout counts on a mature company (Anthropic): v3 → 92 cards, v2 → 94 cards, both merged → 117 unique cards. v2 and v3 each have ~25 cards the other doesn't: v2 emphasises people/investor/event-appearance data, v3 emphasises activity (awards, offices, partnerships, product launches), FAQ cards, and growth/prediction cards.
3. Section commands — Use the overrides endpoint `POST /v4/data/entities/organizations/{permalink}/overrides?field_ids=[...]&section_ids=[...]` to fetch paginated section data

Cards returned by `view` (indicative list for a large company like Anthropic):

- **Overview & description**: `overview_fields_extended`, `overview_company_fields`, `overview_description`, `overview_investor_fields`, `overview_timeline`, `about_short_description`, `company_about_fields1/2`, `social_fields`, `contacts`, `contact_fields`
- **Funding**: `funding_rounds_list` (10), `funding_rounds_headline`, `funding_rounds_summary`, `investors_list` (10), `investors_headline`, `investors_summary`, `investments_list` (10), `investments_headline`, `investments_summary`, `funding_prediction`, `diversity_spotlight_investments_*` (3 cards)
- **Acquisitions & exits**: `acquisitions_list`, `acquisitions_headline`, `acquisitions_summary`, `acquired_by_fields`, `acquired_by_summary`, `acquisition_prediction`, `exits_headline`, `exits_image_list`, `exits_summary`
- **People**: `current_employees_featured_order_field` (10), `current_employees_image_list`, `current_employees_summary`, `current_advisors_image_list`, `advisors_summary`, `alumni_image_list`, `alumni_summary`, `key_employee_change_list` (up to 9), `people_highlights`, `contacts`
- **Growth & tech**: `growth_and_heat`, `growth_knowledge`, `growth_prediction`, `technology_highlights`, `builtwith_summary`, `builtwith_tech_used_list` (10), `semrush_summary`, `semrush_overview`, `semrush_overview_headline`, `semrush_rank_headline`, `semrush_location_list`, `semrush_attribution`, `ipqwery_summary`, `bombora_summary`, `bombora_surge_list` (10), `bombora_attribution`, `apptopia_*` (6 cards), `aberdeen_summary`, `siftery_product_list`, `siftery_summary`
- **Similar companies**: `org_similarity_list` (**100 similar orgs** — the closest thing to a competitor list on free tier), `org_similarity_org_list` (10), `recommended_search`
- **Activity / signals**: `news_list` (10, opt-in via `card_ids`), `awards`, `offices`, `layoff_list`, `legal_proceedings`, `partnership_announcements`, `product_launches`, `product`, `investment_thesis`, `research_insight_text_link`
- **FAQ / summary**: `frequently_asked_questions_total_funding`, `frequently_asked_questions_investors`, `frequently_asked_questions_latest_funding_round`, `frequently_asked_questions_headquarters_location`, `frequently_asked_questions_similar_companies`
- **Other**: `org_category_ranks`, `company_financials_highlights`, `ipo_*` cards, `funds_*` (for investor-type orgs), `sub_organizations_*`, `trading_view`

Each list card is still capped at 10 items regardless of `num_*` — for full lists, the section commands (paginated via `--after-id`) remain the right path.

Available sections: investments, exits, funding_rounds, acquisitions, current_employees, advisors, news, sub_organizations, alumni, funds, products

## Data storage

```
~/.local/share/showrun/data/crunchbase-companies/
├── session.json     Auth cookies
└── cache/           Company detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
