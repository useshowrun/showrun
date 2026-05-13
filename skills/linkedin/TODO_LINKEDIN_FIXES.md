# LinkedIn skill — deferred fixes

Captured live frontend traffic 2026-05-13 and diffed against script URLs. Three one-line fixes were applied in this branch. The items below could not be reduced to a hash/decoration swap because the underlying call shape changed. They require rewrites and live validation.

Capture and diff artifacts: `/home/eyup/Projects/linkedin/captures/2026-05-13/AUDIT_REPORT.md`.

## Shared auth + kill-detection helper

`skills/linkedin/_shared/li-auth.mjs` exports:

- `ensureFreshAuth({ sessionFile })` — reads Chrome's current LinkedIn cookies via CDP, compares against `session.json`'s `li_at`, rewrites the file when they differ. Use at script startup in place of plain `loadJson(SESSION_FILE)`. Caches the freshness check at process scope (one Chrome read per script invocation).
- `detectKillMarkers(resp)` — inspects a fetch `Response` for `Set-Cookie: li_at=delete me` and `Clear-Site-Data: "storage"` and returns `{ killed: bool, killReason: string|null }`. The two signals fire for BOTH stale-cookie responses AND abuse-flag kills — `ensureFreshAuth` rules out the stale case so any remaining `killed=true` is a real abuse signal.
- `killedErrorMessage(url, killReason)` — consistent thrown-error wording for the kill case.

**Migration pattern (already applied to `linkedin-msg.mjs`, `linkedin-jobs.mjs`, `salesnav-lead-search.mjs`):**

```js
import { ensureFreshAuth, detectKillMarkers, killedErrorMessage } from '../../../_shared/li-auth.mjs';

function getAuth() {
  try {
    const auth = ensureFreshAuth({ sessionFile: SESSION_FILE });
    if (!auth.cookie) { console.error('No auth — run auth subcommand'); process.exit(1); }
    return auth;
  } catch (err) {
    console.error(`Could not refresh auth from Chrome: ${err.message}`);
    const cached = loadJson(SESSION_FILE);
    if (cached.cookie) { console.error('Falling back to cached (may be stale).'); return cached; }
    process.exit(1);
  }
}

async function apiFetch(auth, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
    redirect: 'manual', // never follow into the login page
  });
  const { killed, killReason } = detectKillMarkers(resp);
  if (killed) throw new Error(killedErrorMessage(url, killReason));
  // ... existing body handling
}
```

**Migration status: complete across all 14 scripts.**

- [x] `legacy/company/scripts/linkedin-company.mjs`
- [x] `legacy/jobs/scripts/linkedin-jobs.mjs`
- [x] `legacy/messaging/scripts/linkedin-msg.mjs`
- [x] `legacy/posts/scripts/linkedin-posts.mjs`
- [x] `legacy/profile/scripts/linkedin-profile.mjs`
- [x] `legacy/search/scripts/linkedin-search.mjs`
- [x] `salesnav/account-profile/scripts/salesnav-account-profile.mjs`
- [x] `salesnav/account-search/scripts/salesnav-account-search.mjs`
- [x] `salesnav/lead-profile/scripts/salesnav-lead-profile.mjs`
- [x] `salesnav/lead-search/scripts/salesnav-lead-search.mjs`
- [x] `salesnav/lists/scripts/salesnav-lists.mjs`
- [x] `salesnav/messaging/scripts/salesnav-messaging.mjs`
- [x] `salesnav/saved-lead-search/scripts/linkedin-salesnav-saved-lead-search.mjs`
- [x] `salesnav/saved-searches/scripts/salesnav-saved-searches.mjs`

Every script's `getAuth()` now refreshes from Chrome before returning; every `apiFetch()` throws a clear error on `Set-Cookie: li_at=delete me` or `Clear-Site-Data` rather than silently swallowing the headers. `redirect: 'manual'` is set on every fetch so a stealth-revocation 302 cannot be masqueraded as a parse error.

---

## 1. `legacy/profile/scripts/linkedin-profile.mjs:174` — `fetchProfileGraphQL(vanityName)`

