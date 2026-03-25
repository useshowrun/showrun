# salesnav-lists

CRUD operations on Sales Navigator lead lists and account lists.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp skill] (only for `auth` step)
- LinkedIn Sales Navigator subscription

## Setup

One-time auth — extracts session cookies from an open Sales Navigator tab:

```bash
node salesnav-lists.mjs auth
```

## Usage

### List all lists

```bash
# Lead lists (default)
node salesnav-lists.mjs list

# Account lists
node salesnav-lists.mjs list --type=account

# With pagination
node salesnav-lists.mjs list --type=lead --count=50 --start=0
```

### View a specific list

```bash
node salesnav-lists.mjs view 6789012345
```

### List members of a list

```bash
node salesnav-lists.mjs members 6789012345
node salesnav-lists.mjs members 6789012345 --count=50 --start=0
```

### Create a new list

```bash
node salesnav-lists.mjs create --name="My Target List" --type=lead
node salesnav-lists.mjs create --name="Target Accounts" --type=account --description="Q2 targets"

# Preview without executing
node salesnav-lists.mjs create --name="Test" --type=lead --dry-run
```

### Update a list

```bash
node salesnav-lists.mjs update 6789012345 --name="New Name"
node salesnav-lists.mjs update 6789012345 --description="Updated description"
node salesnav-lists.mjs update 6789012345 --name="New Name" --description="New desc"
```

### Delete a list

```bash
node salesnav-lists.mjs delete 6789012345

# Preview without executing
node salesnav-lists.mjs delete 6789012345 --dry-run
```

### Add entities to a list

```bash
# Add leads
node salesnav-lists.mjs add 6789012345 "urn:li:fs_salesProfile:(ACwAABCD,NAME_SEARCH,abc1)"

# Add multiple (comma-separated)
node salesnav-lists.mjs add 6789012345 "urn:li:fs_salesProfile:(ACwAABCD,NAME_SEARCH,abc1),urn:li:fs_salesProfile:(ACwAAEFGH,NAME_SEARCH,def2)"

# Add accounts
node salesnav-lists.mjs add 6789012345 "urn:li:fs_salesCompany:12345"
```

### Remove entities from a list

```bash
node salesnav-lists.mjs remove 6789012345 "urn:li:fs_salesProfile:(ACwAABCD,NAME_SEARCH,abc1)"
```

## How it works

1. **auth** — Uses CDP to connect to an open Chrome tab with Sales Navigator, extracts cookies (`li_at`, `JSESSIONID`) and saves them locally.
2. **list** — Calls `GET /sales-api/salesApiLists?q=listType&listType=LEAD|ACCOUNT` with sort/filter/decoration params.
3. **view** — Calls `GET /sales-api/salesApiLists/<listId>` with decoration for metadata.
4. **members** — Determines list type, then runs a lead search (`salesApiLeadSearch`) or account search (`salesApiAccountSearch`) filtered by LEAD_LIST or ACCOUNT_LIST.
5. **create** — `POST /sales-api/salesApiLists` with `X-Restli-Method: CREATE` header.
6. **update** — `POST /sales-api/salesApiLists/<listId>` with `X-Restli-Method: PARTIAL_UPDATE` header and REST-li patch body.
7. **delete** — `DELETE /sales-api/salesApiLists/<listId>`.
8. **add/remove** — `POST /sales-api/salesApiLists/<listId>?action=addEntities|removeEntities` with entity URN array body.

## Data storage

```
~/.local/share/showrun/data/salesnav-lists/
├── session.json          Auth cookies and CSRF token
└── cache/
    ├── lists-lead.json   Cached lead lists
    ├── lists-account.json Cached account lists
    ├── list-<id>.json    Cached individual list details
    └── members-<id>.json Cached list members
```

## Session expiry

If you see a 401 or 403 error, re-authenticate:

```bash
node salesnav-lists.mjs auth
```

## Notes

- CRUD operations (create, update, delete, add, remove) use REST-li conventions. These endpoints were inferred from the observed GET patterns and standard REST-li behavior. If any return unexpected results, use `--dry-run` to inspect the request.
- The `--dry-run` flag is available on all mutating commands (create, update, delete, add, remove) to preview the request without executing it.
