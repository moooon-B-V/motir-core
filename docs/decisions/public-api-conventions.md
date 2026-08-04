# ADR: The public `/api/v1` contract — versioning, auth, errors, pagination, rate limits, naming, stability

- **Status:** Accepted (2026-08-03) · **Amended 2026-08-03** (see
  [Amendments](#amendments) — Subtask 11.2.1, MOTIR-2038). §5 and §9 must be read
  together with Amendment 1; response shaping with Amendment 2.
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
> and [Amendment 2](#amendment-2-2026-08-03--a-v1-response-is-a-schema-output-and-each-resource-story-owns-its-schemas).**
> Amendment 1 carves out a **bounded** exception to the corollary below (a new
> page ADDRESSING over an unchanged predicate is not new behaviour). Amendment 2
> settles where the response shapes live. The thin-adapter rule itself, and the
> no-`db.*` / no-`$transaction` rule, are unchanged.

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

| Permitted under the carve-out                                    | NOT permitted — still a card in the owning epic |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| A keyset window over the **same compiled predicate**             | A new filter axis or facet                      |
| A different ORDER BY, where the ordering is the page addressing  | A new or relaxed access gate                    |
| An optional `limit` where the shipped read has a fixed page size | A new field on the returned row                 |
| Fetching `limit + 1` instead of a `COUNT` denominator            | Any migration                                   |
|                                                                  | Any write path                                  |
|                                                                  | Raising an EXISTING cap on an existing method   |

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
