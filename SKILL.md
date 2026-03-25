# ShowRun Skills

Terminal-based automation skills for data platforms. Each skill provides CLI commands that interact with platform APIs directly — no browser needed after initial auth.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging (only for one-time auth per platform)

## Getting Started

### 1. Login

```bash
node showrun.mjs login you@example.com
```

You'll receive an email with a magic link and a 6-digit code. Paste either one when prompted:

```
Paste magic link or OTP code: 482910
```

Your API key is saved to `${XDG_CONFIG_HOME:-$HOME/.config}/showrun/config.json`.

**Headless (agent with email access):** The agent can extract the OTP or magic link token from the email and pass it non-interactively:

```bash
node showrun.mjs verify you@example.com 482910
```

### 2. Sync skills

```bash
node showrun.mjs sync
```

Downloads all available skills to the local `skills/` directory.

### 3. Use a skill

Read the skill's `SKILL.md` for setup and usage instructions, then run its script:

```bash
cat skills/linkedin/legacy/profile/SKILL.md
node skills/linkedin/legacy/profile/scripts/linkedin-profile.mjs view johndoe
```

## Navigating Skills

Skills are organized as **Platform / App / Skill**:

```bash
ls skills/                              # list platforms
ls skills/linkedin/                     # list apps (legacy, salesnav)
ls skills/linkedin/salesnav/            # list skills in an app
ls skills/crunchbase/                   # flat platforms list skills directly
```

Platforms with multiple products (like LinkedIn) have sub-apps. Others list skills directly under the platform folder.

Each skill is self-contained:
```
skills/<platform>/<skill>/
├── SKILL.md                # usage docs, prerequisites, examples
└── scripts/<name>.mjs      # the executable script
```

## Checking for Updates

```bash
node showrun.mjs check
```

Shows new, updated, and removed skills since your last sync.

## Commands Reference

```
showrun.mjs login <email>           Request access (sends magic link + OTP)
showrun.mjs verify <email> <code>   Verify with OTP code or magic link token
showrun.mjs sync [path]             Download/update skills (optionally filter by platform or skill)
showrun.mjs check                   Show available updates
showrun.mjs whoami                  Show current user info
```
