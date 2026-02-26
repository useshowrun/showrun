# ShowRun Registry — API Contract

This document specifies the exact HTTP endpoints that the ShowRun client (`@showrun/core` RegistryClient, the `showrun` CLI, and the dashboard) expects from the registry server. Implement these endpoints to enable CLI and dashboard integration.

---

## Authentication

All authenticated endpoints expect:

```
Authorization: Bearer <accessToken>
```

Access tokens are JWTs with an `exp` claim. The client proactively refreshes tokens 60 seconds before expiry.

---

## 1. Device Authorization (OAuth Device Flow — RFC 8628)

The CLI and dashboard authenticate via the Device Authorization Grant. The user's password never leaves the browser.

### 1a. Start Device Flow

```
POST /api/auth/device
Content-Type: application/json
Body: {}
```

**Response 200:**

```json
{
  "deviceCode": "GMMh...long-opaque-string",
  "userCode": "ABCD-1234",
  "verificationUri": "https://registry.example.com/device",
  "expiresIn": 900,
  "interval": 5
}
```

| Field             | Type   | Description                                              |
|-------------------|--------|----------------------------------------------------------|
| `deviceCode`      | string | Opaque code the client uses to poll for tokens           |
| `userCode`        | string | Short human-readable code the user enters in the browser |
| `verificationUri` | string | URL the user opens to authorize the device               |
| `expiresIn`       | number | Seconds until the device code expires                    |
| `interval`        | number | Minimum seconds between poll requests                    |

The registry must serve a web page at `verificationUri` where the user can:
1. Log in (if not already authenticated via session/cookie)
2. Enter the `userCode`
3. Approve the device

### 1b. Poll for Token

The client polls this endpoint every `interval` seconds until the user approves, the code expires, or an error occurs.

```
POST /api/auth/device/token
Content-Type: application/json
Body: { "deviceCode": "GMMh..." }
```

**Response when user has NOT yet approved (HTTP 428):**

```json
{
  "error": "authorization_pending"
}
```

**Response when device code has expired (HTTP 428 or 400):**

```json
{
  "error": "expired"
}
```

**Response on successful authorization (HTTP 200):**

```json
{
  "accessToken": "eyJhbG...",
  "refreshToken": "rt-abc123...",
  "user": {
    "id": "uuid",
    "username": "jdoe",
    "email": "jdoe@example.com",
    "displayName": "Jane Doe"
  }
}
```

The `user` object must include at least `id`, `username`, and `email`. `displayName` is optional.

---

## 2. Token Refresh

```
POST /api/auth/refresh
Content-Type: application/json
Body: { "refreshToken": "rt-abc123..." }
```

**Important:** The client sends the refresh token in the **JSON body**, not as a cookie. The endpoint must accept it from the body.

**Response 200:**

```json
{
  "accessToken": "eyJhbG...new-token"
}
```

**Response 401 (invalid/expired refresh token):**

```json
{
  "message": "Invalid refresh token"
}
```

On refresh failure, the client clears stored tokens and tells the user to run `showrun registry login` again.

---

## 3. Current User

```
GET /api/auth/me
Authorization: Bearer <accessToken>
```

**Response 200:**

```json
{
  "id": "uuid",
  "username": "jdoe",
  "email": "jdoe@example.com",
  "displayName": "Jane Doe"
}
```

---

## 4. List / Search Packs

```
GET /api/packs?q=<query>&page=<N>&limit=<N>
```

No authentication required for public packs.

**Response 200:**

```json
{
  "data": [
    {
      "id": "uuid",
      "slug": "example-json",
      "name": "Example JSON Pack",
      "description": "An example task pack",
      "visibility": "public",
      "latestVersion": "0.1.0",
      "owner": { "id": "uuid", "username": "jdoe" },
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-02T00:00:00.000Z"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20,
  "totalPages": 3
}
```

All query params are optional. Without `q`, returns all packs. `page` defaults to 1, `limit` defaults to 20.

---

## 5. Get Pack Detail

```
GET /api/packs/:slug
```

No authentication required for public packs.

**Response 200:**

```json
{
  "id": "uuid",
  "slug": "example-json",
  "name": "Example JSON Pack",
  "description": "An example task pack",
  "visibility": "public",
  "latestVersion": "0.1.0",
  "owner": { "id": "uuid", "username": "jdoe" },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-02T00:00:00.000Z",
  "versions": [
    {
      "version": "0.1.0",
      "changelog": "Initial release",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**Response 404 (pack not found):**

```json
{
  "message": "Pack not found"
}
```

---

## 6. Create Pack

Used by the publish flow. The client calls this automatically when publishing to a slug that doesn't exist yet.

```
POST /api/packs
Authorization: Bearer <accessToken>
Content-Type: application/json
Body:
{
  "slug": "my-pack",
  "name": "My Pack",
  "description": "Does something useful",
  "visibility": "public"
}
```

**Response 201:**

```json
{
  "id": "uuid",
  "slug": "my-pack",
  "name": "My Pack",
  ...
}
```

`visibility` is `"public"` or `"private"`. Slug must be unique per user.

---

## 7. Publish Version

```
POST /api/packs/:slug/versions
Authorization: Bearer <accessToken>
Content-Type: application/json
Body:
{
  "version": "0.1.0",
  "manifest": {
    "id": "my-pack",
    "name": "My Pack",
    "version": "0.1.0",
    "description": "Does something useful",
    "kind": "json-dsl"
  },
  "flow": {
    "inputs": {},
    "collectibles": [],
    "flow": [ ...steps... ]
  },
  "changelog": "Initial release"
}
```

**Response 201:**

```json
{
  "version": "0.1.0"
}
```

`manifest` is the task pack's `taskpack.json` contents. `flow` is the task pack's `flow.json` contents. `changelog` is optional.

The registry should reject duplicate version numbers for the same pack (HTTP 409).

---

## 8. Get Version (for install)

```
GET /api/packs/:slug/versions/:version
```

No authentication required for public packs.

**Response 200:**

```json
{
  "manifest": {
    "id": "my-pack",
    "name": "My Pack",
    "version": "0.1.0",
    "description": "Does something useful",
    "kind": "json-dsl"
  },
  "flow": {
    "inputs": {},
    "collectibles": [],
    "flow": [ ...steps... ]
  }
}
```

The client writes `manifest` to `taskpack.json` and `flow` to `flow.json` in the local pack directory.

---

## Error Format

All error responses should use this shape:

```json
{
  "message": "Human-readable error description"
}
```

The client reads the `message` field from error responses and displays it to the user.

---

## Summary Table

| Method | Path                             | Auth     | Purpose                  |
|--------|----------------------------------|----------|--------------------------|
| POST   | `/api/auth/device`               | No       | Start device login flow  |
| POST   | `/api/auth/device/token`         | No       | Poll for device tokens   |
| POST   | `/api/auth/refresh`              | No       | Refresh access token     |
| GET    | `/api/auth/me`                   | Bearer   | Get current user profile |
| GET    | `/api/packs`                     | No       | List / search packs      |
| GET    | `/api/packs/:slug`               | No*      | Get pack detail          |
| POST   | `/api/packs`                     | Bearer   | Create new pack          |
| POST   | `/api/packs/:slug/versions`      | Bearer   | Publish a version        |
| GET    | `/api/packs/:slug/versions/:ver` | No*      | Get version for install  |

*Private packs require Bearer auth for read operations too.
