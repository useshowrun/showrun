# pitchbook-search

Search Pitchbook for companies by name or domain.

## Usage

```bash
node scripts/pitchbook-search.mjs search <query> [--limit=5]
```

**Examples:**
```bash
node scripts/pitchbook-search.mjs search "openai"
node scripts/pitchbook-search.mjs search stripe.com --limit=10
```

## Output

Returns matching companies with Pitchbook ID, name, and match type. Results cached to `~/.local/share/showrun/data/pitchbook/cache/search-<query>.json`.