**Current:**
```js
const url = `https://www.linkedin.com/voyager/api/graphql?...variables=(vanityName:${...})&queryId=voyagerIdentityDashProfiles.a3de77c32c473719f1c58fae6bff43a5`;
```

**Why it's broken:** LinkedIn retired the `vanityName`-input variant of `voyagerIdentityDashProfiles`. The three queryId variants currently in frontend traffic are all **URN-input only**:
- `voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a` — `(memberIdentity:URN)`
- `voyagerIdentityDashProfiles.4be600f2992df8cd036dba7aef973bab` — `(profileId:URN)`
- `voyagerIdentityDashProfiles.da93c92bffce3da586a992376e42a305` — `(profileUrn:URN)`

A blind hash swap will fail because the input variable name and value type don't match.

**Required rewrite (proposed):**

Two-step flow:

1. **Vanity → URN**: navigate `/in/{vanity}/` in Chrome via CDP and read the SDUI page payload, or scrape the page HTML for the `urn:li:fsd_profile:...` pattern. (LinkedIn's own UI does this implicitly when you load the page.)
2. **URN → full profile data**: call one of the captured URN-input queryIds.

Inspect a captured response body in `captures/2026-05-13/linkedin/reqs/` (the GraphQL calls under phases `li-profile`, `li-profile-experience`) to determine which queryId returns the fields the script currently extracts (`firstName`, `lastName`, `headline`, `MemberRelationship`, `FollowingState`, `Connection`).

**Risk if shipped as-is:** any call to `fetchProfileGraphQL` is high-likelihood session-kill. **Disable this function** until rewrite lands.

---

## 2. `legacy/profile/scripts/linkedin-profile.mjs:517` and `:533` — `listConnections`

**Current:**
```js
// line 517:
const url = `https://www.linkedin.com/voyager/api/relationships/dash/connections?q=search&...`;
// line 533:
const url = `https://www.linkedin.com/voyager/api/identity/dash/profiles/${conn.profileUrn}?decorationId=...FullProfile-76`;
```

**Why it's broken:** Connections page migrated to SDUI/RSC. The legacy REST endpoint `q=search` killed the session on 2026-05-12. The per-profile enrichment with `FullProfile-76` also has no current frontend traffic.

**Required rewrite:** replay the SDUI pager `com.linkedin.sdui.pagers.mynetwork.connectionsList`. Working replay template at `/tmp/sdui-replay.mjs`. Caveats:
- Rate limit: max 1 req/s sequential, no concurrency. Concurrent triggers a 186-byte empty-response throttle (not a kill, but no data either).
- 10 connections per page. For ~500 connections = ~50 sequential POSTs.
- Response is base64-encoded RSC. Names + vanity slugs extractable via regex. No URNs in the response — would need a follow-up resolve per profile if URNs are needed.

**Risk if shipped as-is:** definite session-kill on first call.

---

## 3. `legacy/company/scripts/linkedin-company.mjs:172` — `viewCompany`

**Current:**
```js
const url = `https://www.linkedin.com/voyager/api/organization/companies/${parsed.companyId}?decorationId=...WebFullCompanyMain-35`;
```

**Why it's broken:** Frontend stopped calling this REST endpoint. The company-view page now uses two GraphQL queries:
- `voyagerOrganizationDashViewWrapper.ad9246a9f5d5511234b3b7cf0aa2cd3c`
- `voyagerOrganizationDashCompanies.148b1aebfadd0a455f32806df656c3c1`

**Required rewrite:** identify which of the two queries returns the fields the script currently extracts. Inspect response bodies of phase `li-company` requests in the capture.

**Risk if shipped as-is:** likely session-kill. The decoration `WebFullCompanyMain-35` has been absent from frontend traffic for at least 5 weeks.

---

## 4. `legacy/jobs/scripts/linkedin-jobs.mjs:757` — `listSavedJobs`

**Current:**
```js
const SEARCH_CLUSTER_QUERY_ID = 'voyagerSearchDashClusters.843215f2a3455f1bed85762a45d71be8';
// ...
const variables = `(start:${start},query:(flagshipSearchIntent:${intent}))`;
const url = `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${SEARCH_CLUSTER_QUERY_ID}`;
```

**Why it's broken:** The branch's hash rotation from `05111e1b…` → `843215f2…` swapped to a hash that was captured under a different feature entirely. The only occurrence of `843215f2…` in the 2026-05-13 capture is under phase `li-company-people` with:

```
?includeWebMetadata=true
&variables=(start:0,origin:FACETED_SEARCH,query:(flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI,queryParameters:List(...),includeFiltersInResponse:true),count:12)
&queryId=voyagerSearchDashClusters.843215f2a3455f1bed85762a45d71be8
```

The persisted query at `843215f2…` is the company-alumni cluster search. It does not accept the `SEARCH_MY_ITEMS_JOB_SEEKER` flagship intent the script sends; LinkedIn returns HTTP 401 (controlled rejection, no `Set-Cookie: li_at=delete me`, no `Clear-Site-Data` — session stays alive). The saved-jobs page itself was never navigated during the 2026-05-13 capture, so the actual current queryId + variables for `SEARCH_MY_ITEMS_JOB_SEEKER` is unknown.

**Why the new hash is kept anyway:** The pre-rotation hash `05111e1b…` is absent from current frontend traffic. Per `feedback_verify_before_bump`, that itself is a kill-risk signal. The captured-but-wrong-feature hash returns a clean 401 (verified previous session). Between "broken with controlled 401" and "broken with possible novelty-kill", the 401 path is the safer broken state to ship.

**Required rewrite:** capture the saved-jobs flow. Specifically nav `/my-items/saved-jobs/` (and the `in-progress`, `applied`, `archived` tabs) under CDP Network capture, identify the queryId actually issued, and rewrite `listSavedJobs` against it. The new shape will almost certainly include `origin`, `count`, and `includeWebMetadata=true` as the captured 200 response demonstrates.

**Risk if shipped as-is:** HTTP 401 on every call. No data, but no session kill.

---

## 4a. Other stale `voyagerSearchDashClusters` hash sites (same fix family as §4)

The same outdated `voyagerSearchDashClusters.05111e1b90ee7fea15bebe9f9410ced9` hash appears in two more sites — both unverified against current frontend traffic and at the same kill-novelty risk class as the pre-rotation linkedin-jobs hash:

- `legacy/company/scripts/linkedin-company.mjs:420` — `fetchCompanyPeople`. Sends the same hash with an intent like `ORGANIZATIONS_PEOPLE`. The 2026-05-13 capture *does* contain a current `voyagerSearchDashClusters.843215f2…` call from a company-people page (phase `li-company-people`), so this site has a known-current replacement. Likely fixable with a one-line hash swap plus aligning variables to include `origin:FACETED_SEARCH`, `count`, and `queryParameters:List(...)` as in the capture.

- `legacy/search/scripts/linkedin-search.mjs:253` — `doSearch`. Sends the hash with `flagshipSearchIntent:SEARCH_SRP` (global header search). The current hash for that intent was not captured — global search wasn't exercised on 2026-05-13. Needs a targeted capture (type into the LinkedIn header search bar, scroll the SRP) before any swap.

**Risk if shipped as-is:** the same novelty-kill candidate the original `linkedin-jobs` listSavedJobs was. Neither site has had a controlled live test against today's session. Treat as do-not-call until verified.

---

## 4b. `WebTopCardCore-19` decoration is suspected dead — `resolveProfileUrn` sites

Two scripts resolve a `vanity → profile URN` via the REST endpoint `/voyager/api/voyagerIdentityDashProfiles?q=memberIdentity&memberIdentity={vanity}&decorationId=…WebTopCardCore-19`. This decoration is absent from the 2026-05-13 capture. The current frontend resolves the same `vanity → URN` mapping via the GraphQL queryId `voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a` (or one of the two URN-input variants — see §1).

Sites:

- `legacy/messaging/scripts/linkedin-msg.mjs:268` — `resolveProfileUrn`. Called by `send`, `messages`, and `search` subcommands. If this dies, the entire script's profile-resolve path is broken.
- `legacy/posts/scripts/linkedin-posts.mjs:222` — `resolveProfileUrn`. Same risk profile.

**Required rewrite:** match the rewrite proposed in §1 (vanity → URN via SDUI/page scrape, then URN → profile via a current queryId). Extract into a shared helper so both call sites benefit.

**Risk if shipped as-is:** high. The decoration is novel-to-current-traffic and may trigger an abuse-flag kill, not a clean 400.

---

## 4c. `linkedin-profile.mjs:392` — `fetchProfileCard` REST loop

**Current:** 12-call N+1 against `/voyager/api/voyagerIdentityDashProfileCards/{cardUrn}` for each card on a profile detail page.

**Why it's broken:** Frontend migrated to GraphQL `voyagerIdentityDashProfileCards.664e2b2a3534d6b6c474102628a62128` (captured 2026-05-13). The per-card REST path is no longer in frontend traffic. The earlier-attempted Restli batch shape `?ids=List(...)&decorationId=…` killed the session on 2026-04-10 (see `~/.claude/projects/-home-eyup-Projects-linkedin/memory/feedback_verify_before_bump.md`).

**Required rewrite:** Call the captured GraphQL queryId. Inspect a captured response body to identify which fields are needed. Likely also consolidates the 12-call loop into 1-2 GraphQL calls — both a correctness and a rate-limit win.

**Risk if shipped as-is:** unknown. The first invocation of `viewProfile` (which calls into this loop) might be either a slow 12-call-and-die or a single-call-and-die.

---

## 5. Not exercised in this capture — status unknown

These script URLs were absent from the 2026-05-13 capture, but only because the corresponding action wasn't triggered (mutation paths, deeply-nested clicks). They may be alive or stale — verify before next use:

| Script | Shape | What triggers it |
|---|---|---|
| `linkedin-profile.mjs` `viewProfile` cards loop | `/voyagerIdentityDashProfileCards/{urn}` REST | Profile page detail subpages |
| `linkedin-profile.mjs` `connect` | `…InvitationCreationResultWithInvitee-2` mutation | Clicking "Connect" |
| `linkedin-profile.mjs` `disconnect` | `…MemberRelationship-34` mutation | Clicking "Remove connection" |
| `linkedin-company.mjs` company posts | `voyagerFeedDashOrganizationalPageUpdates.827e11d1…` | Scrolling company posts |
| `linkedin-jobs.mjs` job detail | `voyagerJobsDashJobPostingDetailSections.772cd794…` | Clicking a specific job |
| `linkedin-jobs.mjs` easy-apply | `voyagerJobsDashOnsiteApplyApplication.a1ce7ed0…` | Easy Apply flow |
| `linkedin-posts.mjs:136` and `linkedin-msg.mjs:189` | `…WebTopCardCore-19` | URN/profile resolve in posts/msg |
| `linkedin-posts.mjs:198` main feed | `voyagerFeedDashMainFeed.923020905727…` | Feed scroll |
| `linkedin-posts.mjs` comments/reactions/reposts | various social GraphQL queryIds | Clicking like/comment/repost |

**Recommendation:** before re-enabling any of the above, do a targeted CDP capture that exercises the specific action button.

---

## Validation status of the three fixes in this branch

| Fix | Status | Notes |
|---|---|---|
| `salesnav-lead-search.mjs: LeadSearchResult-16 → -14` | ✅ verified live | End-to-end resolve succeeded in the investigation session. |
| `linkedin-msg.mjs: messengerConversations.0d5e6781…` | ✅ hash + simple shape verified live; richer shape untested | 2026-05-13: with fresh cookies extracted directly from Chrome, the *captured-byte-for-byte* shape `(mailboxUrn:URN)` returns HTTP 200 + 345 KB of real data, no kill markers. The script's actual variables shape `(query:(predicateUnions:…),count:N,mailboxUrn:URN)` was **not** retested with fresh auth and remains untested. Worth either testing carefully or refactoring `listConversations` to use the simple shape + client-side filtering — see §6. |
| `linkedin-jobs.mjs: voyagerSearchDashClusters.843215f2…` | ❌ broken; see §4 above | The new hash is for a different feature's persisted query. Returns HTTP 401, session alive. Needs targeted capture + rewrite, not a hash swap. |

Validation discipline for the remaining `linkedin-msg` test: run `listConversations` once with the smallest possible input (e.g., `node linkedin-msg.mjs list-conversations --count=5`), check the response for non-empty data and absence of `Set-Cookie: li_at=delete me`, wait ≥30 s, then verify session liveness with a single profile resolve. Stop on any anomaly. Do not bundle this validation with any other LinkedIn work in the same session.

Reference: `~/.claude/projects/-home-eyup-Projects-linkedin/memory/feedback_verify_before_bump.md`.

## 6. `legacy/messaging/scripts/linkedin-msg.mjs:365` — `listConversations` variables shape

**Status: hash rotation is verified, but the script's richer variables shape was not validated with fresh auth.** Investigate before next reliance.

**What the script sends (line 366):**
```
?queryId=messengerConversations.0d5e6781bbee71c3e51c8843c6519f48
&variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:N,mailboxUrn:urn%3Ali%3Afsd_profile%3A…)
```

**What LinkedIn's SPA bundle actually sends (captured 2026-05-12, status 200, replayed 2026-05-13 with fresh cookies, status 200):**
```
?queryId=messengerConversations.0d5e6781bbee71c3e51c8843c6519f48
&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3A…)
```

The script's richer shape — `query.predicateUnions`, `count` — was never seen in captured frontend traffic. Whether the persisted query accepts those extra fields is currently unknown. An earlier attempt to test it on 2026-05-13 ran into stale on-disk cookies (see `~/.claude/projects/-home-eyup-Projects-linkedin/memory/project_variables_shape_kill_2026_05_13.md`) and was not a valid test of the shape.

**Recommended path forward:**

1. **Easiest:** refactor `listConversations` to send only the captured-safe `(mailboxUrn:URN)` shape, then filter by `conversationCategoryPredicate` client-side. The 200 response already contains all inbox metadata; the predicate filter is a UI concern, not a server one. Drop `count` — pagination via subsequent calls with a cursor is the SPA's mechanism (look at `nextStartedAt` / sync tokens in the response).
2. **Harder:** capture deeper messaging traffic (inbox scroll, category switch, filter chip click) to discover whether the bundle ever sends extra variables to this queryId. Only adopt the richer shape if you see it in capture.
3. **Do not** test the richer shape live without a fresh CDP cookie extraction immediately beforehand (within seconds, not minutes), and without the cookie-diff sanity check baked into the call site.

---

## Pre-existing bug unrelated to these fixes

`legacy/messaging/scripts/linkedin-msg.mjs:198` calls `getLinkedInAuthCookies(target, list)` where `list` is undefined. This breaks the script's own `auth` subcommand. Workaround: copy a `session.json` from a sibling script's data directory.
