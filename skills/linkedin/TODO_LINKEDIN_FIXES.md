# LinkedIn skill — deferred fixes

Captured live frontend traffic 2026-05-13 and diffed against script URLs. Three one-line fixes were applied in this branch. The items below could not be reduced to a hash/decoration swap because the underlying call shape changed. They require rewrites and live validation.

Capture and diff artifacts: `/home/eyup/Projects/linkedin/captures/2026-05-13/AUDIT_REPORT.md`.

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
| `linkedin-msg.mjs: messengerConversations.0d5e6781…` | ⚠️ untested | Hash itself is captured (phase `li-messaging`, status 200). However, the captured frontend variables shape is `(mailboxUrn:URN)` only; the script sends a richer `(query:(predicateUnions:…),count:N,mailboxUrn:URN)`. Likely-but-not-guaranteed to work — the persisted query probably accepts the additional optional fields. Validate in a future session when the account is not warm. |
| `linkedin-jobs.mjs: voyagerSearchDashClusters.843215f2…` | ❌ broken; see §4 above | The new hash is for a different feature's persisted query. Returns HTTP 401, session alive. Needs targeted capture + rewrite, not a hash swap. |

Validation discipline for the remaining `linkedin-msg` test: run `listConversations` once with the smallest possible input (e.g., `node linkedin-msg.mjs list-conversations --count=5`), check the response for non-empty data and absence of `Set-Cookie: li_at=delete me`, wait ≥30 s, then verify session liveness with a single profile resolve. Stop on any anomaly. Do not bundle this validation with any other LinkedIn work in the same session.

Reference: `~/.claude/projects/-home-eyup-Projects-linkedin/memory/feedback_verify_before_bump.md`.

## Pre-existing bug unrelated to these fixes

`legacy/messaging/scripts/linkedin-msg.mjs:198` calls `getLinkedInAuthCookies(target, list)` where `list` is undefined. This breaks the script's own `auth` subcommand. Workaround: copy a `session.json` from a sibling script's data directory.
