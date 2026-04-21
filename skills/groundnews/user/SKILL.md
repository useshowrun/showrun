# groundnews-user

Fetch Ground News user profile data, feed settings, subscription info, and manage interests from the terminal. All API-based — no browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/pasky/chrome-cdp-skill/tree/main/skills/chrome-cdp) skill (only for `auth` step)

## Setup

One-time authentication — extracts `GROUND_LOGIN_TOKEN` cookie from an open Ground News tab in Chrome:

```bash
node scripts/groundnews-user.mjs auth
```

This saves your Ground News session to disk. After auth, Chrome is no longer needed.

## Usage

### View your profile

```bash
node scripts/groundnews-user.mjs me
```

Returns: name, email, subscription status, edition, timezone, registered date, follow/follower counts, notification settings.

### Feed filter preferences

```bash
node scripts/groundnews-user.mjs settings
```

Returns: blindspotFilter, sourceSort, paywallFilter, ownershipFilter, factualityFilter, localityFilter.

### Subscription plans

```bash
node scripts/groundnews-user.mjs plans
```

Returns: plan name, status, trial info, start/end dates, renewal status.

### Feature entitlements

```bash
node scripts/groundnews-user.mjs policies
```

Returns: each policy/feature and its limit for your subscription tier.

### Followed interests

```bash
node scripts/groundnews-user.mjs my-interests
node scripts/groundnews-user.mjs my-interests --limit=50 --offset=10
```

Returns: name, type, slug, pinned status, notification subscription status. Default limit: 100, max: 500.

### Count of followed interests

```bash
node scripts/groundnews-user.mjs interest-count
```

### Follow / Unfollow an interest

```bash
node scripts/groundnews-user.mjs follow <interest-uuid>
node scripts/groundnews-user.mjs unfollow <interest-uuid>
```

### Update a user setting

```bash
node scripts/groundnews-user.mjs update-setting topFeedEdition "top-eu"
node scripts/groundnews-user.mjs update-setting filterViewed "true"
```

Known keys: `topFeedEdition`, `filterViewed`, etc.

### Story interaction status

```bash
node scripts/groundnews-user.mjs story-status <event-id>
```

Returns: commentCount, youFollow, interests with follow status, proInteractionLimit.

### Blindspot email subscription

```bash
node scripts/groundnews-user.mjs blindspot-email
```

### Show help

```bash
node scripts/groundnews-user.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts the `GROUND_LOGIN_TOKEN` cookie from an open Ground News tab using `Network.getCookies`, saves the token to disk.

2. **`me`** — Calls `GET /v04/user/geo` (the richest profile endpoint) with the auth token. Returns full user profile including subscription status, edition, timezone, and social counts.

3. **`settings`** — Calls `GET /v04/user/settings` to retrieve feed filter preferences (blindspot, source sort, paywall, ownership, factuality, locality filters).

4. **`plans`** — Calls `GET /v04/user/plans` for subscription plan details including trial info and renewal status.

5. **`policies`** — Calls `GET /v04/account/policies` for feature entitlements and limits based on subscription tier.

6. **`my-interests`** — Calls `GET /v04/interests/listMy` with pagination to list followed interests.

7. **`interest-count`** — Calls `GET /v04/interests/myFollowedInterestCount` for a simple count.

8. **`follow`/`unfollow`** — Both call `POST /v04/interests/updateMy` with `{ interestId, action: "follow"|"unfollow" }`. The `action` field is required.

9. **`update-setting`** — Calls `POST /v04/user/set` with a partial user object to update a single setting.

10. **`story-status`** — Calls `GET /v04/eventRoom/feedUserData/:id` (without `?fields=` param for full data) to get user's interaction with a specific story.

11. **`blindspot-email`** — Calls `GET /v04/mailing/isSubscribed/blindspot` to check blindspot email subscription status.

## Account tier

All read commands (`me`, `plans`, `policies`, `settings`, `my-interests`, `interest-count`, `story-status`, `blindspot-email`) work on the free tier.

**`policies` is the authoritative free-vs-paid map.** The endpoint returns 24 feature flags with explicit `enabled` / `limit` fields. No guessing needed — query it first before assuming a feature is gated. On free, 16 binary features are disabled (e.g. `customizeBias`, `customizeFactuality`, `factualityData`, `ownershipData`, `canViewStoryLevelTimelines`, `createCustomFeeds`, `mnb-tier-1/2/3`, `newsRoomSrcFilterBias/Locality/Paywall`) and 4 hard limits apply (`altMediaMentionLimit: 1`, `customFeedInterestsLimit: 10`, `customFeedLimit: 1`, `interestLimit: 30`).

Consequence for write ops:

- `follow <uuid>` — succeeds until `policies.interestLimit` (30 on free) is hit. Beyond the cap the API rejects; prior follows remain.
- `unfollow <uuid>` — always allowed.
- `update-setting <k> <v>` — subject to the same per-key policy gates; some keys won't stick on free.

**Note:** policy flags like `factualityData` and `ownershipData` gate UI features (customization, filtering), not raw data. Aggregate factuality and ownership numbers still come back through `feed story-full` and `interests source`. The genuine silent paywall is per-source factuality in the `feed sources` endpoint (see that skill's SKILL.md).

## API details

- **Base URL**: `https://web-api-cdn.ground.news/api`
- **Auth**: `Authorization: <token>` header + `x-gn-v: web` header
- **Token**: `GROUND_LOGIN_TOKEN` cookie from `ground.news` domain
- **POST endpoints** require `Content-Type: application/json`

## Data storage

```
~/.local/share/showrun/data/groundnews-user/
├── session.json                     # Auth token
└── cache/
    ├── me.json                      # User profile
    ├── settings.json                # Feed settings
    ├── plans.json                   # Subscription plans
    ├── policies.json                # Feature policies
    ├── my-interests.json            # Followed interests
    ├── interest-count.json          # Interest count
    ├── follow-<id>.json             # Follow result
    ├── unfollow-<id>.json           # Unfollow result
    ├── update-setting.json          # Setting update result
    ├── story-status-<id>.json       # Story interaction data
    └── blindspot-email.json         # Blindspot email status
```

## Session expiry

If you see `Session expired (401)`, your token has expired. Open Ground News in Chrome and re-run:

```bash
node scripts/groundnews-user.mjs auth
```
