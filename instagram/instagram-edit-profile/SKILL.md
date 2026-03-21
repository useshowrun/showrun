# Instagram Edit Profile Skill

Updates Instagram profile via real browser automation (camoufox).
Navigates to `/accounts/edit/`, fills the form, clicks Submit — no API calls.

## Usage

```bash
node instagram-edit-profile/scripts/instagram-edit-profile.mjs \
  --name "Curiosity Byte" \
  --bio "🧠 One mind-blowing fact every day. Follow or stay boring." \
  --url "https://curiosity.byte"
```

All options are optional — only provided fields are updated.

## Options
| Option | Description |
|--------|-------------|
| `--name` | Display name |
| `--bio`  | Bio text (max 150 chars) |
| `--url`  | Website URL |

## Requirements
- Logged-in session: `~/.instagram-session.json` (run `instagram-login` first)
- Camoufox profile: `~/.instagram-browser-profile/` (populated by login)
- Xvfb installed (uses `headless: "virtual"`)

## Output
```json
{ "success": true, "updated": { "name": "Curiosity Byte", "bio": "..." } }
```
