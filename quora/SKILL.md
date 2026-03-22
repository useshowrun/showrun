# Quora Scraper

**Status:** ❌ BLOCKED — Cloudflare Managed Challenge

Scrapes Quora (quora.com) for Q&A content: questions by topic, answers, upvotes, and author info.

## Block Reason

Quora uses **Cloudflare Managed Challenge** (`cType: 'managed'`) on all pages including:
- RSS feeds (`/topic/<Topic>/rss`)
- Topic pages (`/topic/<Topic>`)
- Question pages (`/<question-slug>`)
- All API endpoints

Both direct HTTP requests and camoufox headless Firefox are blocked from datacenter and Turkish IPs.

**Solution:** Set `SOCKS5_PROXY=host:port` with a US/EU **residential proxy** to bypass Cloudflare.

## Skills

| Skill | Script | Description |
|-------|--------|-------------|
| `quora-topic` | `quora-topic/scripts/quora-topic.mjs` | Questions from a topic page |
| `quora-question` | `quora-question/scripts/quora-question.mjs` | Answers from a question page |

## Usage

```bash
# Topic questions (blocked without proxy)
node quora-topic/scripts/quora-topic.mjs "Artificial Intelligence" --max 20

# With residential proxy
SOCKS5_PROXY=127.0.0.1:11090 node quora-topic/scripts/quora-topic.mjs "Machine Learning" --max 20

# Question answers (blocked without proxy)
node quora-question/scripts/quora-question.mjs "https://www.quora.com/What-is-artificial-intelligence"

# With residential proxy
SOCKS5_PROXY=127.0.0.1:11090 node quora-question/scripts/quora-question.mjs "https://www.quora.com/What-is-AI" --max-answers 10
```

## Data Schema

### Topic Questions (`quora-topic`)

```json
{
  "topic": "Artificial-Intelligence",
  "topicUrl": "https://www.quora.com/topic/Artificial-Intelligence",
  "questions": [
    {
      "questionId": "What-is-artificial-intelligence",
      "title": "What is artificial intelligence?",
      "url": "https://www.quora.com/What-is-artificial-intelligence",
      "viewCount": "1.2M",
      "answerCount": 847,
      "askedAt": "2014-03-15T00:00:00.000Z"
    }
  ],
  "total": 20,
  "source": "rss",
  "blocked": false
}
```

### Question Answers (`quora-question`)

```json
{
  "questionId": "What-is-artificial-intelligence",
  "title": "What is artificial intelligence?",
  "url": "https://www.quora.com/What-is-artificial-intelligence",
  "viewCount": "1.2M",
  "answerCount": 847,
  "askedAt": "2014-03-15T00:00:00.000Z",
  "answers": [
    {
      "authorName": "John Smith",
      "authorCredential": "PhD in Computer Science, MIT",
      "upvotes": "12.5K",
      "text": "Artificial intelligence (AI) is the simulation of human intelligence...",
      "createdAt": "2018-06-20T00:00:00.000Z",
      "isTopAnswer": true
    }
  ],
  "total": 10,
  "source": "browser",
  "blocked": false
}
```

## Data Sources

When accessible, data is extracted via this priority chain:

1. **RSS Feed** (`/topic/<Topic>/rss`) — clean XML, fastest approach
   - Returns: title, URL, pubDate, description
   - No view counts or answer counts in RSS

2. **Direct HTTP** — fastest for question pages
   - JSON-LD `QAPage` schema: title, answerCount, acceptedAnswer, suggestedAnswer
   - Returns structured data for accepted answers

3. **Camoufox Browser** — for JS-rendered content after CF bypass
   - DOM extraction via stable `[aria-label*="Upvote"]` buttons for answer detection
   - Author info from `a[href*="/profile/"]` links
   - No brittle CSS class selectors

## Anti-Bot Notes

- **Cloudflare managed challenge** — not a JS-only challenge, requires IP reputation
- `cType: 'managed'` means visual CAPTCHA or IP allowlist — can't be auto-solved
- camoufox can solve JS challenges (`cType: 'non-interactive'`) but NOT managed challenges
- Residential proxy routes traffic through a legitimate home IP, bypassing IP reputation filter

## Proxy Setup

```bash
# SSH tunnel to desktop with residential connection
ssh -f -N karacasoft@192.168.1.11 -L 127.0.0.1:11090:127.0.0.1:18081

# Test proxy
curl --socks5 127.0.0.1:11090 https://ipapi.co/ip/

# Run with proxy
SOCKS5_PROXY=127.0.0.1:11090 node quora-topic/scripts/quora-topic.mjs "AI" --max 10
```

## Node Version

```bash
source ~/.nvm/nvm.sh && nvm use 24
```
