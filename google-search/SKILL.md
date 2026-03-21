# Google Search — Agent Browser Skills

Scrapes Google Search results using a fingerprinted Firefox browser (camoufox-js).

## Skills

| Skill | Description |
|-------|-------------|
| `google-search-scraper` | Full SERP scraper: organic results, featured snippets, PAA, ads, local pack, knowledge panel |

## Anti-Bot Notes

Google aggressively detects automated browser traffic. This skill requires:

1. **Residential IP proxy** — set `SOCKS5_PROXY=host:port` before running
2. **Fresh browser session** — do not reuse camoufox profiles across requests
3. **Correct Google domain** — match the domain to the proxy's country:
   - Turkish residential IP → use `--country com.tr`
   - US residential IP → use `--country com` (default)
4. **Rate limiting** — after a few requests from the same IP, Google will block. Rotate IPs.

## Residential Proxy Setup (Vodafone Turkey via enp38s0)

Start the SOCKS5 proxy on `192.168.1.11` that routes through the residential interface:

```bash
nohup python3 /tmp/socks5_residential.py > /tmp/socks5_res.log 2>&1 &
```

Then on the laptop, set up an SSH tunnel:

```bash
ssh -f -N karacasoft@192.168.1.11 -L 127.0.0.1:11090:127.0.0.1:18081
```

Then run the scraper with the proxy:

```bash
SOCKS5_PROXY=127.0.0.1:11090 node google-search-scraper.mjs "your query" --max 10 --country com.tr
```

## Directory Structure

```
google-search/
  SKILL.md                    ← this file
  package.json
  lib/
    utils.mjs                 ← shared utilities
  google-search-scraper/
    SKILL.md                  ← detailed skill docs
    scripts/
      google-search-scraper.mjs
```
