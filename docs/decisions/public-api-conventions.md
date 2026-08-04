# ADR: The public `/api/v1` contract — versioning, auth, errors, pagination, rate limits, naming, stability

- **Status:** Accepted (2026-08-03) · **Amended 2026-08-03** (Subtask 11.2.1,
  MOTIR-2038) · **Amended 2026-08-04** (Subtask 11.3.1, MOTIR-2058). See
  [Amendments](#amendments). §5 and §9 must be read together with Amendments 1
  and 3; response shaping with Amendment 2.
- **Story / Subtask:** 11.1 (`/api/v1` foundation) · Subtask 11.1.1 (MOTIR-1857)
- **Gates:** MOTIR-1858 (the shared route wrapper), MOTIR-1859 (pagination),
  MOTIR-1860 (rate limiting), and every endpoint in 11.2 / 11.3. Later cards
  **cite this file** rather than re-deriving a convention.

## Context

Motir is about to grow a **public HTTP API** — a surface third parties integrate
against and then depend on. Two properties make the conventions worth deciding
once, before the first route exists:

1. **They are inherited, not chosen per endpoint.** Every endpoint in 11.2
   (work items) and 11.3 (projects / sprints / backlog / ready set) reuses the
   same envelope. Deciding pagination at the third list endpoint means the first
   two already shipped a different shape.
2. **They are promises.** An error `code`, a page shape, or a header name that a
   client has written code against cannot be changed without breaking that
   client, whatever the internal reason.

Motir already has an `app/api/**` tree — but that tree is the **web app's own**
cookie-authenticated backend, carrying no stability promise to anyone outside
the product. The public API is a different thing wearing similar clothes, and
this ADR is largely about keeping the two distinguishable.

Two credential facts constrain the auth decision, both verified in
`origin/main` rather than assumed:

- `lib/apiTokens/routeAuth.ts` already ships `authenticateApiToken(req, scope)` —
  a bearer-PAT gate on a plain REST route, returning
  `{ ok: true, userId, workspaceId }` or `{ ok: false, reason: 'unauthenticated' | 'forbidden' }`.
- `lib/mcp/scopes.ts` already ships a **typed-total** `TokenScope` set and the
  `TOOL_SCOPES` per-operation map.

So v1's auth and capability model are not green-field questions; they are
questions about whether to reuse what exists. This ADR says yes to both.

Evidence below is tagged **rung 1** (the mirror products' published API docs,
read during the 2026-07-29 planning pass and the 2026-07-29 follow-up on
versioning) and **rung 2** (shipped Motir code, cited by path).

---

## Decision

### 1. Versioning — path-versioned, every route under `/api/v1`

Every public endpoint lives under `/api/v1/…`. A **breaking** change mints
`/api/v2`; `/api/v1` keeps working and keeps its promise.

**Rung 1.** GitLab: _"the path must start with `/api/v4`"_. Plane:
`https://api.plane.so/api/v1/`. Both path-version.

**Rung 1, the counter-evidence — recorded because the alternative is real, not a
strawman.** Header versioning is legitimate and widely used. GitHub's REST API
takes `X-GitHub-Api-Version: <date>` (e.g. `2026-03-10`), is date-based rather
than sequential, and **defaults to `2022-11-28` when the header is omitted** —
the path carries no version at all. Stripe uses the same shape with per-account
pinned date versions. Roy Fielding's position is stronger still: versioning a
URI is a design mistake, because the same resource then has two names.

Path versioning is chosen anyway, for two Motir-specific reasons:

1. **It makes the promised/internal boundary STRUCTURAL** — the load-bearing
   reason. `app/api/**` already exists as the web app's cookie-authenticated
   tree with no stability promise. Unversioned, a public `/api/work-items`
   (additive-only forever) would sit beside an internal `/api/work-items/peek`
   (changeable at will) with **nothing in the path distinguishing them**, so the
   next person adding an internal route cannot tell they have landed inside a
   public contract. A `/api/v1` prefix makes that boundary impossible to cross by
   accident.
2. **Header versioning only pays for itself once several versions are
   concurrently maintained**, which requires per-version request/response
   transformation infrastructure Motir does not have and does not need. And for
   a **self-hostable** product — where client and server versions drift
   arbitrarily and nobody controls the pairing — a visible path version is
   materially more debuggable: a self-hoster reading access logs sees which
   contract was actually called.

> **`v1` never becoming `v2` is the SUCCESS case, not waste.** The additive-only
> promise in §8 means the segment is unused insurance. Do not read this section
> as planning an iteration to v2.

### 2. Auth — `Authorization: Bearer motir_pat_…`, and nothing else

One credential, one header, resolved by the **shipped**
`authenticateApiToken(req, requiredScope)`.

**Rung 2.** `lib/apiTokens/routeAuth.ts` already does exactly this on a REST
route (the acceptance-video publish endpoint), and `/api/mcp` authenticates the
same header. `lib/apiTokens/token.ts` owns the `motir_pat_` prefix and the
sha-256-at-rest hashing; `apiTokensService.verify` resolves a token to
`{ user, workspaceId, scopes }`.

**Rung 1.** Plane accepts `Authorization: Bearer` for OAuth tokens; GitHub uses
bearer PATs.

**No second mechanism.** No `X-API-Key`, no `?token=` query parameter, no
session-cookie fallback (§9 records why each is rejected).

**A token is bound to ONE workspace.** `apiTokensService.verify` returns the
`workspaceId` the token was minted for, and **every RESOURCE endpoint stays
inside it**. This is what makes cross-tenant isolation (§4) a property of the
credential rather than a check each endpoint must remember.

**The one carve-out — account-level DISCOVERY reads.** `GET /api/v1/me` and
`GET /api/v1/workspaces` answer at the level of the token OWNER rather than the
bound workspace, because a client holding a fresh token otherwise has no way to
learn which workspace ids exist for it, and would have to discover them by
guessing. The disclosure is bounded and deliberate: exactly what the owner
already sees in their own workspace switcher — their own memberships, nothing
about another user's, and **no resource inside any workspace**, bound or not.
This carve-out is closed: a new v1 endpoint is bound-workspace-scoped unless it
is added here, which is an ADR amendment, not a route-level choice. (The
precedent is the shipped `GET /api/me/api-tokens`, which lists a user's tokens
account-level for the same reason.)

### 3. Scopes — reuse `TokenScope` verbatim, mapped PER OPERATION

v1 introduces **no new scope**. It uses the shipped set from `lib/mcp/scopes.ts`
(**rung 2**, typed total by construction) and maps each operation to exactly one
scope — the same per-operation shape `TOOL_SCOPES` already uses for MCP tools,
not a per-resource grouping.

The map a route author implements from, without re-deciding:

| v1 operation                                                                      | Required scope                    |
| --------------------------------------------------------------------------------- | --------------------------------- |
| Any `GET` — read, list, search, identity                                          | `read`                            |
| Create / update / transition a work item; add a comment; link or unlink           | `work_items:write`                |
| Archive / unarchive a work item                                                   | `work_items:archive`              |
| Create / update / start / complete a sprint; move an item into or out of a sprint | `sprints:write`                   |
| Mark-integrated / complete-session (external-agent writes)                        | `integration`                     |
| Irreversible subtree delete                                                       | **not exposed in v1's first cut** |

Two rules that follow from the map and are not negotiable per endpoint:

- **A route DECLARES its required scope; it does not infer one.** The wrapper
  takes the scope as an argument, so "which scope gates this?" is answered at
  the route's definition, and MOTIR-1861's guard fails the build for a route
  that declares none.
- **Scopes NARROW, never widen.** A token's scope composes with its owner's
  existing workspace/project role: an operation is allowed only if the role
  permits it **and** the token carries the scope. A `work_items:write` token held
  by a read-only member still cannot write.

**`work_items:delete` stays unexposed in v1's first cut.** It is the only
irreversible, subtree-cascading operation (`lib/mcp/tools/deleteWorkItem.ts`),
and it is already off by default in `DEFAULT_TOKEN_SCOPES`. Exposing it is
additive under §8 and can happen later; un-exposing it could not.

If a v1 operation genuinely needs a capability the shipped set lacks, that is a
**separate card against `lib/mcp/scopes.ts`** — flagged, not invented at the
route.

### 4. Errors — `{ code, error }` plus the HTTP status

Every failure returns the same body shape:

```json
{ "code": "WORK_ITEM_NOT_FOUND", "error": "Work item not found." }
```

- **`code` is a stable machine identifier.** SCREAMING_SNAKE_CASE, never
  localized, never reworded, never re-purposed. Clients branch on it. Changing a
  `code` is a breaking change under §8.
- **`error` is a human sentence** for a developer reading a terminal. It may be
  reworded freely; nothing may parse it.

**Rung 2.** This is the established convention, not a new one:
`app/api/work-items/[id]/route.ts` already returns
`{ code: err.code, error: err.message }`. v1 keeps it rather than introducing a
second error shape into the same codebase.

The status table — each row is the condition that produces it:

| Status  | Condition                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **401** | No token, malformed header, unknown token, revoked token, expired token — **all five undifferentiated**                                                                                                                |
| **403** | A valid token whose granted scopes do not include the required one                                                                                                                                                     |
| **404** | The resource does not exist **or** is outside the token's workspace — deliberately the same answer                                                                                                                     |
| **409** | A conflict with existing STATE, not a malformed request — e.g. creating a link that already exists (added 2026-08-03 by Subtask 11.2.9; likewise a new condition, permitted by §8)                                     |
| **412** | An `If-Match` precondition failed — the resource moved since the validator was issued (added 2026-08-03 by Subtask 11.2.6; a NEW condition getting a status, which §8 permits, not an existing condition changing one) |
| **422** | A malformed request: an invalid cursor, an out-of-range or non-numeric `limit`, a failed body validation                                                                                                               |
| **429** | The token's rate-limit budget is exhausted (§6)                                                                                                                                                                        |
| **500** | An unexpected server fault — body carries no `code`, no stack, no driver text                                                                                                                                          |

Three of those rows are decisions, not defaults:

- **401 is undifferentiated on purpose.** Telling a caller _which_ of
  missing/malformed/unknown/revoked/expired applies turns the endpoint into a
  token oracle. The shipped MCP gate already refuses to distinguish them
  (`lib/apiTokens/routeAuth.ts` maps all three token errors to the single
  `unauthenticated` reason); v1 matches it. A future "helpful" error message here
  is a security regression, which is why MOTIR-1858 asserts the five cases
  against one shared expectation.
- **404-not-403 for cross-tenant.** A 403 on a resource in another workspace
  confirms that the resource EXISTS — an existence oracle over other tenants'
  data. **Rung 2:** this is already the product's behaviour, and the public API
  must not weaken it. The rule: 403 answers "your token may not do this KIND of
  thing"; 404 answers "there is no such resource _for you_".
- **A 500 leaks nothing.** No `code` (there is no stable contract for an
  unexpected fault), no stack, no Prisma or driver message. An unrecognised error
  reaching the wrapper becomes a bare 500 — asserted by throwing a raw error
  through it.

**Every response carries a request id header**, success and failure alike, so a
developer can quote one identifier in a support conversation.

### 5. Pagination — opaque cursor, `?cursor=&limit=`, never offset

> **⚠️ Amended 2026-08-03 — see [Amendment 1](#amendment-1-2026-08-03--a-bounded-read-addressing-carve-out-to-9).**
> This clause stands unchanged, but satisfying it for a work-item collection
> requires a **keyset read that does not exist** in the services §9 says v1 may
> only re-present. The amendment records the bounded carve-out that resolves the
> conflict. Do not act on §5 or §9 alone.
>
> **⚠️ Amended 2026-08-04 — see [Amendment 3](#amendment-3-2026-08-04--the-cursor-is-collection-scoped-over-a-service-owned-position-the-ranked-list-envelope-and-the-bounded-call-rule).**
> The three properties below are unchanged and remain the point of the decision.
> What Amendment 3 settles is what the cursor encodes a position **in**: the
> shipped codec hardwired `(createdAt, id)`, which is not the order any of Story
> 11.3's collections is sorted by. It also adds the **ranked list envelope** —
> the one documented variant that carries `totalCount`.

Every collection returns the **same envelope**: the page's `items` plus the
cursor for the next page (absent on the last page). `limit` **defaults to 50**
and is **hard-capped at 100**.

**Rung 1.** Plane is cursor-based with a 100 max; GitLab's keyset mode returns
`X-NEXT-CURSOR`. **Rung 2.** `lib/mcp/searchCursor.ts` already encodes opaque
cursors as `base64url(JSON)` and throws on a malformed token rather than
silently restarting at page one — v1 adopts that **idiom**.

Three properties that are the point of the decision:

- **Keyset, not offset.** Motir's collections mutate while a client pages them —
  an agent loop writes while another reads. Offset pagination silently **skips**
  a row when one is inserted before the cursor and **duplicates** one when a row
  is removed. So v1's cursor encodes a **position in the sort order**, not a page
  number, and MOTIR-1859 asserts the property directly with a concurrent insert.
  A pagination test that only walks a static fixture has not tested pagination.
  (Note the deliberate divergence from `searchCursor.ts`'s _semantics_: that
  cursor wraps a page NUMBER because it must page identically to the offset-paged
  List view it claims parity with. v1 has no such constraint and takes the
  stronger guarantee.)
- **The cursor is OPAQUE.** A client must not be able to construct one from row
  data. Making the keyset public would freeze the underlying sort/index as API,
  turning a future index change into a breaking change.
- **A bad cursor is a 422, never a silent reset.** A malformed, truncated or
  foreign cursor returns 422 with a `code`. Resetting silently to page one is the
  failure mode that makes a client loop forever.

Empty and terminal cases are specified so they are not re-decided: an empty
collection is **200** with empty `items` and no next cursor (never a 404); the
last page reports no next cursor rather than requiring an extra empty round trip.

### 6. Rate limits — per TOKEN, fixed window, `X-RateLimit-*` on every response

**Budget: 60 requests per token per 60-second fixed window.**

**Rung 1.** Plane enforces exactly 60 req/min per key with the
`X-RateLimit-Limit` / `-Remaining` / `-Reset` headers. Motir adopts the mirror's
number rather than inventing one: it is enough for interactive scripting and
ordinary integrations, and low enough to bound a runaway loop. It is
**configurable per environment** via `MOTIR_API_V1_RATE_LIMIT` and
`MOTIR_API_V1_RATE_LIMIT_WINDOW_MS` (documented in `.env.example`) — a
self-hoster's ceiling is not Motir Cloud's — and raising it later is additive
under §8. An unset, non-numeric or non-positive value falls back to the default
rather than disabling the limiter, so a typo in a deploy config cannot silently
remove the ceiling.

**Rung 2.** `grep` over `lib/` and `app/` confirms **no rate-limit helper exists
anywhere** — the `rateLimit` hits are Better-Auth's own config plus
account-settings copy. This is the one genuinely new primitive in Story 11.1, and
it is foundation rather than hardening: an unlimited public API over a shared
Postgres is a denial-of-service surface.

- **Keyed on the TOKEN**, not the IP (shared NATs and CI runners collide) and not
  the user (one runaway script would starve that user's other integrations). Per
  token means one integration cannot exhaust another's budget, and revoking a
  compromised token stops its traffic.
- **Headers on EVERY response, not only on refusals.** A client can only back off
  politely if it can see its budget while succeeding. `X-RateLimit-Reset` is a
  time a client can actually wait for.
- **429 carries the headers AND the `{ code, error }` envelope** — a client
  learns _when_ to retry, not merely that it failed.
- **The counter is incremented ATOMICALLY.** Increment-then-compare is the
  textbook check-then-write race: two concurrent requests both read the stale
  count and both pass, so the limit leaks under exactly the concurrent load it
  exists to control. A single increment-and-return, never read → compare → write.
- **A limiter-store failure MUST NOT fail the request.** Degrade to allowing the
  call and log it. An outage in the limiter must not take the API down.

**Recorded limitation — the first cut's store is per-process.** The counter lives
behind a small store interface with an **in-process** default, because Story 11.1
deliberately ships no migration and no new repository. On a multi-instance
deployment each instance therefore enforces its own window, so the effective
ceiling is `60 × instances` rather than 60. This is a real weakening and is
recorded rather than glossed: the enforcement seam, the headers, the 429 and the
atomicity are all correct and permanent; only the store is provisional. Swapping
in a shared store (Postgres or Redis) is an implementation of the same interface
and changes no route, no header and no status — tracked as its own card, not
deferred silently.

### 7. Resource naming

- **Plural, hyphenated nouns**, scoped by their parent:
  `/api/v1/projects/{projectKey}/work-items`,
  `/api/v1/sprints/{sprintId}/work-items`. **Rung 1:** Plane scopes by
  `/workspaces/{slug}/projects/…`.
- **`work-items`, never `issues`.** The product noun is _work item_, and the
  terminology rename already shipped product-wide (**rung 2**). A public path is
  the most expensive place to carry a stale noun.
- **Identifiers in paths are the `MOTIR-<n>` key, not the internal cuid.** The key
  is what a user sees, what a branch name carries and what a PR title references;
  the cuid is an implementation detail that must not become API.
- Query parameters are `lowerCamelCase`, matching the JSON bodies.

### 8. Stability — additive-only within `v1`

Within `v1`:

- **Allowed (additive):** a new endpoint; a new optional query parameter; a new
  field on a response object; a new enum value on a field documented as
  open-ended; a raised rate-limit budget.
- **Forbidden without a new major:** removing a field; renaming a field;
  changing a field's type or nullability; removing or re-purposing an error
  `code`; changing an existing status for an existing condition; tightening a
  limit; making an optional parameter required.

**Therefore a client MUST tolerate unknown fields.** That obligation is the other
half of the promise and is stated in the reference docs (11.4).

Deprecation, when it eventually happens: document it, announce it, and keep the
old behaviour working for the announced window. A field is never removed as a
surprise.

**Rung 1.** GitLab's v4 has held for years on exactly this promise — it is the
property that makes an API integrable rather than merely callable.

### 9. Architecture — a v1 route is a thin adapter

> **⚠️ Amended 2026-08-03 — see [Amendment 1](#amendment-1-2026-08-03--a-bounded-read-addressing-carve-out-to-9)
> and [Amendment 2](#amendment-2-2026-08-03--a-v1-response-is-a-schema-output-and-each-resource-story-owns-its-schemas);
> amended 2026-08-04 — see [Amendment 3](#amendment-3-2026-08-04--the-cursor-is-collection-scoped-over-a-service-owned-position-the-ranked-list-envelope-and-the-bounded-call-rule).**
> Amendment 1 carves out a **bounded** exception to the corollary below (a new
> page ADDRESSING over an unchanged predicate is not new behaviour) and
> Amendment 3 extends its table with by-id re-presentation. Amendment 2 settles
> where the response shapes live. Amendment 3 also replaces the literal **ONE**
> below with the **bounded-call rule**: a constant number of RESOLVE / PROJECT
> calls, never one whose result the route branches on. The thin-adapter rule
> itself, and the no-`db.*` / no-`$transaction` rule, are unchanged.

A `/api/v1` route parses the request, calls the shared wrapper, calls **ONE**
service method, and returns. **No `db.*`, no `$transaction`, no business logic in
a route** — the 4-layer contract from `CLAUDE.md`, and MOTIR-1861 asserts it
mechanically over the whole route tree so it keeps holding as 11.2 and 11.3 add
endpoints.

The corollary matters as much: **v1 is a new PRESENTATION of existing
capability**, not a place to grow new behaviour. If an endpoint appears to need a
new service, repository or migration, that is a card in the owning feature's
epic — not something v1 invents at the edge.

---

## Rejected alternatives

| Rejected                                                           | Why                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Offset pagination** (`?page=` / `?offset=`)                      | Silently skips and duplicates rows when the collection mutates mid-scan — which for Motir is the normal case, not an edge case, since agent loops write while clients read. Simpler to implement and impossible to make correct.                                                                                                                                                 |
| **Header versioning** (`X-Motir-Api-Version`)                      | Legitimate and used by GitHub and Stripe (§1 records the real evidence). Rejected because it leaves the public/internal boundary invisible inside one `app/api/**` tree, and because it only pays for itself with per-version transformation infrastructure that a self-hostable product with drifting client/server pairs would still find less debuggable than a visible path. |
| **Query-parameter versioning** (`?v=1`)                            | Same "same resource, two names" objection as path versioning but without its one benefit — the boundary is not visible in the route tree — and trivially lost when a client drops the parameter.                                                                                                                                                                                 |
| **`X-API-Key` as an alternative header**                           | A second auth path doubles the surface that must stay correct, and every gate would have to accept both forever. `Authorization: Bearer` is already shipped, already parsed, and already what both mirrors use. One auth path.                                                                                                                                                   |
| **A session-cookie fallback**                                      | Would make CSRF a concern on a surface that currently has none: a bearer-only endpoint cannot be driven by a browser carrying a victim's cookie. The web app has its own cookie-authenticated tree; the public API stays credential-disjoint from it.                                                                                                                            |
| **Exposing `work_items:delete` in the first cut**                  | The only irreversible, subtree-cascading operation, already off by default in `DEFAULT_TOKEN_SCOPES`. Exposing it later is additive under §8; withdrawing it later would be breaking.                                                                                                                                                                                            |
| **A distinct error shape for validation errors**                   | Two error shapes means every client writes two parsers. 422 carries the same `{ code, error }`; per-field detail, if ever needed, is an additive field under §8.                                                                                                                                                                                                                 |
| **Distinguishing 401 causes** (`TOKEN_EXPIRED` vs `TOKEN_REVOKED`) | Friendlier, and a token oracle. The shipped MCP gate already refuses to distinguish them; the public surface is exactly where that refusal matters most.                                                                                                                                                                                                                         |
| **Per-endpoint or per-scope rate budgets**                         | One budget for v1's first cut. Differentiated budgets are additive later and pre-building them means guessing at traffic shapes that do not exist yet.                                                                                                                                                                                                                           |
| **Rate-limiting by IP**                                            | Shared NATs, CI runners and corporate proxies collide, so one tenant's traffic would refuse another's. Per token is both fairer and revocable.                                                                                                                                                                                                                                   |

## Consequences

- **Every later v1 card cites this file** instead of re-deciding. A card that
  says "per the public-API conventions" resolves to
  `docs/decisions/public-api-conventions.md`.
- **A convention found wrong later is an ADR AMENDMENT card**, never a
  per-endpoint deviation. One endpoint quietly paginating differently is exactly
  the failure this ADR exists to prevent.
- **The wrapper is the enforcement point.** Because auth, scope, error mapping,
  pagination and rate limiting all live in one composed helper, "did this route
  follow the conventions?" is answered by "did it use the wrapper?" — which
  MOTIR-1861 checks mechanically rather than by review.
- **The rate limiter's per-process store is a known, recorded gap** (§6), not an
  omission: correct in a single-instance deployment, weakened proportionally to
  instance count, and swappable without touching a route.

---

## Amendments

Amendments live here rather than rewriting the clauses above, so a reader can
still see what was originally decided and why it changed. Each is dated, carries
its own evidence, and records what it rejected — the shape the original uses.
Per the Consequences above, **a convention found wrong is an amendment card, never
a per-endpoint deviation**; these are that card (Subtask 11.2.1 — MOTIR-2038).

### Amendment 1 (2026-08-03) — a bounded read-addressing carve-out to §9

**Amends:** §9's corollary ("v1 is a new PRESENTATION of existing capability").
**Leaves unchanged:** §5 in full, and §9's thin-adapter and no-`db.*` rules.

#### The conflict

§5 mandates keyset cursors and explicitly rejects offset pagination ("simpler to
implement and impossible to make correct"). §9's corollary says a v1 endpoint
that appears to need a new service or repository is a card in the owning feature's
epic. For `GET /api/v1/projects/{projectKey}/work-items` — the flagship read of
Story 11.2 — **both cannot hold**. Verified on `origin/main` @ `c4ec51b1`, each
claim cited to the file it was read in:

- **The shipped project read is offset-paged.** `workItemsService.getProjectIssuesList`
  (`lib/services/workItemsService.ts:2603`) takes `{ sort, filter, page, pageSize }`
  and passes `{ limit, offset }` into `workItemRepository.findProjectIssuesFlat`
  (`lib/repositories/workItemRepository.ts:2141`), whose window is a literal
  `LIMIT … OFFSET …`. Its own comment calls the List "LIMIT/OFFSET-paged".
- **It clamps below v1's documented ceiling.** `clampIssuePageSize`
  (`lib/services/workItemsService.ts:476-486`) clamps to
  `ISSUE_LIST_PAGE_SIZE = 50` (`lib/issues/issueListView.ts:103`), while §5 pins a
  100 ceiling and `parsePageRequest` (`lib/api/v1/pagination.ts`) tells a caller
  its `limit` is honoured up to 100. A v1 client asking for 100 would silently
  receive 50 — the API breaking its own documented promise.
- **The shipped v1 pager cannot stand in.** `paginateKeyset`
  (`lib/api/v1/pagination.ts:170`) slices a **fully-read** array. That is correct
  for `GET /api/v1/workspaces` (a user's own memberships, bounded by how many
  workspaces a person joins); over a project's work items it is an unbounded read.
  The Motir project alone holds 1800+ items.
- **No keyset read serves this collection.** `lib/repositories/workItemRepository.ts`
  does contain seek-after cursor reads over `work_item` — `findReadyCandidates`
  (`:809`, a `(priority, kind, key)` cursor) and `findTriageQueue` (`:1038`, a
  `(voteCount, triagedAt, id)` cursor) — so the claim is **not** that the
  repository has never seen a cursor. It is narrower and it is what matters: each
  pages a _different collection_ under a _different order_, and **none pages the
  project List predicate**, which has only the offset read above.

#### The decision

**§9's bar on a new service or repository is a bar on new BEHAVIOUR.** New
behaviour is a new filter axis, a new access gate, a new response field, a new
write. A **page ADDRESSING** over an unchanged predicate is none of those: the
result SET is byte-for-byte the set the `/items` view already returns for the same
filter, and only the way a position _within_ that set is named changes.

So a v1-added read **may** reuse an existing predicate with a different page
addressing — including an optional page-SIZE parameter where the shipped read has
a fixed one — **and may do nothing else.** The bounds, stated so this cannot be
read as licence for v1 to grow behaviour at the edge:

> **⚠️ Extended 2026-08-04 — the table below gains a permitted row (by-id
> re-presentation); see [Amendment 3](#amendment-3-2026-08-04--the-cursor-is-collection-scoped-over-a-service-owned-position-the-ranked-list-envelope-and-the-bounded-call-rule).**

| Permitted under the carve-out                                                                                             | NOT permitted — still a card in the owning epic |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| A keyset window over the **same compiled predicate**                                                                      | A new filter axis or facet                      |
| A different ORDER BY, where the ordering is the page addressing                                                           | A new or relaxed access gate                    |
| An optional `limit` where the shipped read has a fixed page size                                                          | A new field on the returned row                 |
| Fetching `limit + 1` instead of a `COUNT` denominator                                                                     | Any migration                                   |
| **A by-id read that re-presents an already-shipped repository read through the already-shipped mapper** (Amendment 3, Q3) | Any write path                                  |
|                                                                                                                           | Raising an EXISTING cap on an existing method   |
|                                                                                                                           | Anything that changes what the row CONTAINS     |

Two consequences that are part of the decision, not commentary:

- **The predicate must be SHARED at the source level**, not re-expressed. Two
  predicates for one filter is how the API and the web app begin disagreeing about
  what a filter means — which is the failure §5's parity criterion exists to catch.
- **No existing cap moves.** `ISSUE_LIST_PAGE_SIZE = 50` is a Cloud performance
  bound on the offset pager and stays exactly where it is; the new read clamps to
  `MAX_PAGE_LIMIT = 100` independently.

The carve-out is used twice in Story 11.2 and both uses are enumerated here, so a
third is a visible extension rather than a precedent quietly accreting: the keyset
project work-item read (11.2.3 — MOTIR-2041) and an optional `limit` on
`commentsService.listComments`, whose page size is today the fixed
`COMMENT_PAGE_SIZE = 20` (11.2.8 — MOTIR-2049).

#### Rejected alternatives

| Rejected                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wrap the offset page in an opaque cursor** (as `lib/mcp/searchCursor.ts` does) | That cursor wraps a page NUMBER — legitimate there, because `search_work_items` must page IDENTICALLY to the offset-paged `/items` view it claims parity with. v1 has no such constraint, and adopting it would reintroduce exactly the skip/duplicate defect §5 rejects, on the busiest, most-written collection in the product, while making "cursor" mean two different things inside one API. |
| **Read every row, then `paginateKeyset` in memory**                              | The unbounded read Story 11.2's own completeness criterion forbids, over a collection already past 1800 rows in Motir's own tenant. It would page _correctly_ and fall over under exactly the scale the API exists to serve.                                                                                                                                                                      |
| **Raise `ISSUE_LIST_PAGE_SIZE` to 100 and reuse the offset read**                | Changes the web app's shipped performance envelope to suit the API — a v1 concern reaching into a product surface — and still leaves the offset skip/duplicate defect §5 rejects.                                                                                                                                                                                                                 |
| **Let v1 lower its ceiling to 50 for this endpoint**                             | §5's 100 is documented and already enforced by `parsePageRequest`. A single endpoint silently capping lower is the per-endpoint deviation the Consequences section forbids, and it is invisible to the client.                                                                                                                                                                                    |

### Amendment 2 (2026-08-03) — a v1 response is a schema output, and each resource story owns its schemas

**Amends:** the schema-ownership split between Story 11.2 / 11.3 and Story 11.4.
**Leaves unchanged:** §7 (identifiers on the wire) and §8 (additive-only stability).

#### The problem

The two shipped routes shape their rows **inline**, and for the right reason:
`app/api/v1/me/route.ts` records that "the response is shaped explicitly rather
than spread, because `verify` returns the raw Prisma `User` row and a public API
must never leak one". `app/api/v1/workspaces/route.ts` does the same for its rows.
That instinct is correct and must survive.

The inline FORM does not. Story 11.2 has ten endpoints returning one work-item
shape — list, detail, create, update, transition, archive — and ten inline
literals for one resource is ten places for the contract to drift.

Story 11.4 had claimed "one schema module per resource" as its own deliverable.
**That direction is backwards and is corrected here:** it would have 11.2 and 11.3
ship routes with ad-hoc inline shapes and then retrofit every one of them —
precisely the drift 11.4 exists to prevent, performed deliberately.

#### The decision

**Each resource story ships the `zod` RESPONSE schemas next to its own routes;
Story 11.4 ASSEMBLES.** One sentence each:

- **11.2** owns the work-item resource schemas — the summary row, the detail
  aggregate, the link groups, the comment shape — in `lib/api/v1/workItems/`.
- **11.3** owns the project, sprint, backlog and ready-set schemas, in its own
  per-resource modules, on the same pattern.
- **11.4** owns the SHARED envelope, error and pagination schemas, the OpenAPI 3.1
  emission, the route↔spec CI guard, the published reference and the stability
  policy — and authors **no** per-resource shape.

**Rung 1:** this is how every schema-first HTTP stack works — `zod-to-openapi`,
FastAPI, NestJS. The schema is declared _with_ the operation; the document is
_assembled from_ the operations. Nothing else keeps a spec honest, because a spec
authored apart from its routes is a second artifact that can be wrong.

**The corollary is the load-bearing half: a v1 response is a v1 schema's output,
never a service DTO passed through.** A service DTO (`IssueDetailDto`,
`WorkItemListItemDto`) is internal and changes freely whenever a page needs it to.
§8's additive-only promise cannot ride something nobody promised to keep still: a
column added by a later migration would become public API the moment it reached a
DTO, and a DTO field renamed for the web app's convenience would be a silent
breaking change. The mapper is the seam where that stops, which is why it shapes
**field by field and never spreads** — the generalisation of what
`app/api/v1/me/route.ts` already does one layer down.

#### Rejected alternatives

| Rejected                                                      | Why                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **11.4 authors every per-resource schema** (as first planned) | Means 11.2 and 11.3 ship inline shapes first and retrofit later — shipping the exact drift 11.4 exists to prevent, on purpose, and paying for it twice.                                                                      |
| **Return the service DTO directly**                           | Makes an internal shape a public promise. A later migration's column becomes contract by accident; a DTO rename becomes a silent breaking change. §8 cannot be honoured on a shape nobody owns.                              |
| **Keep shaping inline, per route**                            | Ten literals for one resource. The list row and the detail row would drift apart with nothing failing, and there is nothing for 11.4 to emit a spec from.                                                                    |
| **Hand-write the OpenAPI document alongside the routes**      | A second artifact that can silently disagree with the code. Deriving the document from the schemas the routes actually use is the only form where "the spec is wrong" is a test failure rather than a discovery by a client. |

### Amendment 3 (2026-08-04) — the cursor is collection-scoped over a SERVICE-OWNED position, the ranked list envelope, and the bounded-call rule

**Amends:** §5 (what the cursor encodes a position _in_, and the list envelope),
§9 (the literal "**ONE** service method"), and Amendment 1's permitted/forbidden
table.
**Leaves unchanged:** §5's three properties (keyset, opaque, 422-never-reset) and
its 100 ceiling; §9's thin-adapter and no-`db.*` / no-`$transaction` rules; §7
and §8 in full.

Four questions Story 11.3's resources force, settled here rather than eight
times at eight endpoints. All rung-2 evidence was read on `origin/main` @
`94a65035` and is cited by path.

#### Q1 — a cursor over a sort order v1 does not own

##### The conflict

§5 pins that the cursor encodes "a **position in the sort order**, not a page
number" and never says WHICH order. `lib/api/v1/pagination.ts` then hardwired
one: `PageCursor` is `{ createdAt, id }`, `paginateKeyset` requires
`Keyed { id: string; createdAt: Date }`, and `compareKeys` sorts `(createdAt,
id)` ascending. That was right for 11.1's and 11.2's collections. It is wrong
for all four of Story 11.3's, none of which is sorted that way:

| collection                                   | shipped sort order                                       | shipped cursor                     |
| -------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| backlog (`backlogService.getBacklog`)        | `backlogRank`                                            | the last row's `id`                |
| sprint members (`getSprintIssues`)           | `backlogRank`                                            | the last row's `id`                |
| the ready set (`workItemsService.listReady`) | `(type asc, priority desc, key asc)` — the DISPATCH rank | `base64url([kind, priority, key])` |
| a project's sprints (`listByProject`)        | `sequence`                                               | none — unpaginated                 |

Two of the DTOs cannot satisfy `Keyed` at all: `SprintDto` (`lib/dto/sprints.ts`)
has **no `createdAt` field**, and `ProjectDTO.createdAt` (`lib/dto/projects.ts`)
is **optional and deliberately not loaded** on the list path — its own doc
comment records that omission as the "the DTO is not a raw Prisma row" decision a
shape test enforces. And re-sorting the ready set by `createdAt` would discard
the dispatch rank, which is the entire product value of that endpoint.

##### The decision

**Generalize the codec; do not widen the DTOs.** The v1 cursor becomes a signed,
opaque envelope around a **service-owned position** — the token the underlying
read already speaks — rather than a `(createdAt, id)` tuple v1 invented.

§5's three properties are unchanged and remain the reason the cursor exists:

- **Keyset, not offset.** The envelope wraps a seek-after POSITION in the
  collection's own order; it never becomes a page number or a row offset. The
  skip/duplicate defect §5 rejects stays rejected, because the underlying reads
  are themselves seek-after (`findBacklogPage` / `findSprintIssues` take a
  cursor id; `listReady` seeks after a `(kind, priority, key)` tuple).
- **Opaque.** Still HMAC-signed with the same derived key, so a client cannot
  construct one and `backlogRank` / the dispatch tuple never become public API.
  This is what makes generalizing the payload safe: the wrapped position may be
  any service token precisely because nobody outside the server can read it.
- **A bad cursor is a 422, never a silent reset.** Unchanged, and now covering
  one more case — see the collection scope below.

Two consequences are part of the decision, not commentary, so the endpoint cards
inherit them rather than re-deciding:

- **The cursor is COLLECTION-SCOPED.** The signed payload names the collection
  that issued it, and a cursor presented to a different collection is the same
  422 as a tampered one. Without this the generalization would be a new defect:
  a backlog cursor (a row id) and a sprint-member cursor (also a row id) are
  structurally identical, so one would decode cleanly into the other and silently
  return a page positioned by a row that is not in that collection at all. The
  narrower `(createdAt, id)` shape hid this because every collection shared one
  order; a service-owned position must carry its own provenance.
- **v1's 100 ceiling holds, and is never RAISED by an underlying read.** `MAX_PAGE_LIMIT
= 100` (§5) is the documented promise. `clampReadyLimit` allows 200
  (`READY_MAX_LIMIT`, `lib/workItems/readyFilter.ts`) and the ranked reads allow
  `MAX_BACKLOG_PAGE_SIZE`; v1 clamps DOWN to its own ceiling before the service
  ever sees the number. Amendment 1 already forbids raising an existing cap on an
  existing method; this is the mirror obligation — v1 does not inherit a larger
  one either. (Clamping down is not the "silently capping lower" that amendment's
  rejected-alternatives table forbids: 100 is the documented value a client is
  told it gets, and it gets it.)

**Rung 1.** Plane and GitLab both expose keyset cursors as opaque tokens whose
payload the client is never told — GitLab's `X-NEXT-CURSOR` is explicitly
documented as opaque, which is exactly what licenses the server to change what it
wraps. The property a client depends on is "pass it back", not "what is in it".

##### Rejected alternatives

| Rejected                                                      | Why                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add `createdAt` to `SprintDto` / `ProjectDTO`**             | A v1 concern reaching into product DTOs to make an unrelated sort work — the exact direction §9's corollary forbids. `ProjectDTO`'s omission is a recorded decision with a shape test behind it, not an oversight. And for the ready set it would still be the WRONG order.  |
| **Re-sort each collection by `(createdAt, id)` at the route** | Correct paging over an answer nobody asked for. The backlog would come back in creation order rather than rank order, and the ready set would stop being ranked — the endpoint's whole value. Paging a collection correctly is worthless if the collection is the wrong one. |
| **Carry the service's raw cursor through unsigned**           | Drops the opacity property §5 gives its own paragraph, and makes `backlogRank` and the dispatch tuple public API — freezing an internal ordering as contract, which is the specific harm §5 cites.                                                                           |
| **One cursor namespace, no collection scope**                 | Two collections whose positions are both bare row ids would accept each other's cursors and answer 200 with a wrong page. A silently wrong page is worse than the 422 §5 already prescribes for a foreign cursor.                                                            |

#### Q2 — `totalCount`, which the shipped ranked reads already return

##### The conflict

`RankedIssuePageDto` (`lib/dto/backlog.ts`) is `{ items, nextCursor, totalCount }`
— the count is a bounded `COUNT` the read has already paid for
(`countBacklog` / `countSprintIssues`). The v1 list envelope
(`ListEnvelope<T>` in `lib/api/v1/pagination.ts`) is `{ items, nextCursor }`. So
the backlog and sprint-member endpoints either drop a number that is already in
hand, or the shared envelope grows a field two endpoints out of six can fill.

The asymmetry is real and is why this is not simply "add the field": the ready
set and the project list have no equivalent cheap count. Counting the ready set
means running the readiness predicate over every candidate — `READY_COUNT_CAP` /
`READY_COUNT_MAX_PAGES` (`lib/workItems/readyFilter.ts`) exist precisely because
an exact ready count is expensive enough to need two bounds and a visible `99+`.
§5's promise of a cheap page is what would pay for it, and it cannot.

##### The decision

**Ship it, as ONE documented variant: the RANKED list envelope.**

```
ListEnvelope<T>        = { items: T[], nextCursor: string | null }
RankedListEnvelope<T>  = { items: T[], nextCursor: string | null, totalCount: number }
```

`RankedListEnvelope` is declared once, beside `ListEnvelope`, and is returned by
exactly those collections whose shipped read already computes the count as a
bounded aggregate. In v1's first cut that is the backlog and a sprint's members.
Every other collection returns `ListEnvelope`, and `totalCount` is **absent**
from its body — not `null`, not `0`.

Three reasons, in the order they decided it:

- **An absent field is honest; a null one is not.** A `totalCount: number | null`
  on the shared envelope would make `null` mean "we did not count", which a
  client cannot distinguish from a real answer without knowing which endpoint it
  called — so it would have to hard-code that knowledge anyway. Two named
  schemas put the same knowledge in the contract, where 11.4 can emit it.
- **It does not make the cheap endpoints pay.** The ready set would have to
  choose between an expensive exact count and a capped one presented as exact.
  Neither belongs in a first cut, and §5's cheap-page promise is the reason.
- **Growth is additive under §8.** If a further collection later gains a cheap
  count, it moves from `ListEnvelope` to `RankedListEnvelope` — which is "a new
  field on a response object", explicitly on §8's allowed list. The reverse
  (retracting a `totalCount` that turned out to be expensive) is forbidden, which
  is the asymmetry that argues for starting narrow.

**Rung 1.** Both mirrors do exactly this rather than promising a count
everywhere: Plane returns `total_count` on its paginated list responses while its
cursor contract stands on its own, and GitLab documents that on keyset-paged
endpoints the total-count headers are **omitted** — the count is a property of
the collection, not of pagination.

**11.4's obligation, stated here so it is not a question later:** the OpenAPI
assembly emits **two** named envelope schemas, and each operation references the
one its route returns.

##### Rejected alternatives

| Rejected                                             | Why                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drop `totalCount` entirely**                       | Throws away a number the read already computed, and a client rendering "N issues" would have to walk the whole collection to recover it — turning a bounded aggregate into an unbounded scan on the client side.              |
| **`totalCount: number \| null` on the ONE envelope** | Makes `null` mean "not counted", indistinguishable from a real value without out-of-band knowledge of which endpoint you called. One schema that lies in four places out of six is not simpler than two that are each true.   |
| **Count everywhere, including the ready set**        | An exact ready count runs the readiness predicate over every candidate; the shipped surface caps it at 99 for that reason. Paying it on every page would break §5's cheap-page promise on the endpoint agent loops poll most. |
| **A separate `GET …/count` endpoint**                | A second round trip for a number one of the two reads already has, and a new endpoint whose answer can disagree with the page it accompanies.                                                                                 |

#### Q3 — a by-id read that no service exposes

##### The conflict

`GET /api/v1/sprints/{sprintId}` needs one sprint as a `SprintDto`.
`sprintsService` (`lib/services/sprintsService.ts`) exposes `createSprint` /
`getActiveSprint` / `validateSprint` / `updateSprint` / `deleteSprint` /
`listByProject` / `startSprint` / `completeSprint` / `getSprintReport` — and **no
by-id DTO read**. Only `sprintRepository.findById` exists, a Prisma row §9
forbids a route to touch. `getActiveSprint` cannot stand in either: it returns
`toSprintDto(row, 0)`, so `issueCount` is **hard-coded 0** and an endpoint built
on it would report every active sprint as empty.

Amendment 1 carved out "a new page ADDRESSING over an unchanged predicate". A
by-id re-presentation is the same class — same tenancy gate, same mapper, same
fields, no new predicate, no write — but it is not literally on that amendment's
permitted list, and the permitted/forbidden table is what a reviewer reads.

##### The decision

**Extend Amendment 1's table explicitly rather than arguing by analogy at review
time.** Permitted: **a by-id read that re-presents an already-shipped repository
read through the already-shipped mapper, adding no field, no gate and no filter
axis.** Forbidden, and added to the same table's right-hand column: **anything
that changes what the row CONTAINS.**

The line is what the row says, not how it is addressed. `getSprintById` may read
`sprintRepository.findById`, apply the same `workspaceId` tenancy gate every
sibling read applies, compute `issueCount` the way `listByProject` already does
(`workItemRepository.countSprintIssues`), and return `toSprintDto` — because
every one of those already exists and the resulting DTO is byte-for-byte a row
`listByProject` would have returned. It may not add a field, relax the gate, or
compute a number no shipped read computes.

**Why this is a carve-out and not simply "write a service method":** §9's
corollary says an endpoint that appears to need a new service method is a card in
the owning epic. Read literally that would send a one-line re-presentation into
Epic 4's backlog and block a read that changes nothing. Read loosely it would
license any service method v1 wanted. The table is the line.

##### Rejected alternatives

| Rejected                                                           | Why                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Call `sprintRepository.findById` from the route**                | Violates §9's no-repository rule and the 4-layer contract, and MOTIR-1861's shipped guard would fail it. It also puts the `workspaceId` tenancy gate in a route, which is where a tenancy bug goes unnoticed.                       |
| **Reuse `getActiveSprint`**                                        | Its `issueCount` is hard-coded `0` (`toSprintDto(row, 0)`), so it answers a different question wrongly. It also only ever finds the ACTIVE sprint — a planned or complete sprint would 404 for no reason a client could understand. |
| **Derive the sprint from `listByProject` and filter in the route** | Reads every sprint to return one, and the route would have to know the sprint's project before it has read the sprint. Business logic in a route, dressed as a read.                                                                |
| **File it as a card in Epic 4**                                    | A one-line re-presentation that changes no behaviour would block a read endpoint on an unrelated epic's queue. Amendment 1 exists because that reading of §9 is too literal to be useful; this is the same case.                    |

#### Q4 — a page projection is a SECOND service call

##### The conflict

§9 says a v1 route "calls **ONE** service method, and returns". The ready
endpoint calls `workItemsService.listReady` for the page and
`workItemsService.getDependencyEdgesForItems` for that page's edges — which is
exactly what the shipped MCP transport does (`lib/mcp/tools/listReady.ts`), and
deliberately: the edge block is attached at the TRANSPORT and is not on
`ReadyItemDto`, because widening the DTO would ship an edge payload to the
`/ready` page that does not consume it.

The literal rule is also already not what the codebase does. Every shipped
project-scoped v1 route resolves the project key and then reads — two calls
(`app/api/v1/projects/[projectKey]/work-items/route.ts`).

##### The decision

**Replace the literal call count with the BOUNDED-CALL RULE.** A v1 route may
make a **bounded, constant** number of service calls that RESOLVE or PROJECT the
same response:

- **Resolve** — turning a path segment into what the services address
  (`projectsService.getByKey`, `resolveWorkItemKey`).
- **Project** — a batched enrichment over the ids the first call returned
  (`getDependencyEdgesForItems`, `getCommentCountsForItems`).

It may **not** make a call whose result it **branches on, loops over, or combines
into a derived answer**. That is the test, and it is what separates a projection
from business logic: a projection's result is attached to rows the route already
has; business logic's result changes what the route does next.

**The ceiling is CONSTANT, never per-row.** A fixed number of calls for a page of
any size is a projection. One call per row is an N+1, and it is forbidden however
thin each call is — the shipped batched reads (two queries for a whole page,
whatever the page size) are the bar, and the reason `getDependencyEdgesForItems`
takes an id array rather than an id.

The no-`db.*` / no-`$transaction` rule is untouched: a route still never opens a
transaction, and a projection that would need one is not a projection.

##### Rejected alternatives

| Rejected                                               | Why                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hold the literal "ONE call" rule**                   | Already false of every shipped project-scoped route (key resolution is a call), so enforcing it literally would fail code that is correct — and a rule the codebase visibly breaks stops being read at all.                                           |
| **Widen `ReadyItemDto` with the edges**                | Ships an edge payload to the `/ready` page that does not consume it, for the benefit of one API endpoint — a v1 concern reaching into a product DTO, the same direction Q1 rejected. The transport is where the shipped code already draws this line. |
| **Add a new service method that returns page + edges** | A new service method to satisfy a presentation need, which §9's corollary forbids and which would exist for exactly one caller. The batched projection already exists and is already the pattern.                                                     |
| **"A route may make any number of read calls"**        | Removes the rule instead of stating it. The thing worth forbidding — a route that reads, branches, reads again and assembles an answer — is business logic in a route, and this wording would permit it.                                              |
