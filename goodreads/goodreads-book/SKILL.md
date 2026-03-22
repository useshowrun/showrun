# goodreads-book

Scrape full book details and reader reviews from a Goodreads book page.

## Usage

```bash
node goodreads-book.mjs "<book-url-or-id>" [--max-reviews N]
node goodreads-book.mjs '{"id":"44767458","maxReviews":30}'
```

## Input

**Positional args:**
- `<book-url-or-id>` — One of:
  - Full URL: `https://www.goodreads.com/book/show/44767458-dune`
  - Numeric ID: `44767458`
  - ID-slug: `44767458-dune`
  - Dotted legacy: `3.Harry_Potter_and_the_Sorcerer_s_Stone`

**Flags:**
- `--max-reviews N` — Max reviews to return (default: 30; embedded limit = 30; >30 requires camoufox)

**JSON input (alternative):**
```json
{
  "id": "44767458-dune",
  "maxReviews": 30
}
```

## Output

```json
RESULT:{
  "bookId": "44767458",
  "title": "Dune",
  "originalTitle": "Dune",
  "titleComplete": "Dune (Dune Chronicles, #1)",
  "authors": [
    {
      "id": "58",
      "name": "Frank Herbert",
      "url": "https://www.goodreads.com/author/show/58.Frank_Herbert",
      "imageUrl": "https://...",
      "role": "Author",
      "followersCount": 123456,
      "worksCount": 89
    }
  ],
  "isbn": "0441013597",
  "isbn13": "9780441013593",
  "asin": "0441013597",
  "rating": 4.25,
  "ratingsCount": 1250000,
  "reviewsCount": 45000,
  "ratingDistribution": { "1": 15000, "2": 25000, "3": 100000, "4": 350000, "5": 760000 },
  "description": "Set on the desert planet Arrakis...",
  "genres": ["Science Fiction", "Fiction", "Fantasy", "Classics"],
  "series": [{ "id": "...", "title": "Dune Chronicles", "url": "...", "position": "1" }],
  "publisher": "Ace",
  "publishedDate": "2019-12-30",
  "pages": 896,
  "language": "English",
  "format": "Paperback",
  "coverUrl": "https://...",
  "coverImageLarge": "https://...",
  "awards": [{ "name": "Hugo Award", "url": "...", "year": 1966, "category": "Best Novel", "designation": "WINNER" }],
  "places": [{ "name": "Arrakis", "country": null, "url": "..." }],
  "characters": [{ "name": "Paul Atreides", "url": "..." }],
  "url": "https://www.goodreads.com/book/show/44767458-dune",
  "workId": "3327623",
  "quotesCount": 1234,
  "questionsCount": 56,
  "reviews": [
    {
      "id": "kca://review:goodreads/...",
      "reviewer": {
        "id": 12345678,
        "name": "Jane Reader",
        "webUrl": "https://www.goodreads.com/user/show/...",
        "imageUrl": "https://...",
        "isAuthor": false,
        "followersCount": 123,
        "textReviewsCount": 45
      },
      "rating": 5,
      "date": "2024-01-15T10:30:00.000Z",
      "text": "An absolute masterpiece...",
      "likes": 42,
      "spoilerStatus": false,
      "shelves": { "...": "..." }
    }
  ],
  "reviewsSource": "embedded"
}
```

## Environment Variables

- `SOCKS5_PROXY` — Optional SOCKS5 proxy (host:port)

## Anti-bot Notes

- Goodreads book pages respond with HTTP 200 to standard Firefox User-Agent
- **No browser required for basic scraping** — direct HTTPS fetch works
- The page contains full `__NEXT_DATA__` Apollo state with 30 reviews pre-embedded
- For >30 reviews: camoufox is used to intercept XHR to Apollo GraphQL endpoint
- Follows HTTP redirects (legacy IDs like `3.Harry_Potter...` auto-redirect)

## Data Source

Goodreads book HTML (`/book/show/<id>`):

**Primary: `__NEXT_DATA__` Apollo State**
- `Book:*` — title, titleComplete, description, imageUrl, bookGenres, bookSeries,
  details (isbn, isbn13, asin, format, numPages, publisher, language, publicationTime),
  primaryContributorEdge, secondaryContributorEdges
- `Work:*` — originalTitle, stats (averageRating, ratingsCount, ratingsCountDist,
  textReviewsCount), choiceAwards, details (awardsWon, places, characters)
- `Contributor:*` — name, webUrl, profileImageUrl, legacyId, followers.totalCount
- `Series:*` — title, webUrl
- `Review:*` — 30 reviews with id, rating, text, createdAt, likeCount, spoilerStatus,
  shelving, creator (reviewer info)

**Fallback: JSON-LD `Book` schema**
- name, image, bookFormat, numberOfPages, inLanguage, isbn, author,
  aggregateRating (ratingValue, ratingCount, reviewCount)
