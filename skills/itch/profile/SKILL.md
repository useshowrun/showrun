# itch-profile

Read and edit the logged-in user's itch.io profile and account settings — bio, social links, display name, avatar, notification preferences, privacy settings, and the dark-mode toggle. **DRY-RUN by default** — every mutation prints the full request and only sends when `--live` is passed.

## Prerequisites

- Node.js 22+
- Run `itch-auth` once to populate `~/.local/share/showrun/data/itch/session.json`

## Usage

```bash
node scripts/itch-profile.mjs get                                        # current profile values
node scripts/itch-profile.mjs edit --summary="I make indie games"
node scripts/itch-profile.mjs edit --website=https://example.com --twitter=myhandle
node scripts/itch-profile.mjs edit --display-name="My Name" --bluesky=me.bsky.social
node scripts/itch-profile.mjs avatar /path/to/image.png
node scripts/itch-profile.mjs notifications --email-purchases=on --email-followers=off
node scripts/itch-profile.mjs privacy --enable-events=off
node scripts/itch-profile.mjs dark-mode toggle                           # dry-run
node scripts/itch-profile.mjs dark-mode toggle --live                    # reversible — safe to test
```

`edit` first GETs `/user/settings`, parses the current form (CSRF + every visible value), overlays only the flags you passed, and POSTs the full merged body back — so unspecified fields are preserved, not blanked. Field mapping (discovered from live form):

| Flag | Form field |
|---|---|
| `--summary` | `data[profile]` (the bio textarea) |
| `--website` | `data[website]` |
| `--twitter` | `data[twitter]` |
| `--mastodon` | `data[mastodon]` |
| `--bluesky` | `data[bluesky]` |
| `--threads` | `data[threads]` |
| `--display-name` | `user[display_name]` |

## Known pitfalls

- **Avatar upload**: the form file-field name is inferred (`user[cover]`) — not verified end-to-end during discovery. Test with a throwaway image when using `--live`.
- **`/sudo`-gated settings** (api-keys, 2fa, delete-account, credit-cards, oauth-apps) require password re-auth and are intentionally unsupported.
