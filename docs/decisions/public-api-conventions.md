# ADR: The public `/api/v1` contract — versioning, auth, errors, pagination, rate limits, naming, stability

- **Status:** Accepted (2026-08-03) · **Amended 2026-08-03** (Subtask 11.2.1,
  MOTIR-2038) · **Amended 2026-08-04** (Subtask 11.3.1, MOTIR-2058) · **Amended
  2026-08-05** (Subtask 11.4.1, MOTIR-2182 — the OpenAPI mechanics; MOTIR-2195 —
  the ownership split's missing owner). See [Amendments](#amendments), which is
  the authority on the full list. §5 and §9 must be read together with
  Amendments 1 and 3; response shaping with Amendments 2 and 5.
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

> **⚠️ Amended 2026-08-05 — see [Amendment 6, Q2](#q2--scopes-mirror-libmcpscopests-the-map-is-the-source-this-table-is-derived).**
> The table below maps the CRUD surface it was written for. Amendment 6 states the
> underlying principle — **one capability model, two transports** — and records
> that a v1 operation MIRRORS its MCP counterpart's entry in `TOOL_SCOPES` rather
> than deriving a scope from an HTTP verb. A `read`-scoped POST is therefore
> correct and is not an exception to this clause.

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

| Status  | Condition                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **401** | No token, malformed header, unknown token, revoked token, expired token — **all five undifferentiated**                                                                                                                                                       |
| **403** | A valid token whose granted scopes do not include the required one                                                                                                                                                                                            |
| **404** | The resource does not exist **or** is outside the token's workspace — deliberately the same answer                                                                                                                                                            |
| **409** | A conflict with existing STATE, not a malformed request — e.g. creating a link that already exists (added 2026-08-03 by Subtask 11.2.9; likewise a new condition, permitted by §8)                                                                            |
| **412** | An `If-Match` precondition failed — the resource moved since the validator was issued (added 2026-08-03 by Subtask 11.2.6; a NEW condition getting a status, which §8 permits, not an existing condition changing one)                                        |
| **422** | A malformed request: an invalid cursor, an out-of-range or non-numeric `limit`, a failed body validation                                                                                                                                                      |
| **402** | The workspace owner's AI credits are exhausted — the request was valid and was refused for want of BALANCE (added 2026-08-05 by Subtask 11.7.5; a new condition, permitted by §8)                                                                             |
| **429** | The token's rate-limit budget is exhausted (§6)                                                                                                                                                                                                               |
| **500** | An unexpected server fault — body carries no `code`, no stack, no driver text                                                                                                                                                                                 |
| **503** | A dependency the operation needs — the motir-ai planning service — could not be reached or is misconfigured (added 2026-08-05 by Subtask 11.7.5; a new condition, permitted by §8). Distinct from 500: the request was fine and a retry is the right response |

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

> **⚠️ Amended 2026-08-05 — the SUCCESS vocabulary gains `202`, and the table
> above gains `402` and `503`; see
> [Amendment 6, Q3](#q3--a-job-submitting-endpoint-publishes-accepted-and-cannot-publish-a-result).**
> The two job-submitting endpoints return before anything has been planned, so
> "accepted" needs a status of its own. `402` and `503` arrive with the same
> endpoints (Subtask 11.7.5): an exhausted AI balance is neither a malformed body
> nor a spent rate-limit window, and an upstream planning service being down is
> not an UNEXPECTED fault, so §4's code-less 500 would tell a client nothing it
> could act on. All three are NEW conditions getting a status, which is what §8
> permits and what 409 and 412 already arrived by; no existing condition changes
> status.
>
> **⚠️ The table above is the STATUS VOCABULARY the emitted document must cover —
> see [Amendment 4](#amendment-4-2026-08-05--how-the-openapi-31-document-is-emitted-where-it-is-served-and-what-the-published-reference-is).**
> Story 11.4 declares it as a value reconciled against `DOMAIN_ERROR_STATUS`, so a
> status the code can return but this table does not list is a test failure rather
> than a documentation gap.

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

> **⚠️ Amended 2026-08-05 — see [Amendment 6](#amendment-6-2026-08-05--the-work-loop-resources-paths-and-verbs-scope-mirroring-the-job-handle-and-the-three-projections-as-8-additions).**
> The rules below stand. Amendment 6 pins the paths and verbs for Story 11.7's ten
> work-loop operations — the first that are not plain CRUD on a noun — and grants
> ONE reasoned exception to the plural rule (`plan-session`, a resource with
> exactly one member per scope that is never addressed by id).

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

> **⚠️ Applied 2026-08-05 — see [Amendment 6, Q4](#q4--the-three-field-projections-are-8-additions).**
> Story 11.7 widens three shipped response schemas (per-child and per-row
> dependency edges, and the blocked ancestor's title). The amendment records them
> as §8-permitted ADDITIONS with the bounded-projection form named, so the
> permission is a decision a reader can find rather than one they re-derive.

> **⚠️ Amended 2026-08-06 — see [Amendment 8](#amendment-8-2026-08-06--api1-advertises-its-contract-version-on-every-response).**
> The allowed list gains **a new response header**, which is what `X-Motir-Api-Version`
> lands under. The amendment also records the obligation that comes with it: an
> additive change now MUST move `V1_CONTRACT_VERSION`, because the number is on a
> header every client reads rather than in a document nobody fetches at runtime.

Within `v1`:

- **Allowed (additive):** a new endpoint; a new optional query parameter; a new
  field on a response object; a new response header; a new enum value on a field
  documented as open-ended; a raised rate-limit budget.
- **Forbidden without a new major:** removing a field; renaming a field;
  changing a field's type or nullability; removing or re-purposing an error
  `code`; changing an existing status for an existing condition; tightening a
  limit; making an optional parameter required.

**Therefore a client MUST tolerate unknown fields.** That obligation is the other
half of the promise and is stated in the reference docs (11.4).

> **⚠️ Published as `/docs/api/stability` — see
> [Amendment 4, Q5](#q5--what-the-published-stability--deprecation-policy-says)**
> (the area was renamed from `/api-docs` by
> [Amendment 9, Q1](#q1--the-area-is-renamed-to-docs-with-permanent-redirects-the-sandbox-guide-is-docssandbox),
> and the page moved inside the reference's own prefix by
> [Amendment 11, Q3](#q3--what-moves-what-redirects-and-what-does-not-rename)).
> The public page is generated from THIS clause's lists rather than re-typed, so the
> internal record and the published promise cannot say different things. Amendment 4
> also pins the deprecation channel (`deprecated: true` in the spec) and how a `v2`
> arrives alongside `v1`.

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
> where the response shapes live, and
> [Amendment 5](#amendment-5-2026-08-05--the-ownership-split-is-total-and-a-v1-route-maps-through-its-schema)
> makes that split total and pins that a route MAPS through its schema.
> Amendment 3 also replaces the literal **ONE**
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

| Rejected                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Offset pagination** (`?page=` / `?offset=`)                      | Silently skips and duplicates rows when the collection mutates mid-scan — which for Motir is the normal case, not an edge case, since agent loops write while clients read. Simpler to implement and impossible to make correct.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Header versioning** (`X-Motir-Api-Version`)                      | Legitimate and used by GitHub and Stripe (§1 records the real evidence). Rejected because it leaves the public/internal boundary invisible inside one `app/api/**` tree, and because it only pays for itself with per-version transformation infrastructure that a self-hostable product with drifting client/server pairs would still find less debuggable than a visible path. **⚠️ Still rejected — as a MECHANISM for choosing a version. [Amendment 8](#amendment-8-2026-08-06--api1-advertises-its-contract-version-on-every-response) ships a RESPONSE header of the same name that merely REPORTS the contract version; it is never read off a request and selects nothing.** |
| **Query-parameter versioning** (`?v=1`)                            | Same "same resource, two names" objection as path versioning but without its one benefit — the boundary is not visible in the route tree — and trivially lost when a client drops the parameter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`X-API-Key` as an alternative header**                           | A second auth path doubles the surface that must stay correct, and every gate would have to accept both forever. `Authorization: Bearer` is already shipped, already parsed, and already what both mirrors use. One auth path.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **A session-cookie fallback**                                      | Would make CSRF a concern on a surface that currently has none: a bearer-only endpoint cannot be driven by a browser carrying a victim's cookie. The web app has its own cookie-authenticated tree; the public API stays credential-disjoint from it.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Exposing `work_items:delete` in the first cut**                  | The only irreversible, subtree-cascading operation, already off by default in `DEFAULT_TOKEN_SCOPES`. Exposing it later is additive under §8; withdrawing it later would be breaking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **A distinct error shape for validation errors**                   | Two error shapes means every client writes two parsers. 422 carries the same `{ code, error }`; per-field detail, if ever needed, is an additive field under §8.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Distinguishing 401 causes** (`TOKEN_EXPIRED` vs `TOKEN_REVOKED`) | Friendlier, and a token oracle. The shipped MCP gate already refuses to distinguish them; the public surface is exactly where that refusal matters most.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Per-endpoint or per-scope rate budgets**                         | One budget for v1's first cut. Differentiated budgets are additive later and pre-building them means guessing at traffic shapes that do not exist yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Rate-limiting by IP**                                            | Shared NATs, CI runners and corporate proxies collide, so one tenant's traffic would refuse another's. Per token is both fairer and revocable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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

> **⚠️ Extended 2026-08-05 — the list below was missing Story 11.1's own two
> endpoints, and gains their owner; see
> [Amendment 5](#amendment-5-2026-08-05--the-ownership-split-is-total-and-a-v1-route-maps-through-its-schema).**
> Amendment 5 also states how the split is CHECKED (by walking `app/api/v1`, not
> by re-reading these sentences) and what happens to an endpoint that arrives
> without an owner. The three sentences below are unchanged and still correct.

- **11.1** owns the identity and workspace shapes — the `/me` payload and the
  workspace summary row — in `lib/api/v1/identity/` (Amendment 5).
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

### Amendment 4 (2026-08-05) — how the OpenAPI 3.1 document is emitted, where it is served, and what the published reference is

**Amends:** nothing in §1–§9 substantively; it SETTLES the mechanics Story 11.4
needs and that no clause had answered. It cross-links §4 (the status vocabulary
the document must cover) and §8 (whose promise the published policy page states).
**Leaves unchanged:** Amendment 2's ownership split in full — this amendment
decides mechanism INSIDE that boundary and never re-opens who authors a shape.

#### The problem

Amendment 2 settled _who_ declares a response shape. It did not settle how those
declarations become a document, where a client fetches it, or what the human-facing
reference actually is. Those three are load-bearing rather than merely untidy: the
document has to be _generated_ from the shapes the routes already return or it is a
second artifact that drifts (the failure Story 11.4 exists to prevent); the spec's
address is a URL that clients and code generators hard-code, so moving it later
breaks them; and the reference has to live somewhere that exists.

Six questions, answered below. **Two of the planner's recommendations are overturned
here on the evidence the card asked for — Q3 and Q4's renderer.** Both are recorded
with what contradicted them, because a recommendation that survives an unrun check
is worth less than one that survives a run check.

---

#### Q1 — the emission mechanism: `zod/v4`'s first-party `z.toJSONSchema()`

##### The decision

**Migrate `lib/api/v1/**`to the`zod/v4`subpath and emit with the first-party`z.toJSONSchema()`.\*\* No new dependency, no third-party emitter.

**Rung 2, run rather than assumed.** The installed `zod@3.25.76` already ships the
v4 core on the `zod/v4` subpath:

```
$ node -e "const z=require('zod/v4');
           console.log(JSON.stringify(z.toJSONSchema(z.object({code:z.string(),error:z.string()}))))"
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
 "properties":{"code":{"type":"string"},"error":{"type":"string"}},
 "required":["code","error"],"additionalProperties":false}
```

The emitted dialect is **JSON Schema 2020-12**, which _is_ OpenAPI 3.1's schema
dialect — so there is no down-conversion step, and no lossy 3.0 shim. That is the
reason §1's document targets 3.1 rather than 3.0 at all.

**Rung 1.** Declaring the schema with the operation and generating the document
from the operations is how every schema-first HTTP stack works (FastAPI, NestJS,
`zod-to-openapi`). Amendment 2 already adopted the first half; this adopts the
second with the emitter the schema library itself now ships.

##### The blast radius, enumerated by grep — the migration is TOTAL or it is broken

Zod 3 and Zod 4 instances do not interoperate, so a half-migrated tree fails at the
seam. **Eight files** import `zod` inside the v1 surface and must move together
(`grep -rn "from 'zod'" lib/api/v1 app/api/v1`):

| File                                               | Why it is in the set                                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `lib/api/v1/workItems/schema.ts`                   | the resource schemas + `parseV1Body`                                                                                              |
| `lib/api/v1/projects/schema.ts`                    | resource schemas                                                                                                                  |
| `lib/api/v1/sprints/schema.ts`                     | resource schemas                                                                                                                  |
| `lib/api/v1/sprints/membership.ts`                 | request schemas                                                                                                                   |
| `lib/api/v1/ready/schema.ts`                       | resource schemas                                                                                                                  |
| `app/api/v1/work-items/[key]/links/route.ts`       | composes `z.object({ toKey: workItemKeySchema, relationship: relationshipSchema })` — a **direct cross-version composition site** |
| `app/api/v1/work-items/[key]/transitions/route.ts` | declares an inline body schema passed to `parseV1Body`                                                                            |
| `app/api/v1/work-items/[key]/comments/route.ts`    | same                                                                                                                              |

The links route is the concrete proof that the migration cannot be partial: it
builds a `z.object` from the classic entrypoint around two schemas imported from a
resource module. If the module moves to v4 and the route does not, that expression
is a Zod-3 object wrapping Zod-4 members — the exact non-interoperation case.

`parseV1Body(req, schema: z.ZodType<T>)` (`lib/api/v1/workItems/schema.ts:592`) is
the second: its parameter type pins every caller's schema to the same major.

**The other 36 files that import a v1 schema module are NOT in the set** — the 16
route files and 20 test files that import shapes without importing `zod` themselves
call `.parse` / `.safeParse` on a value and never compose one, so they need no edit.
`lib/api/v1/rankedCollections.ts` imports schema modules but no `zod` and is likewise
outside it. **Zod stays on the classic entrypoint everywhere else in the repo** (the
MCP tool input schemas, the forms): this amendment migrates the v1 surface only, and
the boundary is exactly "does this module construct a v1 schema?".

**The invariant that makes the boundary checkable:** no module under `lib/api/v1/**`
or `app/api/v1/**` may import BOTH `zod` and `zod/v4`. Subtask 11.4.3 asserts it.

##### Rejected alternatives

| Rejected                                                          | Why                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep Zod 3 + `@asteasolutions/zod-to-openapi`**                 | A third-party emitter tracking a schema library whose successor is already in `node_modules`. It also wants schemas registered through its own `extendZodWithOpenApi` wrapper, which puts a documentation concern into the declaration site Amendment 2 gave to the resource stories. |
| **Keep Zod 3 + `zod-to-json-schema`, hand-assemble the document** | Most control, and most hand-written OpenAPI — the two-artifact drift this story exists to prevent, reintroduced at the assembly step instead of the schema step.                                                                                                                      |
| **Migrate the WHOLE repo to `zod/v4`**                            | A far larger diff than any card in this story owns, touching forms and the MCP input schemas that have nothing to do with the spec. The v1 boundary is where the emitter is needed and where the composition graph is closed.                                                         |
| **Emit OpenAPI 3.0 instead**                                      | Would require down-converting 2020-12 to 3.0's divergent schema subset (nullable, no `examples`, no `$defs`), i.e. adding a lossy step for no gain. Every mirror is on 3.x and Scalar/Redoc/Swagger UI all read 3.1.                                                                  |

---

#### Q2 — an operation is declared beside its schemas, and one registry makes route↔spec totality mechanical

##### The decision

**A per-resource `operations.ts` beside each `schema.ts`**, assembled by ONE
registry keyed by `` `${METHOD} ${path}` `` — the same "declared with the operation"
logic Amendment 2 used for shapes, and the same registry-driven totality pattern
`lib/mcp/registry.ts` + `lib/mcp/scopes.ts` already ship, where `TOOL_SCOPES` is
typed `Record<McpToolName, TokenScope>` so a tool without a scope is a **compile
error** rather than a review finding.

An operation declares: method, path template, summary, path/query parameters,
request body schema (where it has one), the success response's status + schema, the
error statuses it can produce, and its required scope.

##### The scope is ASSERTED equal to the route's, never sourced from the registry

**The route's `withV1Route({ scope })` stays the single enforcement point.** The
registry records the scope for the document and the drift guard asserts the two
agree; it does not feed the request path.

This is deliberate and is the more conservative of the two. Sourcing enforcement
from the registry would put a documentation artifact on every authenticated request
and would mean a mistake in the docs is a **security** defect rather than a wrong
sentence. It would also fight the shipped guard: `declaredScopeByMethod`
(`tests/helpers/v1RouteAudit.ts`) already reads the scope literal per exported verb
precisely so a per-operation check is possible, and `auditV1RouteSource`'s
`no-scope-declared` rule requires the literal to be _in the route file_.

##### Rejected alternatives

| Rejected                                                     | Why                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **One central `operations.ts` listing every endpoint**       | The file Amendment 2 refused for shapes, rebuilt for operations: a second place to update when a route changes, updated by a different person than the one changing the route. |
| **Derive operations from the route tree by static analysis** | The tree gives method and path and nothing else — no response schema, no parameters, no scope semantics. A parser guessing at the rest is a third artifact that can be wrong.  |
| **Make the registry the source of the enforced scope**       | Puts documentation on the request path and turns a docs typo into a privilege bug. It also deletes the independent second opinion the drift guard exists to be.                |

---

#### Q3 — the spec is served at `/api/openapi/v1.json`, OUTSIDE `app/api/v1` — the recommendation to exempt the route audit is OVERTURNED

##### The conflict

`tests/helpers/v1RouteAudit.ts` walks _every_ `route.ts` under `app/api/v1`
(`v1RouteFiles`, rooted at `join(repoRoot, 'app', 'api', 'v1')`) and raises
`bypasses-wrapper` for any exported handler not wrapped in `withV1Route` — and
`withV1Route` authenticates. A spec is public documentation, so a route at
`/api/v1/openapi.json` cannot pass the shipped guard as written.

The card recommended serving it there **with one named, asserted exemption**,
_"if rung 1 agrees"_.

##### Rung 1 does NOT agree — checked, not assumed

- **Gitea** serves its specification at **`/swagger.v1.json`** — at the instance
  ROOT, outside the `/api/v1` tree its endpoints live under — with the interactive
  UI at `/api/swagger`.
  ([docs.gitea.com](https://docs.gitea.com/development/api-usage/))
- **GitLab** does not serve a spec from the versioned API tree at all: the document
  (`doc/api/openapi/openapi_v3.yaml`) lives in the source tree and is published on
  the docs site, rendered with Scalar.
  ([docs.gitlab.com/api/openapi](https://docs.gitlab.com/api/openapi/))

Neither mirror puts its specification inside its authenticated versioned API tree.
The premise the recommendation was conditioned on is false, so it falls.

##### The decision

**Serve the spec at `/api/openapi/v1.json`** — `app/api/openapi/v1.json/route.ts`.
Under `app/api/` where every route handler in this repo lives, and **outside**
`app/api/v1/`, so:

- the route audit's walker never sees it and **no exemption is written** — the guard
  keeps its current, unconditional form, which is worth more than the tidiness of a
  neighbouring URL. An exemption is a hole that must be re-justified by every future
  reader; a path outside the tree is a hole that does not exist;
- it stays beside the API for discoverability, satisfying the same instinct the
  recommendation had;
- the dotted final segment is the documented Next.js App Router idiom for a route
  handler serving a named file (`app/sitemap.xml/route.ts`), so `v1.json` is a legal
  segment, not a trick;
- `proxy.ts`'s matcher covers only `/dashboard`, `/settings` and `/invite`, so no
  middleware gates it — it is genuinely anonymous, which is what a code generator
  fetching it needs.

**The URL is public API under §8** the moment it ships: it may gain a sibling
(`/api/openapi/v2.json`, Q6) but `/api/openapi/v1.json` never moves while `v1` lives.

##### Rejected alternatives

| Rejected                                                                             | Why                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`/api/v1/openapi.json` + an asserted audit exemption** (the card's recommendation) | Weakens a shipped, unconditional security guard for a documentation file, and neither mirror does it. The exemption would also have to be re-argued forever: "this one route may skip auth" is exactly the sentence a later reader copies. |
| **A root-level `/openapi.v1.json`** (Gitea's literal shape)                          | Gitea's root is where its spec has always lived; ours has an `app/api/` convention every handler already follows. Matching Gitea's _principle_ (outside the versioned tree) beats matching its path.                                       |
| **Publish only as a build artifact / repo file** (GitLab's shape)                    | §8 promises a stable URL a generator can fetch, and 11.5's CLI generation depends on it. A file in the repo is not fetchable by a client integrating against a running deployment.                                                         |
| **`/docs/api/openapi.json`**                                                         | Puts a machine artifact under a human-documentation path, and collides with the reference PAGE's own route namespace (Q4).                                                                                                                 |

---

#### Q4 — the reference lives in `motir-core` at `app/(public)/`, rendered from our OWN primitives

##### Home — `motir-core`, public route group

**Rung 2, and it retires the placement question the story left open.**
`motir-marketing` **does not exist**: `gh repo list moooon-B-V` returns `motir-core`,
`motir-ai`, `motir-meta`, `motir-gateway`, `nextjs-prisma-vercel-starter`,
`nextjs-prisma-vercel-starter-with-design` and `moooon` — no marketing repo. Its
provisioning card (MOTIR-1455, 8.3.10) is `todo` beneath a `todo` story in another
epic, so planning a page into it would have produced work nobody could do. Epic 11's
own boundary pins every deliverable to `motir-core`, and `app/(public)/explore/` is
the shipped precedent for an unauthenticated, indexable page group.

Routes: **`/docs/api`** for the reference, `/docs/getting-started` for the guide,
`/docs/stability` for the policy (Q5) — under `app/(public)/docs/`.

> **⚠️ Amended 2026-08-06 — these routes were `/api-docs*` as originally decided.**
> [Amendment 9, Q1](#q1--the-area-is-renamed-to-docs-with-permanent-redirects-the-sandbox-guide-is-docssandbox)
> renamed the area to `/docs` when it gained its first non-API page, with permanent
> redirects from every `/api-docs*` path. Only the ADDRESSES moved: the `apiDocs`
> next-intl namespace, `lib/apiDocs/`, `design/api-docs/` and `tests/api-docs/` keep
> their names.
>
> **⚠️ Amended again 2026-08-06 — the guide and the policy moved INSIDE the
> reference's prefix.** [Amendment 11, Q1](#q1--the-area-is-a-set-of-sub-areas-one-per-documented-surface-the-api-reference-owns-docsapi)
> makes `/docs` a set of sub-areas, one per documented surface, and gives the API
> reference `/docs/api/*`: the guide is now **`/docs/api/getting-started`** and the
> policy **`/docs/api/stability`**, each with a permanent redirect from its former
> address. `/docs/api` itself is unchanged, and so is the addresses-move rule above.

##### Renderer — our own primitives; the third-party renderers are REJECTED

**This overturns the "pick one and self-host it" framing**, which presumed the answer
was a spec-rendering library. Weighing it against the repo's shipped constraints, it
is not:

- **The design system is not optional here.** `CLAUDE.md` requires every colour to
  route through `--el-*` element tokens and every surface's radius/padding/sizing
  through element-semantic shape tokens, precisely so `data-palette` and
  `data-style` can re-skin and re-shape the whole app. Scalar, Redoc and Swagger UI
  each ship their own complete visual system and their own CSS custom properties;
  mounted here, one produces the single largest surface in the product that neither
  axis reaches. Motir dogfoods its own design system — a documentation page that
  visibly is not Motir is the worst place to make an exception.
- **11.4.2 is a `type: design` subtask producing a three-file asset for this
  surface.** A third-party renderer owns its own markup, so there would be nothing
  for that asset to specify and nothing for a reviewer to compare the built page
  against. Choosing a library would silently make an approved design undeliverable.
- **Bundle.** Scalar's React reference and `swagger-ui-react` are each on the order
  of a megabyte of JS before the spec; Redoc is comparable. Our renderer reads a
  JSON document we generate and lays it out with primitives already in the bundle —
  no new dependency, no new licence, no CDN, and it works on a self-hosted install
  with zero egress (the constraint the question already imposed).
- **`next-intl` chrome.** The page chrome must go through the shipped catalog gate;
  a third-party renderer's own strings cannot.

**Rung 1 is acknowledged and deliberately deviated from:** GitLab renders with
Scalar, Gitea with Swagger UI. Both publish on a docs property rather than inside
the product, and neither dogfoods a swappable design system. The deviation is
recorded here rather than left to be discovered.

##### Language

Page chrome goes through `next-intl` with `messages/en.json` + `messages/zh.json`
parity (the shipped catalog gate). **Spec-derived operation text stays English** —
summaries, descriptions, parameter and field documentation, error `code` values —
because the spec is ONE document and a translated contract is a second one that can
disagree with the first. **Long-form documentation prose follows the same rule as the
chrome, not the spec:** the getting-started guide and the stability policy (Q5) are
Motir's own words about the API rather than the contract itself, so they are
localized like any other page. The line is: _if a client could parse it, it is
English; if only a human reads it, it is localized._

##### Rejected alternatives

| Rejected                                 | Why                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The reference on a marketing site**    | The repo does not exist and its provisioning card has not started. An undispatchable home.                                                                                                       |
| **Scalar / Redoc / Swagger UI embedded** | Ships a second visual system into a product whose two design axes are load-bearing, makes 11.4.2's design asset meaningless, and costs ~1 MB of JS to render a document we already hold as JSON. |
| **A CDN-hosted renderer**                | Breaks on a self-hosted install with no egress, and makes a third party a runtime dependency of our documentation.                                                                               |
| **Render the reference behind auth**     | Documentation a prospective integrator cannot read before signing up is not published documentation. `app/(public)/` exists for exactly this.                                                    |
| **Translate the operation text**         | Two versions of a contract, and the translated one is wrong the moment the spec changes.                                                                                                         |

---

#### Q5 — what the PUBLISHED stability + deprecation policy says

§8 is the internal record; **`/docs/api/stability`** (`/api-docs/stability` as
originally routed — Amendment 9 Q1; moved inside the reference's prefix by
[Amendment 11, Q3](#q3--what-moves-what-redirects-and-what-does-not-rename)) is the
promise a third party
integrates against. **They are the same promise, stated twice for two audiences, and
the page is generated from §8's lists rather than re-typed** — a second hand-written
copy of a stability promise is the same drift this story exists to prevent, applied
to prose.

The page states:

1. **What `v1` guarantees** — the path is stable while `v1` lives; a `code` never
   changes meaning; an existing condition never changes status; a field never
   changes type or nullability.
2. **Additive (allowed without notice)** — a new endpoint; a new optional query
   parameter; a new field on a response object; a new enum value on a field
   documented as open-ended; a raised rate-limit budget; a new error `code` for a
   NEW condition. (§4's own 409 and 412 rows are the worked precedent — both were
   added as new conditions, not changed ones.)
3. **Forbidden without a new major** — removing or renaming a field; changing a
   field's type or nullability; removing or re-purposing an error `code`; changing an
   existing status for an existing condition; tightening a limit; making an optional
   parameter required.
4. **The client's obligation** — a client MUST tolerate unknown fields and unknown
   enum values, and MUST NOT parse the human `error` sentence. §8 already states the
   first as "the other half of the promise"; the page is where the other half is
   actually delivered to the party that owes it.
5. **The deprecation window and its announcement** — a deprecated operation or field
   is marked `deprecated: true` **in the spec** (so a generator surfaces it), carries
   the reason and the replacement in its description, and keeps working for the
   announced window. The spec is the announcement channel because it is the one
   artifact every client already reads.
6. **How `v2` arrives** — as a second document at a second path, served alongside
   `v1` (Q6). `v1` is not rewritten and does not stop working the day `v2` ships;
   deprecating it is itself an announcement under the same window.

§8 gains a pointer to this page so the two cannot say different things.

---

#### Q6 — one document per API MAJOR version, keyed from the start

**The emitter is keyed by major version, and the degenerate case is one document
today.** `v2` becomes a second document at `/api/openapi/v2.json` served beside the
first, never a rewrite of it — which is the only shape under which §8's "keep the old
behaviour working for the announced window" is expressible as an artifact rather than
a promise.

**`info.version` is the API contract's version, NOT the app's release number.** It is
`MAJOR.MINOR.PATCH` where MAJOR is the path version (`1`), MINOR increments on an
additive change under §5's allowed list, and PATCH on a documentation-only
correction. A client reading it learns what the contract offers; the deployment's
release number tells it nothing it can act on and would churn the document on every
unrelated deploy. (This is also what 11.5's "read the server's declared API version"
version-skew gate reads — one number with one meaning.)

---

#### Consequences of this amendment

- **11.4.3** performs the Q1 migration across the eight enumerated files and declares
  the shared shapes; the both-entrypoints invariant is asserted there.
- **11.4.4** builds the Q2 registry + emitter and the Q3 route.
- **11.4.6** asserts the Q2 scope equality and the three route↔spec drifts.
- **11.4.7 / 11.4.8** build the Q4 surface and the Q5 page.
- **11.5** generates the CLI's types from the Q3 URL and reads Q6's `info.version` for
  its skew gate.
- **11.6** composes MCP payloads from schemas that are now `zod/v4` values, so any
  MCP-side module that COMPOSES one (rather than calling `.parse` on it) joins the
  Q1 boundary.

---

### Amendment 5 (2026-08-05) — the ownership split is TOTAL, and a v1 route MAPS through its schema

**Amends:** Amendment 2's ownership list, which gains **11.1** and a rule for how
the list is CHECKED; and Amendment 2's corollary, which gains the missing half —
_the route emits the schema's output_.
**Leaves unchanged:** Amendment 2's three existing sentences, its corollary that a
v1 response is never a service DTO passed through, and Amendment 4 in full.
**Card:** MOTIR-2195, filed against Story 11.1 by the run that hit the gap.

#### The problem — a split that reads exhaustive and is not

Amendment 2 assigned the per-resource response schemas by STORY, in three
sentences that together sound like they cover the API. They cover every route
file except two. `GET /api/v1/me` (11.1.2, MOTIR-1858) and
`GET /api/v1/workspaces` (11.1.3, MOTIR-1859) shipped in July, **before** the
amendment existed, and belong to Story 11.1 — which none of the three sentences
names. Amendment 2 retired the inline form everywhere except the two routes that
predate it.

That is the ordinary way a rule acquires a blind spot: it is written about the
work in front of the author. The cost landed on **11.4.5** (MOTIR-2186), which
had to declare an OpenAPI operation for both endpoints and found no schema to
declare it from — with a scope boundary (_"11.4 … authors **no** per-resource
shape"_) forbidding exactly what its own first acceptance criterion (_"every
`route.ts` has an operation declared for each HTTP method it exports"_) required.
It authored `lib/api/v1/identity/schema.ts` and filed the gap rather than
papering over it. **This amendment ratifies that module and closes the gap.**

#### The decision

**1. Story 11.1 owns the identity and workspace shapes, in `lib/api/v1/identity/`.**
`meSchema` and `workspaceSummarySchema` stay exactly where 11.4.5 put them — the
path already matches the per-resource convention (`workItems/`, `projects/`,
`sprints/`, `ready/`), the module has no consumer but the operation declarations,
and moving a file to record a change of owner would be motion without a reader.
The change is that they are **11.1's**, not 11.4's, and Amendment 2's list now
says so. Amendment 2's boundary for 11.4 is restored intact: it authors no
per-resource shape, and the one it did author is transferred here rather than
excused.

**2. Ownership is over SHAPES, and it is checked by WALKING `app/api/v1` — never
by re-reading the sentences.** This is the load-bearing half, because the defect
was not a wrong sentence but a list that could not be audited against anything.
The walk enumerates the route files; each exported verb's response shape is then
read off the presenter the handler actually calls, and every one of them has an
owner. Walked on `origin/main` @ `cfda1e99` — **19 route files, none unowned**:

| Response shape reached from…                                                                                                        | Owner    | Module / presenter                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `me/`, `workspaces/`                                                                                                                | **11.1** | `lib/api/v1/identity/` — `meSchema`, `workspaceSummarySchema`           |
| `work-items/**`, `projects/{projectKey}/work-items/`                                                                                | **11.2** | `lib/api/v1/workItems/` — `presentWorkItemSummary` / `…Detail` / `…Ref` |
| `projects/**`, `sprints/**`, `projects/{projectKey}/ready/`, and the membership-move results on the two `…/work-items` write routes | **11.3** | `lib/api/v1/projects/`, `sprints/` (incl. `membership.ts`), `ready/`    |
| _(no route of its own)_ — the envelopes, error body, page cursor, rate-limit headers, security scheme                               | **11.4** | `lib/api/v1/openapi/`                                                   |

**A route file can compose shapes from more than one owner, and that is not an
exception.** The two ranked collections — `GET /projects/{projectKey}/backlog`
and `GET /sprints/{sprintId}/work-items` — return 11.2's `presentWorkItemRef`
rows inside 11.3's ranked envelope (`lib/api/v1/rankedCollections.ts`), and the
same two paths' write verbs return 11.3's `presentMembershipMove`. Ownership
follows the SHAPE, not the URL, which is why the check is "walk the tree and read
each presenter", not "match the path prefix".

The table is a snapshot and will go stale; **the walk is the check.** It is
already mechanized and needs no new guard: `tests/api/v1/openapi-operations-coverage.test.ts`
walks the tree with `v1RouteFiles()` and FAILS on an exported verb with no
declared operation, and `tests/api/v1/openapi-drift-guard.test.ts` FAILS when a
declared response no longer validates against a REAL response. An endpoint
therefore cannot ship shapeless. What those guards cannot decide is **whose**
shape it is — which is what the next paragraph is for.

**3. An endpoint whose shape has no owner is a PLAN GAP to file, not a shape for
Story 11.4 to author.** If a route arrives — now or after 11.1–11.4 are all
`done` — whose response shape no story owns, the run that finds it declares the
schema in the resource's own module, names this amendment in the module header,
and **files a card against the owning story** to record the ownership. It does
not silently widen 11.4's boundary, and it does not leave the endpoint out of the
published document (a reference that covers _some_ of an API is worse than one
that covers none). That is precisely the path 11.4.5 took, and it is ratified
here as the standing procedure rather than remembered as a one-off exception.

**4. A v1 route MAPS THROUGH its schema — the shape is the value the route
emits, not a description written beside it.** Amendment 2's corollary said a v1
response is a schema's OUTPUT; every resource shipped since honours it by
routing the row through a mapper the schema module exports (`presentProject`,
`presentWorkItemDetail`, `presentSprint`, `presentReadyItem`). The two identity
endpoints do not: they shape inline, and
`lib/api/v1/identity/schema.ts` merely _describes_ what they return. The
difference is small and real — a field added to `/me`'s inline literal would not
fail typecheck, only the parse test — and the guarantee the rest of the surface
has is that the document and the endpoint are the SAME expression, not two that a
test says agree today.

**This is a code change and it ships as its own card with its own PR** —
**MOTIR-2202** (Subtask 11.1.7), blocked by this decision (it changes
response-shaping code and is not a documentation edit): the two routes map
through `presentMe` / `presentWorkspaceSummary`, and neither route's own
reason for shaping explicitly — _"`verify` returns the raw Prisma `User` row and a
public API must never leak one"_ — is weakened by it. That instinct is what the
mapper institutionalises: field by field, never spread, in one place instead of
in the handler.

#### Rejected alternatives

| Rejected                                                           | Why                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leave the two endpoints owned by 11.4**                          | Makes Amendment 2's boundary ("authors **no** per-resource shape") false in the record while true in intent, and the next reader cannot tell a deliberate exception from a mistake — which is the exact confusion the module's own header was written to prevent.       |
| **Move the module to `lib/api/v1/me/` + `lib/api/v1/workspaces/`** | Two modules of one schema each, split along the ROUTE rather than the resource. `identity` is the resource both endpoints answer about, and it is the grouping the published reference already uses (`lib/apiDocs/reference.ts`).                                       |
| **Add a fourth sentence and stop there**                           | Fixes this instance and leaves the class: a prose list is still auditable only against itself. The route-file walk is what makes a future omission visible, and it was already shipped — writing a new prose check beside it would hand-roll a guard the code provides. |
| **Fold the map-through change into this card**                     | A documentation card that also edits two shipped routes' response shaping is two deliverables in one PR, and the second is the one that needs the conformance suite's full attention. Its own card, its own PR.                                                         |
| **Leave the two routes shaping inline, permanently**               | Accepts a weaker guarantee on the two OLDEST endpoints in the API — the ones most likely to be read as the pattern. The asymmetry would have to be explained forever; closing it costs one card.                                                                        |

#### Consequences of this amendment

- **Amendment 2's list is now total**, and its totality is checkable by a command
  (`walk app/api/v1`) rather than by re-reading three sentences.
- **`lib/api/v1/identity/schema.ts` is Story 11.1's**, and its header points here
  instead of recording an open gap.
- **The map-through change is carded** — **MOTIR-2202** (11.1.7), `blocked_by`
  this decision, in `motir-core`, one PR.
- **11.4's boundary is intact** — the one shape it authored is transferred, not
  excused, so a future reader finds no per-resource schema owned by 11.4.

### Amendment 6 (2026-08-05) — the WORK-LOOP resources: paths and verbs, scope mirroring, the job handle, and the three projections as §8 additions

**Amends:** §3 (which the shipped map, not this ADR, is the source of truth for —
stated explicitly here), §4's status vocabulary (which gains **202**), §7 (which
gains one reasoned singular-noun exception), and §8 (which gains three named
additions).
**Leaves unchanged:** §1, §2, §5, §6, §9 in full; Amendment 1's carve-out table;
Amendment 3's cursor, envelope and bounded-call rules; Amendment 4's emission
mechanics; Amendment 5's ownership walk.
**Card:** MOTIR-2235 (Subtask 11.7.1), for Story 11.7.

Stories 11.1–11.4 shipped a surface of plain CRUD on nouns, and §7's naming rules
covered every one of them without anyone having to think. Story 11.7's ten
operations are the first that are not: fetching an assembled prompt, recording an
integration, closing out a branch, submitting a job, holding a conversation
addressed by a set of anchors rather than an id. Each has two or three defensible
shapes, and settling them one card at a time would leave the surface with three
idioms for one kind of operation and nothing recording why.

All rung-2 evidence below was read on `origin/main` @ `b82ed141` and is cited by
path.

#### Q1 — a path and a verb for ten operations

| #   | Operation                         | Verb + path                                                   | Success |
| --- | --------------------------------- | ------------------------------------------------------------- | ------- |
| 1   | Dispatch prompt                   | `GET /api/v1/work-items/{key}/dispatch-prompt?sessionBranch=` | 200     |
| 2   | Record one item integrated        | `POST /api/v1/work-items/{key}/integration`                   | 200     |
| 3   | Close out a session branch        | `POST /api/v1/sessions/complete`                              | 200     |
| 4   | Submit an expansion               | `POST /api/v1/work-items/{key}/expansions`                    | **202** |
| 5   | Open / resume the planning thread | `POST /api/v1/projects/{projectKey}/plan-session`             | 200     |
| 6   | Append one turn                   | `POST /api/v1/projects/{projectKey}/plan-session/turns`       | 200     |
| 7   | Submit the accumulated thread     | `POST /api/v1/projects/{projectKey}/plan-session/submissions` | **202** |
| 8   | Read a plan's status              | `GET /api/v1/plans/{planId}/status`                           | 200     |
| 9   | Read a plan with its proposals    | `GET /api/v1/plans/{planId}`                                  | 200     |
| 10  | Read a work item's activity       | `GET /api/v1/work-items/{key}/activity?view=`                 | 200     |

Seven of those are the obvious shape and are recorded rather than argued. The
three that are not follow.

##### 1 · Dispatch prompt — a sub-resource GET

`GET /api/v1/work-items/{key}/dispatch-prompt`, `sessionBranch` as an optional
query parameter. **Rung 2:** `lib/mcp/tools/dispatchPrompt.ts` records that it
"does NOT claim the item and does NOT flip its status", and its own header calls
it "a read, not a write" — so it is a GET, and the resource it reads is the
prompt FOR that item.

`sessionBranch` is a query parameter and not a body field because a GET has no
body, and it is a genuine input to the read rather than a filter over it: it
seeds an unattended run's lineage and, per the shipped tool, "never overrides".

| Rejected                                         | Why                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/work-items/{key}/dispatch-prompts` | Reads as a creation; this creates nothing and must stay safe and cacheable-in-principle.                                                       |
| `GET /api/v1/work-items/{key}?include=prompt`    | Buries a large text payload inside the detail read every client already makes, and makes `sessionBranch` a parameter of an unrelated resource. |

##### 2 · Integration — a POST on a sub-resource, not a PATCH on the item

`POST /api/v1/work-items/{key}/integration`, body
`{ sessionBranch, implementationSource?, implementationHarness?, implementationModel? }`,
returning the updated work item. **Rung 2:** `workItemsService.markIntegrated`
"moves the item to `in_review` AND stamps its `session_branch` in ONE
transaction" (`lib/mcp/tools/markIntegrated.ts`), and the move is validated
against the workflow's legal transitions — an item that cannot reach `in_review`
raises `IllegalTransitionError` with the field untouched. That is a state
transition with a body, not a field edit.

| Rejected                                                        | Why                                                                                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH /api/v1/work-items/{key}` with `sessionBranch`           | A PATCH that also moves status would put a second status-writing path beside the shipped `POST …/transitions`, and the two could disagree about which transitions are legal. |
| `POST /api/v1/work-items/{key}/transitions` with a branch field | Overloads a shipped operation with a second meaning, which §8 forbids (re-purposing an existing contract).                                                                   |

##### 3 · Session close-out — the branch travels in the BODY

`POST /api/v1/sessions/complete`, body
`{ sessionBranch, implementationSource?, implementationHarness?, implementationModel? }`,
returning `{ sessionBranch, results: [{ key, outcome, reason }] }`.

**A session branch is a git ref and routinely contains `/`** (`subtask/MOTIR-…`),
which is why this is a decision and not a detail. It is settled as a body field
because a path segment cannot carry the value safely and the failure is not ours
to fix: a Next.js `[param]` segment does not match `/` at all, and `%2F` is
normalised by proxies and CDNs before a route ever sees it, so the escaping is
not under the server's control. A catch-all `[...sessionBranch]` would "work" and
make `refs/heads/x` and its encoded form two addresses for one ref.

**The literal `complete` sits where an id would, and that is deliberate: v1 does
not address a session by path, and reserves the segment.** There is no session
row — `session_branch` is a column on `work_item` — so `sessions` is a collection
with no members to address, and this amendment records that a future
`GET /api/v1/sessions/{id}` is not available. A bulk write addressed by its body
is already the shipped idiom: `POST /api/v1/projects/{projectKey}/backlog/work-items`
takes its keys the same way.

| Rejected                                         | Why                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/sessions/{sessionBranch}/complete` | The ref contains `/`; the encoding is normalised away by infrastructure between the client and the route, so correctness would depend on hops we do not control. |
| A catch-all `[...sessionBranch]` segment         | Makes one ref addressable two ways, and silently re-splits any branch name containing an encoded slash.                                                          |
| `POST /api/v1/session-completions`               | Invents a resource for a record that is never created or read; the operation closes work items, it does not persist a completion.                                |

##### 5–7 · The planning conversation — SINGULAR, and addressed by scope

`plan-session` is **deliberately singular**, and it is the one exception to §7's
plural-nouns rule that this ADR grants. **Rung 2:** the thread's identity is
`(project, anchor set)` — `@@unique([projectId, scopeKey])` — and
`lib/mcp/tools/planSession.ts` records the contract in as many words: "ONE THREAD
PER SCOPE, ADDRESSED BY SCOPE … NOT a client-held session id", so that a CLI
"cannot desynchronise from it or fork a second conversation about the same
items". A plural noun invites `/plan-sessions/{id}`, which is exactly the
addressing the contract exists to make impossible. The singular is the API
telling the truth about the resource.

**The anchor set travels in the BODY on all three operations**, as an optional
`targetKeys: string[]` (bounded by the shipped `MAX_SCOPE_TARGETS`; omitted means
the project-wide thread). It is a SET whose order and duplicates do not matter,
which a repeated query parameter would encode as a list, and all three operations
are POSTs that already carry a body.

**Open/resume is a POST returning 200, not a GET and not a 201.** It is a POST
because get-or-create writes an empty row, and GET must stay safe. It is 200
because the caller cannot tell an open from a resume and a 201 would be a lie
half the time — `runOpenPlanSession` itself chooses between "Opened" and
"Resumed" only after the service answers.

| Rejected                                            | Why                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET …/plan-session?targetKeys=A,B` for open/resume | A GET that creates a row is not safe; the write is small but real, and a cache or a prefetch would perform it.                             |
| `POST /api/v1/plan-sessions/{sessionId}/turns`      | Hands the client an id to hold, which is precisely how a second conversation about one anchor set gets forked.                             |
| `targetKeys` as a repeated query parameter          | Encodes a set as an ordered list, so two spellings of the same thread would look different at the edge before the service normalises them. |

##### 8–9 · Plan reads — status is a SUB-RESOURCE, and the plan id is the only address

`GET /api/v1/plans/{planId}` returns the plan with its proposals
(`plansService.getPlan` → `PlanWithItemsDto`).
`GET /api/v1/plans/{planId}/status` returns the outcome
(`aiPlanEditsService.getOutcome` → `PlanOutcomeDto`).

**Status is a sub-resource rather than a field because it is a different read
against a different source.** `getOutcome` reaches motir-ai for the JOB's
liveness — a job can die and leave its plan `generating` forever, which the plan
row alone cannot report — so folding it into the plan would make one endpoint's
latency and failure modes depend on a cross-service call a client asking only for
proposals never wanted.

**v1 addresses a plan by `planId` only; the MCP tool's `jobId` alternative is not
mirrored.** Every v1 operation that starts a job returns BOTH ids in its handle
(Q3), so a v1 client that holds a job id holds a plan id. This is a narrower
ADDRESS, not a narrower capability, and adding the job address later is additive
under §8.

| Rejected                                            | Why                                                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status` as a field on `GET /api/v1/plans/{planId}` | Makes every proposal read pay for a cross-service job probe, and couples a pure read's failure modes to motir-ai's availability.                      |
| Mirroring the `planId`-xor-`jobId` addressing       | Two path shapes for one read, plus a "pass exactly one" 422 that no v1 client can reach, for an id that is the primary key of nothing a client reads. |

##### 10 · Activity — a view parameter, and `…/comments` STAYS

`GET /api/v1/work-items/{key}/activity?view=all|comments|history`, with
`order` and the standard `cursor` / `limit`. **The shipped
`GET /api/v1/work-items/{key}/comments` is not withdrawn, folded, or
deprecated** — it is public API under §8 and could not be, and it remains the
canonical address for the discussion. `?view=comments` exists so a client that
walks all three views does it with one code path, and both read the same
`commentsService.listComments`, so they cannot disagree.

**The cursor is v1's own, scoped to the activity collection.** All three views
share one cursor family (`encodeCollectionCursor('workItemActivity', …)`) wrapping
whatever position the underlying service issued — including the `all` view's
OPAQUE COMPOSITE over both sources, which the route must never construct, parse
or merge (`lib/mcp/tools/getWorkItemActivity.ts` records the same rule for the
MCP transport). A cursor from `…/comments`, or from any other collection, is a
422 under §5 rather than a silent reset. `V1_COLLECTIONS` gains
`workItemActivity`, which is additive.

**A SHORT page with a non-null cursor is normal here** for `all` and `history`
(the bounded noise scan) and for `comments` (a root comment drags its whole reply
thread), so a client walks until `nextCursor` is null — never until a page is
short. The shipped `…/comments` route already carries that note.

| Rejected                                                  | Why                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Three endpoints (`…/activity`, `…/history`, `…/comments`) | The `all` view is a merged stream over both sources, so it would need a fourth path anyway; one parameterised read matches the one service adapter and the product's own three tabs. |
| Making `…/comments` a redirect to `?view=comments`        | Changes the response of a shipped endpoint, which §8 forbids, for no gain a client can use.                                                                                          |
| Passing the service's own `all` cursor through unwrapped  | It is neither signed nor collection-scoped, so a cursor from another collection would decode into a meaningless position instead of a 422.                                           |

#### Q2 — scopes MIRROR `lib/mcp/scopes.ts`; the map is the source, this table is derived

**The decision is to mirror, and the principle is: one capability model, two
transports.** A token granting `read` must mean the same thing whichever door it
arrives at. Inventing a v1-only mapping would make a scope's meaning depend on
transport, which is the drift this epic exists to end.

**Verified, not remembered.** `lib/mcp/scopes.ts` was read on `origin/main` @
`b82ed141`: `TOOL_SCOPES` is typed `Record<McpToolName, TokenScope>` — total by
construction — and carries a reasoned comment per entry. The derived table:

| v1 operation                      | MCP tool mirrored        | Scope              | The map's own reasoning                                                                              |
| --------------------------------- | ------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `GET …/dispatch-prompt`           | `dispatch_prompt`        | `read`             | "only READS the item and assembles text — it never claims it or flips its status"                    |
| `GET /plans/{planId}`             | `get_plan`               | `read`             | "a proposal is not a work item, and approving the plan … does not happen on this surface at all"     |
| `GET /plans/{planId}/status`      | `get_plan_status`        | `read`             | "neither submits a job nor spends a credit"                                                          |
| `POST …/plan-session`             | `open_plan_session`      | `read`             | "idempotent, spends no credit, opens no Plan … Opening the door is not starting a conversation"      |
| `GET …/activity`                  | `get_work_item_activity` | `read`             | "a pure paged read … `add_comment` is the write, this is not"                                        |
| `POST …/expansions`               | `expand_item`            | `work_items:write` | "the narrowest shipped scope that admits a plan-mutating, billable submit"                           |
| `POST …/plan-session/turns`       | `append_plan_turn`       | `work_items:write` | same reasoning, stated at the entry                                                                  |
| `POST …/plan-session/submissions` | `submit_plan_session`    | `work_items:write` | same reasoning, stated at the entry                                                                  |
| `POST …/integration`              | `mark_integrated`        | `integration`      | the scope's own definition: "External-agent integration writes — mark-integrated / complete-session" |
| `POST /sessions/complete`         | `complete_session`       | `integration`      | as above                                                                                             |

Two consequences worth stating, because both look like contradictions and are not:

- **A `read`-scoped POST is correct.** §3's table reads "Any `GET` → `read`",
  which maps the CRUD surface it was written for; it does not say only a GET may
  be `read`-scoped. The scope mirrors the CAPABILITY, and v1 never derives one
  from an HTTP verb. `POST …/plan-session` is the case: it writes an empty row
  and grants nothing a read does not already grant.
- **`expand_item` is NOT `integration`, and that was already decided.** The map
  considered the credit-spending argument and chose `work_items:write` as the
  narrowest scope admitting a billable submit. An earlier draft of Story 11.7
  guessed otherwise; the map wins.

**If mirroring is ever wrong for one operation, the remedy is an amendment to the
SHARED map with its reasoning updated — never a v1-only divergence.** §3 already
says a capability the shipped set lacks is "a separate card against
`lib/mcp/scopes.ts` — flagged, not invented at the route"; this extends the same
rule to a mapping believed wrong.

#### Q3 — a job-submitting endpoint publishes "accepted", and cannot publish a result

`POST …/expansions` and `POST …/plan-session/submissions` both return the moment
motir-ai accepts the job. Nothing has been planned; what eventually appears is a
Plan of PROPOSALS that only a human approving in Motir turns into work items.

**The status is 202 Accepted**, added to §4's vocabulary by this amendment
(`V1_SUCCESS_STATUSES` gains `202`). This is a NEW condition getting a status,
which §8 permits and which 409 and 412 already arrived by (Subtasks 11.2.9 and
11.2.6). 200 is rejected: it is the status every finished read and write on this
API returns, so it would make "the work is done" and "the work has not started"
indistinguishable at the only layer a generic client inspects.

**The body is one shared handle schema, and it is CLOSED:**

```
{ jobId: string, planId: string, statusUrl: string }
```

`statusUrl` is the relative path `/api/v1/plans/{planId}/status` — relative
because the server behind a proxy cannot know its own public origin, and present
so a client polls an address it was given rather than one it assembles.

**How the SCHEMA — not its description — prevents the mistake: there is no field
a result could arrive in.** No `items`, no `proposals`, no `count`, no `status`.
A client cannot read an outcome out of this shape at all; it can only read where
to come back. That is stronger than a `status: "accepted"` literal, which is a
label a reader can skim past and which would sit confusingly beside the PLAN's
own status vocabulary (`generating` / `planned` / `approved` / `declined`).

The plan reads carry the other half: `GET /plans/{planId}` returns proposals, and
its schema names them proposals — an `add`'s `workItemId` is `null` until the
plan is approved, and that nullability is part of the published contract rather
than a footnote.

| Rejected                                   | Why                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200 with the handle                        | Indistinguishable from a completed write at the status layer, which is the one layer generic clients and proxies read.                            |
| 202 with `proposals: []`                   | An empty array reads as "zero results", which is a stronger and wronger claim than "not yet".                                                     |
| 202 with `status: "accepted"`              | A skimmable label rather than a structural guarantee, and it collides with the plan's own `status` vocabulary.                                    |
| A `Location` header instead of `statusUrl` | Conventionally names a created resource; the plan is not created-and-ready, and a header is invisible to the JSON-shaped clients this API is for. |

#### Q4 — the three field projections are §8 ADDITIONS

Story 11.7 widens three shipped, published response schemas. §8 permits "a new
field on a response object" within a major, so all three are allowed — recorded
explicitly because "we added a field to a published response" is exactly the
sentence a future reader will want to find a decision behind.

| #   | Schema                              | Added                                     | Form                          |
| --- | ----------------------------------- | ----------------------------------------- | ----------------------------- |
| 1   | `workItemDetailSchema.children[]`   | `dependencies: { blockedBy[], blocks[] }` | bounded page-level projection |
| 2   | `workItemSummarySchema`             | `dependencies: { blockedBy[], blocks[] }` | bounded page-level projection |
| 3   | `readinessSchema.blockedByAncestor` | the ancestor's `title` beside its key     | pure widening, no new read    |

**1 and 2 use the bounded-projection form Amendment 3 Q4 permits**, and it is
already shipped: `app/api/v1/projects/{projectKey}/ready/route.ts` calls
`workItemsService.getDependencyEdgesForItems(ids)` once for the whole page, and
`readyItemSchema` already carries the identical `dependencies` block. So this is
the same projection applied to two more collections, not a new mechanism. **The
ceiling is CONSTANT, never per-row** — one batched call for a page of any size,
which is why that service method takes an id array.

**3 is a pure widening of data the route already holds.** `lib/dto/workItems.ts`
carries `blockedByAncestor: WorkItemSummaryDto | null`; `lib/api/v1/workItems/schema.ts`
narrows it to `?.identifier ?? null` at the mapper. Restoring the title reads
nothing new — it stops discarding a field the DTO in hand already carries.

**All three keep the shape TOTAL.** A row with no edges gets two EMPTY arrays,
never a missing key, so a typed client never branches on presence — the property
`readyItemSchema`'s own comment records and the reason it is worth copying.

| Rejected                          | Why                                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `?include=dependencies` opt-in  | A second shape for one resource, and every client would have to learn which endpoints honour it; the projection is one batched call, so there is nothing to opt out of. |
| A per-row edge read               | An N+1 invisible until a 100-row page — forbidden by Amendment 3 Q4 however thin each call is.                                                                          |
| Widening the service DTOs instead | Ships an edge payload to every product surface that does not consume it, which Amendment 3 Q1 already rejected in the other direction.                                  |
| Leaving the ancestor's key alone  | The CLI's `renderReadinessLine` prints `blocked by ancestor <key> — <title>`, so the shipped renderer would silently lose half its line the moment it speaks v1.        |

#### Consequences of this amendment

- **Ten operations have a pinned path, verb, scope and success status** — the six
  code cards behind this decision are adapters, not designers.
- **§4's success vocabulary gains 202**, and the card that first declares a 202
  operation (11.7.5, MOTIR-2239, or 11.7.6, MOTIR-2240 — whichever lands first)
  adds it to `V1_SUCCESS_STATUSES` and `V1_STATUS_DESCRIPTIONS`. This is a
  one-line extension of a shared 11.4-owned module, in the same way Subtasks
  11.2.6 and 11.2.9 added 412 and 409.
- **§7 gains one reasoned exception** — `plan-session`, singular, because the
  resource genuinely has one member per scope and is never addressed by id.
- **`sessions/{id}` is reserved and unavailable**; `POST /api/v1/sessions/complete`
  owns the segment.
- **`V1_COLLECTIONS` gains `workItemActivity`**, so the activity cursor is
  refused at every other collection and vice versa.
- **The three projections are §8-permitted additions**, with the bounded form
  named, so no client breaks and no reviewer has to re-derive the permission.
- **The MCP surface is untouched.** No tool is re-pointed, re-shaped, renamed or
  deprecated by anything decided here; `lib/mcp/` was read as the reference for
  argument shapes and semantics and left exactly as it is.

### Amendment 7 (2026-08-06) — the MCP surface DERIVES its payloads from the v1 resource schemas; the no-`outputSchema` decision is overturned

**Amends:** Amendment 2's corollary, which gains a second consumer — the shared
response schemas are now imported by `lib/mcp/` as well as by the v1 routes; and
Amendment 4 Q1's zod boundary, whose enumerated file set was v1-only and now has a
stated rule for `lib/mcp/`.
**Overturns:** the header comment in `lib/mcp/toolResult.ts` (Story 7.8 · 7.8.4),
quoted in full below.
**Leaves unchanged:** §1–§9 in full; Amendment 1's carve-out; Amendment 3's cursor,
envelope and bounded-call rules; Amendment 4's emission mechanism and published
reference; Amendment 5's ownership walk; Amendment 6 in full. **No `/api/v1` shape,
path, scope or status changes here.**
**Card:** MOTIR-2227 (Subtask 11.6.1), under Story 11.6 (MOTIR-1856).

#### The problem

Motir has two programmatic descriptions of one domain. They answer to opposite
pressures — the MCP tool surface _should_ churn, because rewording a description or
renaming an argument is how an agent's behaviour is tuned; `/api/v1` _must not_,
because published clients break. Both are correct, and neither is the problem.

The problem is that they can differ **about the same fact**, silently. That has
already happened once: `list_ready` and `search_work_items` attached a
`dependencies` block to their rows and `get_work_item` did not, so a card was
planned on the assumption all three agreed and nothing discovered otherwise until
someone tried to build it (MOTIR-1849). Nobody made a mistake at any single point.
Each tool was hand-shaped correctly in isolation, and there was **no place where
the two shapes were compared**. `lib/mcp/dependencyEdges.ts` still carries the
codebase's own cheerful record of it — a comment describing "ONE seam, TWO tools"
as though two of three were the design.

This amendment makes that comparison a build step.

---

#### Q1 — the recorded decision this overturns, and the position on `outputSchema`

##### What is being overturned, quoted

`lib/mcp/toolResult.ts` has said, since Story 7.8 · Subtask 7.8.4:

> "We deliberately do NOT declare an `outputSchema` on the tools, so
> `structuredContent` is free-form DTO JSON — **the route layer ships these exact
> DTOs already**; re-deriving a zod mirror of every DTO would be duplicate surface
> for no gain."

**That was true when it was written, and one of its premises died on 2026-08-03.**
When 7.8 wrote it the only routes were the internal cookie-authenticated ones, and
those do pass DTOs through — so "the route layer ships these exact DTOs already"
was a plain description of the codebase. **Amendment 2** then pinned that _a v1
response is a v1 schema's output, never a service DTO passed through_, and
11.2/11.3 shipped exactly that. The premise is now false, and with it the
conclusion: there is a second consumer of the shape, it is versioned, and a
"duplicate surface" that two surfaces are checked against is not duplicate — it is
the only place they meet.

The comment is rewritten in the file by this card, dated, and noting that the old
reasoning was sound under 7.8's premises. **An overturn that does not name what it
overturns is how the next reader re-adopts the old reasoning**, which is exactly
what would have happened here: an agent opening `toolResult.ts` to do Story 11.6's
work would have found a confident, well-argued paragraph telling it not to.

##### The decision: DERIVE internally; do NOT declare `outputSchema`

The tools derive `structuredContent` from the shared schemas. They do **not** pass
those schemas to the SDK's `outputSchema` affordance. Rung 2, read from the
installed SDK (`@modelcontextprotocol/sdk@1.26.0`) rather than assumed — declaring
one has two runtime consequences, both of which this story's own criteria forbid:

1. **It is PUBLISHED in `tools/list`.** `server/mcp.js:88–91` emits
   `toolDefinition.outputSchema` for any tool that declares one. Story 11.6's
   criteria require `tools/list` output to be untouched, and more fundamentally the
   whole architecture rests on the tool surface staying free to churn. Declaring the
   shape would convert every additive widening into a published-contract change —
   importing v1's stability constraint onto the surface that exists precisely to not
   have it.
2. **The SDK VALIDATES against it and THROWS.** `validateToolOutput`
   (`server/mcp.js:185–207`) `safeParse`s `structuredContent` and raises an
   `McpError` on mismatch. That converts a shape defect into a **runtime failure in
   front of an agent**, at request time, in production — strictly worse than the
   same defect failing a CI guard at build time. We want the drift to be a red
   build, not a red tool call.

There is a third, smaller reason: `outputSchema` is typed `ZodRawShapeCompat |
AnySchema` against the SDK's own zod integration, so feeding it a `zod/v4` schema
would push the version boundary of Q3 into the tool-registration path — the one
place in `lib/mcp` where the classic entrypoint is genuinely load-bearing (every
tool's `inputSchema` is a classic `ZodRawShape`).

**The guarantee comes from derivation plus the CI guard, not from advertising.**
Publishing the output shape to agents is a real and arguable product feature; it is
simply a different decision, with a different consumer, and it can be taken later
without re-opening this one.

| Rejected                                   | Why                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Declare `outputSchema` on every tool**   | Publishes the shape in `tools/list` (a caller-visible change 11.6 forbids) and turns a drift into a production `McpError` instead of a red build. The benefit — agents see the shape — is real but is a separate product call. |
| **Keep the 7.8 comment and derive anyway** | Leaves a confident, well-argued paragraph in the file arguing against what the file now does. The most reliable way to lose a decision is to leave its expiry invisible.                                                       |
| **Delete the comment**                     | Loses the record that the old reasoning was correct under its own premises, which is the part that tells a future reader whether this was a correction or a reversal of taste.                                                 |

---

#### Q2 — where the shared schemas live: `lib/api/v1/**`, unmoved, and `TOKEN_SCOPES` stays put

##### The decision — option (a)

**Both surfaces import the response schemas from `lib/api/v1/<resource>/schema.ts`,
exactly where Amendments 2 and 5 put them. Nothing hoists, and `TOKEN_SCOPES` stays
in `lib/mcp/scopes.ts`.** The version in the path is INFORMATION, not debt.

The worry the question raises is real — `lib/api/v1/**` becomes a shared kernel with
a version-specific name. The answer is that the name is _accurate_. These are the
**v1** shapes; MCP deriving from them means MCP tracks v1. When `/api/v2` arrives,
"which version does the MCP surface track?" becomes a live question, and the best
possible place for its answer is the import statement in every file that depends on
it — not hidden behind a neutral alias that makes the coupling invisible at exactly
the moment someone needs to see it.

**The asymmetry is accepted and documented rather than fixed.** `lib/mcp/scopes.ts`
owns `TOKEN_SCOPES`, and `lib/api/v1/route.ts`, `openapi/security.ts` and
`openapi/operation.ts` already import it (three shipped sites, verified on
`origin/main`). After this amendment the dependency runs both ways: v1 imports MCP's
capability model, MCP imports v1's response shapes. That is not a cycle in any
meaningful sense — they are disjoint concerns, each owned where it originated, each
imported by the other surface that needs it — and it is the honest description of
two adapters over one set of services.

**Nothing in the shipped guards forbids this direction.** `tests/helpers/v1RouteAudit.ts`
carries an `imports-mcp-tools` rule, and its own detail string is an endorsement:
_"a v1 route imports from `lib/mcp/tools` — the two surfaces align through schemas."_
It constrains **routes → tools**, which stays forbidden. `lib/mcp` →
`lib/api/v1/*/schema.ts` is the direction that sentence was written to recommend.

| Rejected                                                             | Why                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(b) Hoist the schemas to a neutral home; `lib/api/v1` re-exports** | An indirection that hides which version MCP tracks, at the cost of touching ~20 modules and every import site for zero behaviour change. It makes the v2 question harder to see, not easier.                   |
| **(c) Hoist the schemas AND `TOKEN_SCOPES`**                         | Symmetry for its own sake, across two surfaces, in the same PR as a 30-tool payload migration. It also relocates the capability model away from the surface that originated it, making its owner _less_ clear. |
| **Copy the shapes into `lib/mcp`**                                   | Two declarations of one shape is the defect this story exists to remove, re-introduced as its implementation.                                                                                                  |

---

#### Q3 — the zod v3 → v4 boundary, now stated for `lib/mcp/`

Amendment 4 Q1 established the rule and enumerated it for the eight v1 files it
touched. **The rule is unchanged; this states it for the directory that amendment
did not reach.** Zod 3 and Zod 4 instances do not interoperate, so the line is a
correctness boundary, not tidiness: a module on the wrong side does not misbehave,
it fails to compile.

**The operational line:**

- A module that **COMPOSES** a v1 schema — wraps it, `.extend`s, `.pick`s or
  `.omit`s it, or declares a type against it ⇒ imports **`zod/v4`**, and never both
  entrypoints in one file.
- A module that **only CALLS** `.parse` / `.safeParse` on one, or only calls a
  `present*` mapper, ⇒ **unchanged**, stays on classic `zod`.
- **Every tool's `inputSchema` stays classic `zod`.** They are `ZodRawShape`s handed
  to `server.registerTool`, they compose no response schema, and they are the
  prompt-engineering surface Story 11.6 leaves free.

**Verified on `origin/main` @ `6d472611`** — `lib/mcp/**` is 100% classic zod today:
25 import sites, **zero** `zod/v4`. `lib/api/v1/**` is the mirror: 18 sites, all
`zod/v4`.

**The crossing set is kept to the seam, deliberately.** Because composition is
confined to the derivation modules Subtask 11.6.2 introduces (`lib/mcp/payloads/**`)
and the per-family payload schemas that extend them, **no existing
`lib/mcp/tools/*.ts` file crosses**: a tool imports a `present*` mapper or a declared
payload schema and calls it, which is the "only calls" arm. That is what makes _"no
file imports both `zod` and `zod/v4`"_ trivially true rather than a property someone
has to maintain — the files that compose v4 declare no input schemas, and the files
that declare input schemas compose nothing. A tool that ever needs both is the
signal to extract the composition into the seam, not to import twice.

The property is asserted over the tree by Subtask 11.6.7 rather than reasoned about
per file.

---

#### Q4 — what makes coverage TOTAL: a branded payload, checked at the `toolOk` chokepoint

##### The luck this exploits

`toolOk(text, structuredContent: Record<string, unknown>)` is a single chokepoint:
**33 of the 37 modules in `lib/mcp/tools/` return through it.** The four that do not
are `listSprints.ts` — the one real tool outside it — plus three non-tool helpers
(`readyFilters.ts`, `sprintRef.ts`, `workItemRef.ts`). That means "every tool derives
its payload from a declared schema" can be a **type error** rather than a review
habit, which is the same guarantee `TOOL_SCOPES: Record<McpToolName, TokenScope>`
already gives the scope model.

##### The decision — `toolOk` takes a BRANDED payload with exactly two constructors

`toolOk`'s second parameter changes from `Record<string, unknown>` to an opaque
branded type. A value of that type cannot be written literally; it has exactly two
constructors, and every tool must reach one of them:

1. **`derived(schema, value)`** — validates `value` against a **declared shared
   schema** (a v1 resource schema, or a declared narrowing/widening of one per Q6)
   and brands the result.
2. **`exempt(toolName, value)`** — brands a value for a tool whose payload has no
   shared schema to derive from. Its parameter is typed to the **exemption
   registry's** key union, so passing a non-exempt tool name is a compile error.

A tool that is neither derived nor registered as exempt therefore **cannot construct
an argument for `toolOk` at all**. That is the totality property, and it is proven
the way the scope model's is — with `@ts-expect-error` compile-failure fixtures
(Subtask 11.6.2), not by inspection.

**`listSprints.ts` comes through `toolOk`** rather than receiving an exemption. It is
the single tool the mechanism would otherwise not see, and a mechanism with one
invisible member is not a mechanism. Its payload is a sprint collection, which has a
v1 counterpart (`Sprint`), so there is nothing to exempt it for; it is outside the
helper for historical reasons only. Subtask 11.6.4 lands it with its family.

##### The shared-resource set is DERIVED, never listed

The set of "resources exposed by BOTH surfaces" is computed from
**`V1_RESOURCE_COMPONENTS`** in `lib/api/v1/openapi/registry.ts` — the merged
component map, itself assembled from the per-resource `operations.ts` modules
(`WORK_ITEM_COMPONENTS`, `PLANNING_COMPONENTS`, `WORK_LOOP_COMPONENTS`; 20 named
schemas today). A resource added later joins the guard's scope when it is registered
for the OpenAPI document, with no second list to remember.

That is deliberate reuse of the value Amendment 4 Q2 already created: the registry
exists so exactly one value knows the whole set, and a hand-written mirror of it in
`lib/mcp` would be the story's own defect one level up — **a guard that reports
success over a set nobody defined.**

| Rejected                                                         | Why                                                                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A `Record<McpToolName, Schema>` map, mirroring `TOOL_SCOPES`** | Total over TOOLS but says nothing about whether the payload a tool actually returns went through its schema — the map would be satisfied by a tool that declares one and ignores it.    |
| **A runtime-only test that walks the registry**                  | Catches it one layer too late and only for tools a test exercises. 11.6.7 ships that walk too, as the belt to this braces — but the compile error is what stops the code being written. |
| **Leave `listSprints.ts` outside and exempt it**                 | Exempts the one tool the mechanism cannot see, which is precisely the shape of the defect the story exists to remove.                                                                   |
| **Hand-list the shared resources in `lib/mcp`**                  | A guard whose coverage is a list someone maintains reports success while the newest resource drifts.                                                                                    |

---

#### Q5 — the exemption list, and how a tool joins it

**An exemption means one thing and nothing else: _this tool's payload has no shared
resource schema to derive from, because no v1 operation returns that resource._** It
is not "we didn't get to it", and it is not a per-tool opt-out.

Each entry carries a `reason` string in the typed registry (Subtask 11.6.2), so the
table below is executable rather than prose:

| Exempt tool          | Reason                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate_work_item` | Returns a subtree FINISHABILITY verdict (`valid`, `blockers`, `advisories`) — a planning judgement, not a resource. No v1 operation exposes it (Amendment 6's boundary).   |
| `validate_sprint`    | Same verdict shape over a sprint's membership. Same boundary, same reason.                                                                                                 |
| `get_project_state`  | Reports a project's PLANNING PRECONDITIONS (established?, code connected + indexed?, onboarding run) — an agent-facing readiness report with no REST client asking for it. |

**`claim_next_ready` is NOT exempt**, correcting the four-tool set Story 11.6 and
Amendment 6's boundary both name. Those are lists of tools with no v1 **endpoint**,
which is the right list for a different question. `claim_next_ready` has no endpoint
and still returns a **work-item row plus advisories** — both shared shapes — so it
derives like the rest of its family (Subtask 11.6.3). Exemption tracks the RESOURCE,
not the endpoint; a tool can be MCP-only and still return something v1 describes.

**The rule for joining the list:** a new tool is derived by default, because
`toolOk` will not accept it otherwise. Adding an exemption is an explicit edit to the
registry with a reason string, in the same PR as the tool. **Subtask 11.6.5 SEALS
the list against `lib/mcp/registry.ts`** — walking the registered tool names and
asserting every one resolves to derived-or-exempt, so a tool in neither column fails
the run rather than being skipped. The three above are the expectation the seal is
checked against; the registry is the authority.

---

#### Q6 — the derivation DIRECTION: narrowing, widening, and the envelope (added by this card)

##### Why this question is here

Q4 pins the mechanism and presupposes an answer to this; without it, "derive from
the shared schema" has two readings that build different software, and Story 11.6's
own criteria pull in both directions. **Rung 2, comparing the shipped surfaces
rather than assuming they nearly agree** — they do not:

| Resource           | MCP emits today                                                                                                                                                                      | `/api/v1` emits today                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ready row          | `{ id, key, kind, title, priority, status{}, assignee{ id,name,avatarUrl }                                                                                                           | null, …, dependencies }`                                    | `{ key, kind, title, priority, status{}, type, executor, assigneeId, descriptionExcerpt, dependencies }` |
| integration result | `WorkItemDto` — `identifier`, no `key`                                                                                                                                               | `{ key, status, sessionBranch, updatedAt, …provenance }`    |
| work-item detail   | the `IssueDetailDto` AGGREGATE — `{ item{}, ancestors, parent, children, blockedBy, blocks, relatesTo, duplicates, clones, readiness, workflow, watcherCount, viewerIsWatching, … }` | FLAT — `{ key, kind, …, children[], links{}, readiness{} }` |

Neither side is a subset of the other. MCP carries `id`, an `assignee` object and a
`workflow` block that v1 deliberately omits; v1 carries `assigneeId` and `key` where
MCP says `assignee` and `identifier`. So a literal "the two payloads validate against
one schema" is unreachable without breaking every shipped MCP consumer, and a literal
"no payload changes" is unreachable without the guard being vacuous.

##### The decision — three rules, in this order

**1. A payload's resource-valued parts are the SHARED schema's output.** Every field
a v1 resource schema declares appears in the MCP payload under the **same key with
the same value**, produced by the same `present*` mapper the route calls. This is the
half that makes the guard real: because a `zod` object strips unknown keys rather
than rejecting them, an MCP payload that satisfies this rule **validates against the
v1 schema unchanged**, and a field added on one surface and forgotten on the other
fails that parse.

**2. Agent-only extras are a DECLARED WIDENING; agent-only omissions are a DECLARED
NARROWING.** A tool that carries more than v1 does declares
`sharedSchema.extend({ … })`; a tool that wants less declares `.pick`/`.omit`. Both
are derivations, so a change to the base breaks them loudly. What is forbidden is the
third thing — an independently-authored object that happens to resemble the schema
and goes on compiling while quietly meaning something else. **Those two look
identical in a diff and are opposite in kind**, and telling them apart is the entire
point.

**3. The ENVELOPE stays MCP's own.** `{ items, nextCursor }`, the detail aggregate's
`{ item, parent, children, … }`, a claim result's `{ item, advisories }` — the
container a tool wraps its resources in is transport shape, not resource shape, and
it is shaped for how an agent reads a result. The guard walks the **resource-valued
members** of a payload, not its envelope.

##### What this means concretely, and what it costs

Payload changes are **additive only**: `list_ready` rows gain `assigneeId` beside
`assignee`; `mark_integrated` gains `key` beside `identifier`. Nothing is removed and
nothing is renamed, so no shipped consumer — including `@motir/cli` — breaks, and
Story 11.6's promise that a caller sees no behaviour change holds in the sense that
matters: **the surface only ever grows.**

**The honest cost, stated rather than discovered:** an existing MCP suite that asserts
a WHOLE payload with `toEqual` will fail on the added field, and there is at least one
(`tests/mcp/integration-state.test.ts:176`,
`expect(result).toEqual({ sessionBranch: …, results: [] })`). Story 11.6's family
cards ask for their suites to pass **unmodified**, and that instruction is exactly
right about what it is protecting — freezing the expectations is what turns a silent
behaviour change into a visible act. So the rule is:

> **A REMOVED or RENAMED key, or a changed VALUE, is a violation — fix the code.
> A whole-payload `toEqual` that fails only because a v1 field was ADDED beside the
> existing ones is the one edit those cards permit, and it must be justified in the
> PR body by naming the added field.** Any other edit to an expected payload is the
> tell those cards were written to catch.

| Rejected                                                                  | Why                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Replace each MCP payload with the v1 shape outright**                   | Renames `identifier`→`key`, drops `id`, `assignee`, `workflow`, `viewerIsWatching`, and flattens the detail aggregate. It breaks every shipped MCP consumer and `@motir/cli`, to buy a guarantee the additive form already gives.     |
| **Change nothing; have the guard compare only fields that already agree** | A guard that checks the subset both surfaces already got right is green by construction on the day it ships and blind to exactly the drift it exists to catch. A partial drift guard is worse than none, because it is read as total. |
| **Make the envelopes match too**                                          | Forces `{ items, nextCursor }` and the detail aggregate into v1's envelope for no consumer's benefit, and makes agent-facing result shape — genuinely MCP's own — a versioned contract.                                               |
| **Declare the MCP payloads as v1 §8 additions and widen the v1 schemas**  | Makes `id` and the `assignee` object public API forever because an agent surface wanted them. §8 is additive-only, so the mistake would be permanent.                                                                                 |

---

#### Consequences of this amendment

- **`lib/mcp/toolResult.ts`'s header comment is rewritten** by this card, dated, and
  naming the premise that died and when. No other code changes here.
- **The shared response schemas stay in `lib/api/v1/**`** and gain a second importer.
`TOKEN_SCOPES`stays in`lib/mcp/scopes.ts`; the two-way dependency is accepted and
  recorded above.
- **`lib/mcp/payloads/**`(11.6.2) is the only part of`lib/mcp`on`zod/v4`.** No
`lib/mcp/tools/\*.ts` file crosses, and no file imports both entrypoints — asserted
  over the tree by 11.6.7.
- **`toolOk` gates totality** — derived-or-exempt, or it does not compile.
- **The exempt set is expected to be three** (`validate_work_item`, `validate_sprint`,
  `get_project_state`), **not the four** Story 11.6 and Amendment 6 name;
  `claim_next_ready` derives. 11.6.5 seals it against `lib/mcp/registry.ts`.
- **MCP payloads grow, never shrink or rename** — the additive rule of Q6, which is
  what lets the drift guard be total without breaking a caller.
- **No `/api/v1` shape changes.** If the alignment shows a v1 schema is wrong, that is
  a card against the owning story (Amendment 5 §3's standing procedure), never a
  widening made at the MCP end to make both sides fit.

##### Q6 addendum (same card) — the `key` COLLISION, found while building 11.6.2

Q6's additive rule has exactly one case it cannot cover, and it is on the most
important resource. **`key` already means two different things, and one of them is
inside the MCP surface itself:**

| Surface / row                                                              | `key` is…                     |
| -------------------------------------------------------------------------- | ----------------------------- |
| `/api/v1` — every resource (`workItemKeySchema`, `/^[A-Z][A-Z0-9]*-\d+$/`) | the `PROD-<n>` **identifier** |
| MCP `list_ready` / `next_ready` rows (`ReadyItemDto.key`)                  | the `PROD-<n>` **identifier** |
| MCP `search_work_items` rows (`WorkItemListItemDto.key`)                   | the **numeric** key           |
| MCP `get_work_item` children (`WorkItemSummaryDto.key`)                    | the **numeric** key           |

Observed live, not inferred: a `get_work_item` call on `MOTIR-1856` returns children
as `{"key":2227,"identifier":"MOTIR-2227", …}`.

**This is the founding defect's twin, and nobody had found it.** `list_ready` and
`search_work_items` were made to agree about `dependencies` (MOTIR-1842) and left
disagreeing about what `key` MEANS — the same two tools, the same kind of silent
divergence, discovered here only because something finally compared them.

**There is no additive fix.** You cannot add `key: "MOTIR-2227"` to a row that
already has `key: 2227`. So Q6's "additive only" rule has to yield here, and the
choice is which way.

**Decision: on the MCP surface, `key` becomes the `PROD-<n>` identifier
everywhere, and the numeric key is preserved as `numericKey`.**

- It makes `key` mean ONE thing across both surfaces and, for the first time,
  across MCP's own tools — which is the story's entire purpose, applied to the
  field the story is addressed by.
- It aligns the work-item rows with MCP's OWN ready rows, which already say
  identifier. The inconsistent tools are the minority.
- Nothing is lost: the numeric key stays, renamed to what it is.
- **Blast radius, by grep rather than assumption:** `@motir/cli` never reads a
  numeric key (`grep -rn "key: number" packages/cli/src/` → no matches; its
  renderers read `identifier`). The only consumer is `tests/mcp/search.test.ts`,
  which casts `items: { key: number }[]` at three sites and compares the MCP page
  to the internal URL route's page.

**This is the one payload change in Story 11.6 that is not additive**, it is named
here, and the test edit it forces is named on the cards (MOTIR-2228, MOTIR-2229) so
it cannot be mistaken for the sloppiness those cards froze their suites against.
A planning bug records why the criterion could not hold as written.

| Rejected                                                       | Why                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Keep `key` numeric on MCP; probe a narrowing that omits it** | Removes the identifying field from the guard on the resource the story exists for, and leaves `key` meaning two things inside one surface — the exact defect, preserved. |
| **Rename the REST field instead**                              | `/api/v1` is published and §8 is additive-only. The stable surface is the one that must not move; that is the whole asymmetry this epic is built on.                     |
| **Add `identifierKey` to MCP and probe that**                  | Invents a third name for a thing that already has two, and leaves `key` ambiguous forever. The guard would pass while the confusion it exists to remove got worse.       |

---

### Amendment 8 (2026-08-06) — `/api/v1` ADVERTISES its contract version on every response

**Amends:** §8's allowed list, which gains **a new response header**, and §8's
implicit treatment of `V1_CONTRACT_VERSION` as documentation, which becomes an
obligation: an additive change MUST move the number.
**Leaves unchanged:** §1's rejection of header VERSIONING — in full, and this
amendment turns on the distinction; §2–§7 and §9; every prior amendment,
including Amendment 4 Q6's definition of what the number means. **No `/api/v1`
path, body shape, scope or status changes here.**
**Card:** MOTIR-2275, under the epic (MOTIR-1850).

#### The problem

Nothing on a `/api/v1` response said which contract version served it. Verified by
grep on `origin/main` @ `6d472611`: `withV1Route` stamped exactly `x-request-id`
and the `x-ratelimit-*` trio; `GET /api/v1/me` returns a `.strict()` `meSchema`
over `{ user, workspaceId, scopes }`, so no version could appear there even by
accident; and `V1_CONTRACT_VERSION` was read only by the emitter, the reference
page and two tests — never by a response path.

The only surface carrying the number was the specification document. So a client
that wanted to know what it was talking to had to download a specification to read
one string. `@motir/cli` was the first in-house client to hit that wall, and
`docs/decisions/cli-v1-client.md` Q3 (Story 11.5, MOTIR-2209) worked around it
honestly: probe the spec only after a boundary parse failure or an unrouted 404,
once per process — a decision recorded on 11.5's own branch. That design is
correct and it **stands** — but it is a fallback. It can only report skew _after_ a
command has already broken, and it costs a spec download at exactly the moment the
user is already having a bad time.

#### The decision

**`withV1Route` stamps `X-Motir-Api-Version: <V1_CONTRACT_VERSION>` on every
response**, into `responseHeaders` before the try block — exactly where the request
id goes — so it survives a 401, a 403, a 429, a mapped domain error and a 500
alike. It is declared in `V1_SHARED_RESPONSE_HEADERS`, so it appears on every
operation in the emitted document without being authored per operation.

The client that has the header reads it off a call it was already making and skips
the spec fetch entirely; the lazy probe stays as the fallback for a server that
does not send it — which is every server older than this change. Third-party
integrators get the same thing: an SDK, a CI action or an orchestration script can
pin a major and warn on a mismatch without ever fetching a specification.

##### ⚠️ ADVERTISING is not NEGOTIATING — why this does not reopen §1

§1 rejected **header versioning**: a REQUEST header (`X-GitHub-Api-Version`-style)
that SELECTS which contract the server serves. That rejection is untouched and this
change does not weaken it. The path is still the only thing that picks a contract,
this header is never read off a request, and a client sending it gets no different
behaviour. §1's two reasons both survive intact — the public/internal boundary is
still structural in `app/api/v1`, and no per-version transformation infrastructure
is implied by reporting a number the server already publishes.

The distinction is worth stating because the names collide: §1's "Rejected
alternatives" table names `X-Motir-Api-Version` as the rejected mechanism. It is
rejected as a mechanism for CHOOSING a version and adopted as a way of REPORTING
one.

##### ⚠️ It goes on the TRANSPORT, not in `GET /api/v1/me`'s body

A client that has to call one specific endpoint to learn the version cannot learn
it from the response that just failed — which is the case where it matters most.
`meSchema` also stays `.strict()` with its three deliberate fields: widening it
would put the answer in the one place it is least useful and make it unavailable
on every other response.

##### The obligation this creates

**An additive change under §8 MUST bump `V1_CONTRACT_VERSION` in the same PR.**
Before this amendment a stale number was a documentation defect a reader might not
notice; now it is a wrong answer on a header every client reads on the happy path,
so the number would lie about the very thing it exists to report. This amendment
pays its own toll: adding a response header is additive, so the constant moves
`1.0.0` → `1.1.0` in the same change.

| Rejected                                                    | Why                                                                                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A `version` field on `meSchema`**                         | Reachable only by calling one endpoint, so it cannot be read off the response that just failed — and it widens a `.strict()` shape whose three fields are deliberate.                           |
| **Leave it to the lazy spec probe alone**                   | The probe is a good fallback and it stays, but it reports skew only after a command has broken and costs a spec download to do it. The header makes the check free rather than merely possible. |
| **Report the deployment's release number instead**          | Amendment 4 Q6 already settled what the number means: a release number churns on every unrelated deploy and tells a client nothing it can act on.                                               |
| **Stamp it inside the try block, beside the response body** | It would then be absent from exactly the 401 / 403 / 429 / 500 responses where a client most wants to know whether it is speaking the right contract.                                           |

---

### Amendment 9 (2026-08-06) — the documentation area is `/docs`, not `/api-docs`; what the sandbox guide OWNS; and the profile table DERIVES from the CLI's own profile record

**Amends:** Amendment 4 Q4's **routes** only — `/api-docs*` becomes `/docs*`. Q4's
home (`motir-core`, `app/(public)/`), its renderer decision and its language rule
are untouched, and this amendment is written INSIDE them.
**Leaves unchanged:** §1–§9 in full; Amendment 4 **Q3 in particular — the spec
stays at `/api/openapi/v1.json` and does not move**; Amendments 1, 2, 3, 5, 6 and
7 in full. **No `/api/v1` shape, path, scope or status changes here.**
**Card:** MOTIR-2269, under Story MOTIR-2268 (the published sandbox setup guide).

#### The problem

Amendment 4 Q4 routed the developer-documentation surface at `/api-docs` because
everything on it was about the API. Story MOTIR-2268 adds the first page that is
not: how to run a coding agent inside the published sandbox image. That page has
no route it can be written to until three questions are settled, and all three
are cheap now and expensive later.

The surface is already broader than its address, in two places a reader can see:
`app/(public)/explore/_components/ExploreTopBar.tsx:52` labels the entrance
**`Docs`** (`t('navDocs')`), and `app/(public)/api-docs/layout.tsx:8` calls itself
_"the developer-documentation shell"_. So the name a visitor clicks, the name the
code gives itself, and the URL they land on already disagree — and the first
non-API page is where that stops being cosmetic.

---

#### Q1 — the area is renamed to `/docs`, with permanent redirects; the sandbox guide is `/docs/sandbox`

##### The decision

**Rename `app/(public)/api-docs/` to `app/(public)/docs/`**, serving:

| Page                  | Route                   |
| --------------------- | ----------------------- |
| API reference         | `/docs/api`             |
| Getting started       | `/docs/getting-started` |
| Stability policy      | `/docs/stability`       |
| **The sandbox guide** | **`/docs/sandbox`**     |

with **permanent (308) redirects** from `/api-docs` → `/docs/api` and
`/api-docs/:path*` → `/docs/:path*`, added to `next.config.ts` (which carries no
`redirects()` today — the migration adds the first one). The reference moves off
the area ROOT to `/docs/api` because a four-page area whose root is one of the
four pages cannot grow a fifth without the same argument again; `/docs` itself
redirects to `/docs/api` until an index page earns its place.

##### Why now, and not "when it hurts"

`/api-docs` shipped on **2026-08-05** — one day before this amendment — and is
linked from nothing outside this repository. Every cost below is at its global
minimum today and rises monotonically: with each further page, each external
link, and each search-engine impression. The card that asked this question is the
last cheap moment to ask it.

##### The cost, enumerated by grep rather than estimated

`grep -rn "api-docs"` over the tree, excluding `node_modules` / `.next`:

| Site                                                                                            | Count                         |
| ----------------------------------------------------------------------------------------------- | ----------------------------- |
| The route directory `app/(public)/api-docs/` (4 pages, 5 `_components`)                         | 1 move                        |
| In-product links — `ExploreTopBar.tsx:52`, `ExploreFooter.tsx:62`, `ApiDocsLinkPanel.tsx:34,39` | 4                             |
| ADR self-references — §8's pointer (`:380`), Q4's route line (`:1090`), Q5's opening (`:1150`)  | 3                             |
| `lib/apiDocs/guide.ts` — the `/api-docs/stability` note at `:215`                               | 1                             |
| Vitest — `reference-page`, `guide-pages`, `guide-truth`, `story-gate`                           | ~14 assertions in 4 files     |
| E2E — `tests/e2e/acceptance-api-docs.spec.ts`                                                   | 8 URL waits / gotos in 1 spec |
| `next.config.ts` redirects                                                                      | 1 new block                   |

Nothing outside `motir-core` names the path: `docs/cli.md` does not, and neither
does `packages/cli`. `proxy.ts`'s matcher covers only `/dashboard`, `/settings`
and `/invite`, so no middleware follows the route and none has to be edited.

##### The rule that decides what ELSE moves — ADDRESSES move, internal identifiers do not

The question "does `X` rename too?" recurs for the i18n namespace, the content
module directory and the design-asset folder. It is settled once, by a rule:

> **A name that is a promise to a stranger moves with the surface. A name only
> this repository can see does not.**

So, and this is exhaustive:

- **Moves:** the URL path, and every in-product link and test that names it. A URL
  is quoted, bookmarked and indexed by people who cannot be told it changed.
- **Stays:** the **`apiDocs` next-intl namespace** (45 keys × 2 catalogs), the
  content module directory **`lib/apiDocs/`**, the design-asset area
  **`design/api-docs/`**, and the test directory **`tests/api-docs/`**. None is
  addressable, none is quotable, and renaming them buys tidiness at the price of
  ~100 mechanical edits plus a rewrite of a card (MOTIR-2270) already written
  against `design/api-docs/`.

This deliberately NARROWS the option as the card sketched it (which paired the
route rename with the namespace rename). The narrowing is the point: the misnomer
that costs anything is the one a stranger reads.

##### The migration is its OWN card

The rename is a route migration touching four link sites, five test files, an E2E
spec and a redirect map. The guide page (MOTIR-2271) is a `content`-shaped card
that writes one page. **They are not one card**, so the migration is a separate
subtask in Story MOTIR-2268, `blocked_by` this decision and blocking the page.

##### Rejected alternatives

| Rejected                                                        | Why                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A fourth page at `/api-docs/sandbox`** (the cheapest option)  | Costs nothing today and is wrong permanently. The page it addresses is about running a container, not about the API; every later non-API guide inherits the misnomer, and by the time it is worth fixing there are external links pinned to it. It also leaves `Docs` → `/api-docs` reading as a bug to every visitor who notices. |
| **A page OUTSIDE the docs shell** (e.g. `/sandbox`)             | Forks the navigation: the rail would list three documents while a fourth existed somewhere the rail never mentions, so the only entrance is a link someone remembers. The story's own access-path requirement rules it out.                                                                                                        |
| **Rename the `apiDocs` namespace and `lib/apiDocs/` too**       | ~100 edits across both message catalogs and every `useTranslations('apiDocs')` call, for a name no reader can see — and it would invalidate MOTIR-2270, which is written against `design/api-docs/`. Excluded by the addresses-move rule above.                                                                                    |
| **Keep `/api-docs` and rename the top-bar entry to "API docs"** | Fixes the disagreement by making the surface narrower than it already is, one day after shipping a shell that calls itself the developer-documentation shell. It answers the wrong question: the area's content is broadening, and the name should follow the content.                                                             |

---

#### Q2 — the ownership boundary: the page owns the FIRST RUN; the README owns everything after it

##### The rule

> **A fact belongs on the published page when a reader needs it to make their
> FIRST successful run happen, AND a test can hold it true. Otherwise it belongs
> in `packages/cli/sandbox/README.md`.**

Two limbs, and the second is the one that matters. The first limb allocates by
audience; the second allocates by **staleness cadence**, which is where this
documentation has actually failed. The sandbox's two published-documentation
defects were both drift, not error: MOTIR-2010 (the image was private while the
docs told everyone to pull it) and MOTIR-2131 (the published image was eleven CLI
commits stale while the docs described newer behaviour). Both were found by a
person. So a fact whose truth cannot be asserted by a check — a digest, a vendor's
current auto-approve flag, a release-specific tag — does not go on the page at
all, however useful it would be there. The page carries only what the build can
refuse.

##### The allocation this produces today

| The PAGE owns                                                                                                               | The README keeps                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| What the sandbox confines and what it does **not** (filesystem confined, **network open by design**, unprivileged uid 1000) | The full confinement proof and its per-surface argument                 |
| The copy-pasteable `docker run`, with exactly the mounts the entrypoint requires                                            | `docker compose` profiles, the devcontainer variants' internals         |
| The three **Motir**-credential tiers (env / mounted `~/.config/motir` / `motir login`) — named, not re-derived              | The tier-3 escape hatch and the mount-free CI recipe in full            |
| The profile table: id, tier, install source, binary, agent-credential mount                                                 | The auto-approve flag matrix (vendor-versioned — fails the second limb) |
| That a dev-container path exists, and where it is                                                                           | The published **digest tables** (per release — fails the second limb)   |
| A link back to the README for everything above                                                                              | The validation harness and the smoke suite                              |

**One conflation the page must not make:** the _three credential tiers_ are ways
to give the container a **Motir** credential; the _credential mount_ column of the
profile table is the **agent's own** credential. They are different secrets with
different failure modes, and the README keeps them apart (`§ Credentials` vs
`§ The profile matrix`). The page does too.

##### Rejected alternatives

| Rejected                                                    | Why                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Publish the README wholesale as the page**                | 57 KB written for someone who has already cloned the repo, including digest tables and a validation harness. Publishing it moves the clone requirement rather than removing it. |
| **Split by TOPIC ("security here, running there")**         | Every new fact re-opens the argument, because most facts are about both. Splitting by the reader's POSITION (before or after the first run) decides each one on sight.          |
| **Let the page carry the digest table so a reader can pin** | A per-release fact on a page no release lane edits — precisely the MOTIR-2131 shape, rebuilt on the surface built to prevent it. The page links the README's table instead.     |

---

#### Q3 — the profile table DERIVES from `AGENT_PROFILES`; `credentialPaths` is NOT the mount, so the profile record gains `sandboxMounts`

##### How the shipped surface reaches its own source — checked, not assumed

`lib/apiDocs/reference.ts:8` imports `V1_OPERATIONS` from
`@/lib/api/v1/openapi/registry` and derives a view model from it **at build time,
by direct module import** — no fetch of its own public URL, no generated file, no
copy. Its own header says why: _"The page and `/api/openapi/v1.json` have ONE
source… A page that fetched its own public URL would add a network round trip, a
failure mode and a bootstrapping problem for no gain."_

That is the pattern this page copies. The one thing it does NOT establish is a
package boundary: `lib/api/v1/**` is the same Next application, and `packages/cli`
is not.

##### The finding that changes the answer — `credentialPaths` is a different fact

The card named `AGENT_PROFILES.credentialPaths` as the source of the table's
credential-mount column. **It is not, and deriving from it would publish three
wrong rows and one incomplete one.** `agentProfiles.ts`'s own header states the
divergence: _"The matrix pins a MOUNT, which is not always proof of AUTH… Where
they diverge the profile tests the narrower thing… or declines to test a path at
all."_ `credentialPaths` answers **"where can `motir doctor` prove a sign-in
happened?"**; the page's column answers **"which of my host directories does the
container bind?"**. Concretely:

| Profile       | `credentialPaths(dirs)` (the doctor probe) | What `sandbox/docker-compose.yml` actually mounts `:ro` |
| ------------- | ------------------------------------------ | ------------------------------------------------------- |
| `claude`      | `~/.claude`                                | `~/.claude`                                             |
| `codex`       | `~/.codex`                                 | `~/.codex`                                              |
| `opencode`    | `~/.local/share/opencode/auth.json`        | `~/.config/opencode` **and** `~/.local/share/opencode`  |
| `kimi`        | `~/.kimi-code`                             | `~/.kimi-code`                                          |
| `antigravity` | _(none — OS keyring)_                      | _(none)_                                                |
| `cursor`      | **_(none — the mount proves an install)_** | **`~/.local/share/cursor-agent`**                       |
| `aider`       | **_(none — the key is an env var)_**       | **`~/.aider.conf.yml`**                                 |
| `goose`       | **_(none — keyring by default)_**          | **`~/.config/goose`**                                   |

Three rows would publish "no credential mount" for a profile the image does mount
one for, and `opencode` would publish one of its two. A derivation is only worth
having if it derives the fact the reader is being told.

**A second card-level correction, recorded so it is not re-derived:** the cards
say "nine profiles including `base`". `AGENT_PROFILES` has **eight**, and
`sandbox/smoke/profiles.json` has the same eight; the README's matrix says
"**eight**" in its own prose. `base` is the agent-less **image tag**
(`Dockerfile:156`, `ARG AGENT=base`, a deliberate no-op arm), not a profile. The
page's table therefore has eight rows, and `base` is documented beside it as the
tag to run when you bring your own agent binary.

##### The decision

1. **`AgentProfile` gains a `sandboxMounts: readonly string[]` field** — the
   host paths `sandbox/docker-compose.yml` binds read-only for that profile,
   `~`-relative, in mount order, `[]` where the profile mounts nothing. It sits
   beside `credentialPaths` with a comment naming the distinction above, so the
   next reader cannot repeat the conflation this amendment just caught.
   `packages/cli/test/sandbox.test.ts` — which already parses the compose
   volumes (`'binds no host path beyond the workspace, the PAT config and the
agent credential'`) — gains the arm asserting the two agree.
2. **`AGENT_PROFILES` in `packages/cli/src/agentProfiles.ts` is then the SINGLE
   derivation source** for every column: `id`, `tier`, `installSource`,
   `binaries[0]` (canonical first, by its own contract), and `sandboxMounts`.
   Nothing in the table is retyped.
3. **A new `lib/apiDocs/sandbox.ts` imports it by RELATIVE path** —
   `import { AGENT_PROFILES } from '../../packages/cli/src/agentProfiles'` — and
   exports the rendered rows plus the page's prose, exactly as `guide.ts` does for
   the getting-started guide. The `@/*` alias is rooted at the app, so it cannot
   express a path outside it; the relative climb is the honest spelling and is
   greppable as the one boundary crossing.

##### The boundary this opens, and the invariants that bound it

This is the first **runtime** import from the app into `packages/cli` (today's
crossings are comments and tests: `tests/api/v1/cli-renderers-from-v1.test.ts`
imports `../../../packages/cli/src/render`, and
`tests/components/ConnectCliPanel.test.tsx` reads the CLI's manifest to assert a
literal the app hardcodes). It is permitted, narrowly, under three invariants the
story's vitest gate (MOTIR-2272) asserts:

- **`lib/apiDocs/sandbox.ts` is the ONLY module under `app/` or `lib/` that
  imports from `packages/cli/**`.\*\* One crossing is a documented seam; a habit is
  a merged build.
- **`packages/cli/src/agentProfiles.ts` imports nothing but `node:` builtins**
  (today: `node:path`). That is what keeps the app from acquiring the CLI's
  dependency graph through a documentation page.
- **The derived rows are plain serializable data**, so the page may hand them to a
  client component without `node:path` reaching a browser bundle.

**Rung 2, run rather than assumed.** A probe module doing exactly this import,
typechecked with the repo's own `tsc --noEmit -p tsconfig.json`, produced **zero
errors of its own** — `tsconfig.json`'s `"exclude": ["node_modules", "packages"]`
filters the program's ROOT set and does not refuse a file reached by an import.
(The run surfaced only pre-existing `PlanChangeTurn` errors from a stale generated
Prisma client, unrelated to this.) The remaining unverified step is bundling:
`next build` must compile the module for the server, which MOTIR-2271 confirms as
an acceptance criterion rather than this amendment asserting it.

##### Rejected alternatives

| Rejected                                                                                   | Why                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Derive the mount column from `credentialPaths`** (the card's source)                     | Publishes "no credential mount" for `cursor`, `aider` and `goose`, and half of `opencode`'s. It answers the doctor's question, not the reader's — the table above is the evidence.                                                                                                         |
| **Restate the table in the page and assert it against the CLI in a test**                  | The pattern `ConnectCliPanel` uses, and it satisfies "a wrong claim fails the build". It does NOT satisfy the story's other half — a profile added to `AGENT_PROFILES` must APPEAR on the page with no edit — which is the property that survives the person who wrote the page leaving.   |
| **Parse `sandbox/docker-compose.yml` at build time for the mounts**                        | Puts a YAML parse and a repo-relative `fs` read on a rendered page, with an output-file-tracing dependency on a file no deployment ships. The same fact, declared in the profile record instead, costs one field and is guarded by a test that already reads that file.                    |
| **Give `@motir/cli` an `exports` subpath and add it as a workspace dependency of the app** | Architecturally the cleaner boundary, and it breaks the published package: `@motir/cli` ships `files: ["dist"]`, so a source-pointing export is a dangling path for every npm consumer, and a `dist`-pointing one couples `next build` to the CLI being built first (including on Vercel). |
| **Generate a checked-in data module from `AGENT_PROFILES`**                                | A third artifact, kept in step by a generator someone must remember to run — the two-artifact drift Story 11.4 exists to prevent, moved down one level.                                                                                                                                    |

---

#### Q4 — localization: recorded, not re-decided

The sandbox guide follows **Amendment 4 Q4's** split unchanged: _"if a client
could parse it, it is English; if only a human reads it, it is localized."_ Its
long-form prose lives as data in `lib/apiDocs/sandbox.ts` for the same reason
`lib/apiDocs/guide.ts:18` records for the getting-started guide — a catalog entry
per paragraph makes a document unreadable to edit and puts shell commands inside a
localization file — while the page CHROME goes through the `apiDocs` next-intl
namespace with `messages/en.json` + `messages/zh.json` parity. The `docker run`
command, the profile ids, the binaries and the mount paths are English by the same
rule that keeps operation text English: they are strings a machine consumes.

Nothing here re-opens Q4. It is stated so the page card does not have to ask.

---

#### Consequences of this amendment

- **A new subtask in Story MOTIR-2268** performs the Q1 migration — the route
  move, the four link sites, the redirect map, and the test + E2E path strings.
  It is `blocked_by` MOTIR-2269 and blocks MOTIR-2271.
- **MOTIR-2270** (design) draws the rail's fourth entry against `/docs/sandbox`
  and the renamed sibling routes. Its asset area stays `design/api-docs/` per the
  addresses-move rule.
- **MOTIR-2271** (the page) adds `sandboxMounts` to `AgentProfile`, writes
  `lib/apiDocs/sandbox.ts` deriving the eight-row table from `AGENT_PROFILES`, and
  confirms `next build` compiles the cross-package import.
- **MOTIR-2272** (the vitest gate) asserts the three boundary invariants above,
  the eight-row derivation, and the compose ↔ `sandboxMounts` agreement.
- **Amendment 4 Q4's route line and §8's `/api-docs/stability` pointer** are
  updated by the migration card, not by this one — this amendment is the decision,
  and rewriting the clauses it amends is the shape every amendment here avoids.

### Amendment 10 (2026-08-06) — a v1 collection row EMBEDS a minimal actor; `targetRepo` stays off it; and how a key-addressed collection is enumerated

> **Written by Story 11.5 · Subtask 11.5.13 (MOTIR-2279), from a defect its own consumer found at RUN time.**
>
> **Numbered 10.** Three amendments were authored in parallel on 2026-08-06 as this epic and the docs work ran side by side; each merge race pushed this record one number along (8 → 9 → 10). The content is unaffected — 8 makes the contract version legible on every response, 9 moves the documentation area to `/docs`, and 10 says what a collection row contains.

Story 11.5 makes `@motir/cli` a peer consumer of this API, on the argument that an
API is only real once something in-house depends on it. Running it produced the
first case where that consumer contradicted a decision recorded here. All three
questions below are about the READY row, and two of them are answered by
**confirming** what was already decided.

#### Q1 — a v1 collection row embeds a minimal ACTOR object

##### The conflict

`lib/api/v1/ready/schema.ts` carried an explicit exclusion:

> `assignee.avatarUrl` / `name` — a public API must not acquire a second, accidental
> user resource. The id is what a client can act on (it is what 11.2's PATCH takes
> back); the display fields are the web app's.

`@motir/cli` renders an ASSIGNEE column from `assignee.name`
(`packages/cli/src/render.ts:255`). Migrating it onto `/api/v1` would print
_unassigned_ for every assigned row — silently, since a blank cell looks exactly
like unassigned work.

##### Why the recorded reason does not hold

**It is right about what it fears and wrong about what counts as one.** A second
user RESOURCE would be an endpoint, a collection, an expansion, something a
client can query — and none of that is being proposed. **An embedded, minimal,
read-only actor is a FIELD.** It cannot be listed, filtered, paged or fetched;
it is two strings on a row the client already has.

And the cost of omitting it is not one CLI's inconvenience. **`assigneeId` alone
means NO client can render a work-item list showing who owns what**, because v1
has no user endpoint to resolve an id against and Q1 is not proposing one. That
is every integration that draws a table.

##### Rung 1 — checked, not assumed

| Product    | Issue-row shape                                                                                                          | Source                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| **GitHub** | `assignees: [ Simple User ]` — an embedded object carrying `login`, `id`, `name`, `avatar_url`, …                        | REST "List repository issues" response schema |
| **GitLab** | `assignees: [{ id, name, username, state, avatar_url, web_url }]`, plus a deprecated single `assignee` of the same shape | "List issues" JSON response example           |

Neither returns a bare id. Both embed a display name on the row. The recorded
rationale is out of step with every product this API is measured against, and on
a product question rung 1 outranks a local preference.

##### The decision

**Every `/api/v1` collection row that references a person embeds a minimal actor
object: `{ id, name }`, nullable.** Not just the ready row — the rule is general,
so the next collection to carry one imports `actorRefSchema` rather than
re-deciding.

- **`avatarUrl` stays OFF.** No terminal or script renders one, and it is the
  part of the mirrors' shape that genuinely is web-app furniture.
- **`assigneeId` is KEPT beside it.** Removing a shipped field is a §8 violation,
  and it remains the cheaper read for a client that only routes on identity.
  `assignee.id` and `assigneeId` are the same value, asserted by a test.
- **This is additive under §8**, so `V1_CONTRACT_VERSION` moves to **`1.1.0`**.
- **No new query.** `ReadyItemDto` already carries `assignee`; the route already
  reads it; the mapper was dropping it.

##### Rejected alternatives

| Rejected                                                            | Why it lost                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep `assigneeId` only** (the status quo)                         | No client can render a name without a user endpoint v1 does not have; the cost lands on every integration, not one CLI.                   |
| **Add a `GET /api/v1/users` directory**                             | This is the "second, accidental user resource" the original rationale correctly feared, and an N+1 for any client drawing a list.         |
| **Embed the full mirror shape (`avatarUrl`, `username`, `webUrl`)** | Ships web-app furniture as public contract; each extra field is one more thing §8 forbids removing.                                       |
| **Let the CLI hold a local id→name map**                            | A cache with no invalidation, wrong for every other client, and it makes one consumer special — the precise inversion 11.5 exists to end. |
| **Replace `assigneeId` with `assignee`**                            | Removes a shipped field. §8 forbids it, and there is no benefit to pay for the break.                                                     |

#### Q2 — `targetRepo` stays OFF the public row (the existing rationale is CONFIRMED)

The same schema excluded `runCommand` / `contextRefs` / `sessionBranch` /
`targetRepo` because they _"live on `ReadyItemDispatchDto`, the payload for
Motir's OWN CLI dispatch path"_ and _"encode assumptions about a local checkout
that a third-party integration does not share."_

**That reasoning holds and is reaffirmed here.** Unlike Q1 there is no gap: a
client that needs `targetRepo` reads
**`GET /api/v1/work-items/{key}/dispatch-prompt`**, which Story 11.7 ships and
which carries `targetRepo`, `workflowMode` and `sessionBranch` together. The
ready row answers _"what can I pick up?"_; the dispatch prompt answers _"what do
I need in order to do it?"_. Keeping the second question's fields off the first
question's row is the split working as designed.

`@motir/cli`'s own use confirms it: `batch.ts:343` already reads
`dispatch.targetRepo` for the actual work, and only its printed plan snapshot
(`batch.ts:135`) reaches for the ready row's copy. That snapshot moves to the
dispatch read.

#### Q3 — how a KEY-addressed collection answers "not these" (a §7 corollary)

§7 pins that v1 addresses work items by `MOTIR-<n>` key and never by internal id.
No v1 collection had yet needed to express _"give me the next one that is not one
of these"_ — the MCP `next_ready` tool does it with an `excludeIds` argument over
internal ids, which §7 forbids here.

**The corollary: exclusion is a CLIENT-side filter over the page, keyed by
`key`.** The server owns the ORDER — the ready set already arrives in the
dispatch rank `(type asc, priority desc, key asc)`, so `items[0]` is what to take
next — and a client that wants to skip rows filters them out and pages forward,
never re-sorting. No `exclude` query parameter is added:

- it would have to grow without bound as a caller skips more rows;
- it would put a client's transient session state in a URL;
- and the client already holds the exclusion set, so a round trip buys nothing.

A client with a persisted exclusion list keyed by internal id migrates it to
`key`, which is the only identifier v1 exposes.

#### Consequences of this amendment

- **11.5.13** implements Q1 on `readyItemSchema`, declares `actorRefSchema`, and
  bumps `V1_CONTRACT_VERSION` to `1.1.0`.
- **11.5.4** consumes it, reads `targetRepo` from the dispatch prompt per Q2, and
  filters exclusions by `key` per Q3.
- **A future collection row referencing a person** imports `actorRefSchema` —
  the rule is general and does not need re-deciding per resource.
- **Story 11.6's `list_ready` re-base** becomes a true no-op on the MCP payload
  once this lands, rather than a change that would drop `assignee` from it.

---

### Amendment 11 (2026-08-06) — the documentation area is a set of SUB-AREAS; the API reference owns `/docs/api/*`, and the operation index renders only inside it

**Amends:** Amendment 4 Q4's **route list** and Amendment 9 Q1's **route table** —
the guide and the policy move from `/docs/getting-started` and `/docs/stability`
to `/docs/api/getting-started` and `/docs/api/stability`. Q4's home
(`motir-core`, `app/(public)/`), its renderer decision and its language rule are
untouched, and this amendment is written INSIDE them.
**Leaves unchanged:** §1–§9 in full; **Amendment 4 Q3 — the spec stays at
`/api/openapi/v1.json`**; **Amendment 9 Q1's `/docs` rename and its
addresses-move rule**, which this amendment APPLIES rather than re-opens, and its
`/docs/sandbox` route, which does not move; Amendments 1, 2, 3, 5, 6, 7 and 8 in
full. **No `/api/v1` shape, path, scope or status changes here.**
**Card:** MOTIR-2310, under MOTIR-2307 (the docs-navigation defect).

> **Numbered 11, not 10.** This amendment was authored as _Amendment 10_ and lost
> the merge race to [Amendment 10](#amendment-10-2026-08-06--a-v1-collection-row-embeds-a-minimal-actor-targetrepo-stays-off-it-and-how-a-key-addressed-collection-is-enumerated)
> (MOTIR-2279, the collection-row actor), which landed on `main` first — the same
> race its own header records for 8 → 9 → 10, one round later. The content is
> unaffected. **Anything citing "Amendment 10" for the docs information
> architecture means THIS amendment**; the design assets under `design/api-docs/`
> and `design/agent-sandbox/` were corrected in the same run that found the
> collision.

#### The problem

Amendment 9 Q1 moved the area's ADDRESS from `/api-docs` to `/docs` and said so
explicitly: it changed where the surface lives, not how it is organised inside.
That was correct at the time and it is what made the next problem visible.

On `origin/main` today, `app/(public)/docs/_components/CatalogueNav.tsx` renders
ONE group — `t('navDocumentation')`, _"Documentation"_ — holding four rows:

| Row                     | Route                   | What it is about                               |
| ----------------------- | ----------------------- | ---------------------------------------------- |
| API reference           | `/docs/api`             | the REST API                                   |
| Getting started         | `/docs/getting-started` | **the REST API** — a PAT, a first call, errors |
| Stability & deprecation | `/docs/stability`       | **the REST API** — §8's additive-only promise  |
| Agent sandbox           | `/docs/sandbox`         | **a container you run a coding agent in**      |

Three of the four are about the API and none of them says so. Beneath that group
the same component renders every group in its `groups` prop, which all four pages
supply from `buildApiReference()` — so the ~28 `/api/v1` operations are listed on
the sandbox guide as well, and the rail's accessible name there is the literal
string _"API reference"_ (`messages/en.json` `apiDocs.navLabel`).

The structure was right when every page in the area was about the API. It became
wrong when a page about something else arrived, and it gets worse — not more
visible — with each additional page. Two are already queued (MOTIR-2308, the CLI;
MOTIR-2309, the MCP), which is what makes now the cheap moment: four rows, no
external links, one repository.

---

#### Q1 — the area is a set of SUB-AREAS, one per documented surface; the API reference owns `/docs/api/*`

##### The decision

**`/docs` is a set of sub-areas, one per product surface Motir documents. Every
page about a surface lives under that surface's prefix, and the rail lists the
SURFACES at its top level — not their pages.**

The API reference is the first such sub-area. It owns `/docs/api/*`: the
reference itself is the sub-area's index at `/docs/api`, and the guide and the
policy become pages inside it.

The rail therefore renders in two tiers:

| Tier                     | What it lists                                                         | Rendered on               |
| ------------------------ | --------------------------------------------------------------------- | ------------------------- |
| **Documentation**        | one row per SURFACE — API reference, Agent sandbox, later CLI and MCP | every page in the area    |
| **The current sub-area** | that surface's own pages, and its resource index where it has one     | only inside that sub-area |

A single-page surface is a single row and gets no second tier, which is why
`/docs/sandbox` does not move and needs nothing added.

##### What three shipped developer-documentation surfaces actually do — observed, 2026-08-06

Read rather than remembered, per the mirror-product rung:

| Product        | Where the API reference lives                                      | Where the guides live                                                        | Observed                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stripe**     | `docs.stripe.com/api` — its own index, its own resource navigation | sibling top-level prefixes: `/get-started/…`, `/payments/…`, `/stripe-cli/…` | The reference is not a row in a flat list beside the guides; it is a prefix with an index of its own, and it links back OUT to the quickstart rather than absorbing it. |
| **GitHub**     | `docs.github.com/en/rest` — resource subsections under one prefix  | sibling top-level sections: `/en/actions`, `/en/graphql`, `/en/billing`      | Individual endpoints are addressed _under_ `/en/rest/`; guide-shaped pages sit at `/en/rest/guides/` — inside the API's prefix, because they are about the API.         |
| **Cloudflare** | `developers.cloudflare.com/api/resources/…`                        | a different prefix entirely                                                  | Operations are nested resource → subresource → method under the API prefix; nothing outside that prefix carries the operation index.                                    |

All three place the API reference in **its own prefix with its own navigation**,
and all three keep API-specific guides **inside** that prefix rather than beside
the product's other documentation. That is the arrangement decided above, and the
convergence is the reason for choosing the more expensive option: the two rows
this moves are API-specific guides in exactly GitHub's `/en/rest/guides/` sense.

##### Rejected alternatives

| Rejected                                                                                                                        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Labelled sections in one flat rail** — a _Guides_ group above an _API reference_ group, no route change (the cheapest option) | Fixes the appearance and leaves the addresses lying. `/docs/getting-started` still promises getting started with Motir to anyone who reads a URL, links one, or lands on it from a search result — and a URL is the part of this surface strangers quote. It also has no answer for the second API guide: a flat rail with eight rows and two headings is the same problem at twice the size. Cheapness here buys one release of quiet. |
| **Scope the operation list only, change no grouping** (the parent card's third option)                                          | Necessary but not sufficient, and it is not an alternative — it is Q2 below, which this decision adopts. On its own it removes the loudest symptom while leaving "Getting started" at the top level of an area named Docs, which is the defect a reader meets first.                                                                                                                                                                    |
| **A separate `/api` top-level area outside `/docs`**                                                                            | Re-opens Amendment 9 Q1 one day after it settled, and splits the shell: the reference would lose the rail that lists Motir's other documentation, so the only route from the API to the sandbox guide would be a link someone remembers to add. The observed surfaces keep the reference INSIDE the documentation site, one prefix down.                                                                                                |
| **Move `/docs/sandbox` under a `/docs/guides/` prefix at the same time**                                                        | Re-opens Amendment 9 Q1's route for a page that shipped yesterday, to buy symmetry the rule below does not need. A one-page surface is a one-row surface; `guides` is not a product surface, it is a word for "everything else", and grouping by it would re-create the flat list one level down.                                                                                                                                       |

---

#### Q2 — the operation index renders inside the API sub-area and nowhere else, decided by the ROUTE PREFIX

##### The decision

**A page renders the `/api/v1` operation index if and only if it is inside the
API sub-area — that is, its route is `/docs/api` or below.** The route prefix
decides it. Not the page (which would be a per-page flag four call sites can
disagree about), and not the nav group (which is derived from the prefix anyway).

One fact decides both which sub-area a page belongs to and whether it shows that
sub-area's resource index, so the two cannot drift apart. A page added under
`/docs/api/*` inherits the index with no edit; a page added anywhere else cannot
acquire it by accident — which is exactly how the sandbox guide acquired it.

The generalisation, for the sub-areas that do not exist yet: **a sub-area's
second-tier navigation is whatever that surface's own index is** — the operation
list for the API, and, if the CLI story wants one, a command list for the CLI.
Nothing says every sub-area must have one.

##### Rejected alternatives

| Rejected                                                                                | Why                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A `showOperations` prop each page passes**                                            | Four call sites that can disagree with the grouping, and a fifth page's author has to know the prop exists. The defect being fixed is precisely that every page passed `groups` without anyone deciding it should.                          |
| **Render the index only on `/docs/api` itself, not on its guide pages**                 | The guide and the policy ARE about the operations; a reader following the getting-started steps is the likeliest person to want the operation beside them. The prefix rule keeps them, which is also what GitHub's `/en/rest/guides/` does. |
| **Keep rendering it everywhere, but collapse it behind a disclosure off the API pages** | Still answers "what is this surface about" with the API on a page that is not, and adds an interaction to a rail whose whole job is to be read at a glance.                                                                                 |

---

#### Q3 — what moves, what redirects, and what does NOT rename

##### The routes

| Page                    | Today                   | After                           |
| ----------------------- | ----------------------- | ------------------------------- |
| API reference           | `/docs/api`             | `/docs/api` — unchanged         |
| Getting started         | `/docs/getting-started` | **`/docs/api/getting-started`** |
| Stability & deprecation | `/docs/stability`       | **`/docs/api/stability`**       |
| Agent sandbox           | `/docs/sandbox`         | `/docs/sandbox` — unchanged     |

Two pages move. The other two do not.

##### The redirect map, in full and in order

`next.config.ts`'s `DOCS_REDIRECTS` becomes the following. **Order is
load-bearing** — Next matches top to bottom, and `/api-docs/:path*` also matches
`/api-docs`, so every exact `/api-docs/*` rule must precede the wildcard. That
ordering is already asserted by `tests/api-docs/docs-redirects.test.ts`, which
compares the array exactly; it is updated to this map, never loosened.

| #   | Source                      | Destination                 | Status | Origin                                   |
| --- | --------------------------- | --------------------------- | ------ | ---------------------------------------- |
| 1   | `/api-docs/getting-started` | `/docs/api/getting-started` | 308    | **new** — one hop, not two, via rule 4   |
| 2   | `/api-docs/stability`       | `/docs/api/stability`       | 308    | **new** — same                           |
| 3   | `/api-docs`                 | `/docs/api`                 | 308    | Amendment 9 Q1                           |
| 4   | `/api-docs/:path*`          | `/docs/:path*`              | 308    | Amendment 9 Q1                           |
| 5   | `/docs/getting-started`     | `/docs/api/getting-started` | 308    | **new** — this amendment's own move      |
| 6   | `/docs/stability`           | `/docs/api/stability`       | 308    | **new** — same                           |
| 7   | `/docs`                     | `/docs/api`                 | 308    | Amendment 9 Q1 — see the open item below |

Rules 1 and 2 exist for the same reason Amendment 9 gave for putting the exact
`/api-docs` rule before the wildcard: without them, an old bookmark to
`/api-docs/stability` would take two hops (`→ /docs/stability → /docs/api/stability`),
and a chain is a thing that breaks one rule at a time.

##### What does NOT rename — the addresses-move rule, applied not re-decided

Amendment 9 Q1 settled this and it settles it again here: **a name that is a
promise to a stranger moves with the surface; a name only this repository can see
does not.** So the following are untouched by this amendment, and a future card
proposing to "tidy" them is answered by that rule:

- the **`apiDocs`** next-intl namespace (54 keys × 2 catalogs),
- the content module directory **`lib/apiDocs/`**,
- the design-asset area **`design/api-docs/`**, which owns this rail,
- the test directory **`tests/api-docs/`**.

The one string that is NOT an internal identifier and DOES change is
`apiDocs.navLabel`, whose value is the literal `"API reference"` and is the
rail's accessible name on every page in the area, including the sandbox guide. A
name a screen reader speaks is read by a stranger; it moves with the surface.

---

#### Q4 — the placement rule for the NEXT documentation page

##### The rule

> **A documentation page lives under the prefix of the product surface it
> documents. A surface earns a prefix when it has more than one page: with one
> page it IS `/docs/<surface>`; the second page about that surface creates
> `/docs/<surface>/…`, moves the first inside it, and leaves a permanent
> redirect behind.**

Two properties are worth naming, because they are why this is a rule and not a
preference. It answers the question from the CONTENT of the page rather than
from what the rail currently looks like, so two people asking it a year apart get
the same answer. And it makes growth the trigger for restructuring, at the moment
restructuring is cheapest — which is the same argument Amendment 9 made about
addresses, one level up.

##### The worked example, applied rather than asserted

_"Where does a new Self-hosting page go?"_

Self-hosting is a product surface — running Motir yourself — and it is not the
API, the CLI or the MCP. It is one page. So it is **`/docs/self-hosting`**, a
fifth row in the rail's surface tier, with no second tier and no operation index
(Q2: it is not under `/docs/api`). If a second self-hosting page later lands —
say, upgrades — then that surface earns its prefix: `/docs/self-hosting` becomes
the sub-area index, the new page is `/docs/self-hosting/upgrades`, and nothing
about the first page's address changes because it was already the index.

The same rule, applied to the two queued stories: MOTIR-2308's CLI documentation
is `/docs/cli` if it is one page and `/docs/cli/*` if it is several; MOTIR-2309's
MCP documentation is `/docs/mcp` or `/docs/mcp/*` on the same test. Neither story
has to re-open this question, which is the point of writing it down.

---

#### What this amendment deliberately does NOT decide

**The area ROOT.** Rule 7 above keeps `/docs` redirecting to `/docs/api`, and
both shipped entrances — `ExploreTopBar.tsx:52` and `ExploreFooter.tsx:62` —
link to `/docs/api` directly. So the front door of an area named _Docs_ is the
API reference, which is this amendment's own complaint one level up. Amendment 9
Q1 called `/docs` an address held open _"until an index page earns its place"_,
and the sub-area structure decided here is arguably what earns it.

It is left open here rather than settled quietly, because an index is a NEW PAGE
with content, a design and a card, and MOTIR-2307's boundary is the navigation of
the pages that exist. **It is filed as its own card rather than left as a
sentence** — the disposition this ADR gives every deferral. What would reopen it:
the first `/docs` sub-area that is not the API reference and not a single page,
i.e. whichever of MOTIR-2308 or MOTIR-2309 ships more than one page.

**Whether a sub-area other than the API gets a second-tier index** (a CLI command
list, an MCP tool list). Q2 states that a sub-area's second tier is that
surface's own index _where it has one_; whether the CLI wants one is the CLI
story's question, answered against its own content.

#### Consequences of this amendment

- **MOTIR-2311** (design) draws the two-tier rail against the shipped surface —
  the rail on an API page beside the rail on a guide page — plus the access path
  between them. Its asset area stays `design/api-docs/` per the addresses-move
  rule above.
- **MOTIR-2312** (code) implements Q1's two tiers and Q2's prefix test, performs
  Q3's two route moves, and rewrites `DOCS_REDIRECTS` to the seven-rule map with
  `tests/api-docs/docs-redirects.test.ts` updated to match it exactly.
- **MOTIR-2313** (E2E) drives the recipe: no operation rows on `/docs/sandbox`,
  the door between a guide and the reference walked by CLICKING it, and every
  rule in the redirect map resolved for real.
- **Amendment 4 Q4's route line and Q5's opening** gain `⚠️ Amended` pointers to
  this amendment; their bodies are not rewritten, which is the shape every
  amendment here keeps.

### Amendment 12 (2026-08-06) — the CLI documentation is ONE page at `/docs/cli`; its command table DERIVES from a pure command catalog the CLI itself builds from

**Amends:** nothing. It APPLIES Amendment 11 Q4's placement rule and answers the
two questions Amendment 11 left open for this story — whether the CLI sub-area
carries a second-tier index (Q2's _"where it has one"_), and, one level down,
what Amendment 9 Q3's single-importer invariant becomes when a second page needs
to read the CLI.
**Leaves unchanged:** §1–§9 in full; **Amendment 4 Q3 — the spec stays at
`/api/openapi/v1.json`**; **Amendment 9 Q1's `/docs` rename and its
addresses-move rule** and **Q2's first-run ownership rule**, both APPLIED here
rather than re-opened; **Amendment 11 Q1's two-tier rail, Q2's route-prefix test
and Q3's redirect map**, none of which this touches. Amendments 1, 2, 3, 5, 6, 7,
8 and 10 in full. **No `/api/v1` shape, path, scope or status changes here.**
**Card:** MOTIR-2322, under Story MOTIR-2308 (the published CLI documentation).

#### The problem

`@motir/cli` is published to npm — `packages/cli/package.json` names it
`@motir/cli` and ships `files: ["dist"]` — and everything written about how to
use it is `docs/cli.md`, 1,147 lines inside this repository. The product already
points at the gap:
`app/(authed)/settings/account/_components/ConnectCliPanel.tsx` prints
`npm install -g @motir/cli` and then offers **"Read the CLI guide"** at
`https://github.com/moooon-B-V/motir-core/blob/main/docs/cli.md`. A person is
handed a tool and then handed off to its source repository to learn it.

Amendment 11 Q4 already settled WHERE such a page goes, and named this story
while doing it: _"MOTIR-2308's CLI documentation is `/docs/cli` if it is one page
and `/docs/cli/_` if it is several."\* So placement is an application, not a
decision. What is genuinely open is the DERIVATION SEAM, and it is open because
Amendment 9 Q3 closed it deliberately:

> **`lib/apiDocs/sandbox.ts` is the ONLY module under `app/` or `lib/` that
> imports from `packages/cli/**`.\*\*

That is not prose. `tests/api-docs/sandbox-page.test.tsx:200` asserts the
offender list as an **exact array**, `['lib/apiDocs/sandbox.ts']`, so a second
importer fails a shipped test by construction. A CLI page that derives its
command list must therefore either widen a recorded invariant or reach its facts
another way — and the module it would want is not import-safe. Read on
`origin/main` this pass:

| Module                              | Imports                                                                               | Import-safe from `app/` or `lib/`? |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------- |
| `packages/cli/src/program.ts`       | `commander`, `./version.js`, every module under `src/commands/`                       | **No** — the whole CLI graph       |
| `packages/cli/src/help.ts`          | `commander`, `./agentProfiles.js`, `./errors.js`, `./output.js`, `./serverResolve.js` | **No**                             |
| `packages/cli/src/serverResolve.ts` | `./errors.js`, `./config/linkConfig.js`, `./config/userConfig.js`                     | **No**                             |
| `packages/cli/src/agentProfiles.ts` | `node:path`                                                                           | **Yes** — which is why Q3 chose it |

The one module the app is already allowed to reach is the one that imports
nothing but `node:` builtins. That is the shape, and this amendment supplies a
second module of it rather than inventing a different mechanism.

---

#### Q1 — the CLI documentation is ONE page at `/docs/cli`, with no second-tier rail index

##### The decision

**`/docs/cli`, one page, one row in the rail's surface tier, and no second
tier.**

Amendment 11 Q4's rule decides the first half on the page's content: _"a surface
earns a prefix when it has more than one page; with one page it IS
`/docs/<surface>`."_ And Amendment 9 Q2 already bounds the content — the page
owns the reader's FIRST SUCCESSFUL RUN and hands everything after it to the
reference. Applied to the CLI, the first run is:

install · `motir login` · `motir link` · `motir doctor` · see the ready set ·
dispatch one item · where the credential and the link file live · the hand-offs.

That is one page. The 1,147-line reference stays `docs/cli.md`, which the page
links rather than absorbs.

The second half — no second tier — is Amendment 11 Q2 applied honestly. Its
generalisation is that _"a sub-area's second-tier navigation is whatever that
surface's own index is"_, and a second tier lists a surface's **pages**. The CLI
surface has one page, so a second tier would either list that page (a rail row
pointing at the rail's own row) or list the page's HEADINGS, which is a table of
contents and a different thing wearing the tier's clothes. The command table is
therefore a SECTION of the page, not a rail. If the CLI ever earns a second page
— a recipes page, an unattended-loop page — that page creates the prefix, moves
this one inside it as the index, and the tier arrives with real rows.

##### Rejected alternatives

| Rejected                                                                                   | Why                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A `/docs/cli/*` sub-area now** — an index plus a per-command-group page                  | Splits a first-run PROCEDURE across pages a reader is meant to work down in order, and buys structure for content that does not exist. Amendment 11 Q4 makes growth the trigger for restructuring precisely so this is not decided from taste; today the CLI has one page's worth of first-run content.                     |
| **A second tier listing the command GROUPS** (SETUP / READ / WORK LOOP) as in-page anchors | Puts a table of contents in a rail whose two tiers mean _surfaces_ and _pages_. The API sub-area's second tier lists resources that are separately addressable; `#setup-commands` is not a page, and a rail that sometimes means "pages" and sometimes means "headings" cannot be read at a glance, which is its whole job. |
| **Publish the command reference in full** — `docs/cli.md` §§ _Command reference_ onwards   | 850 lines written for a reader who already has the tool working, including three run shapes, session-branch semantics and a failure policy. It fails Amendment 9 Q2's first limb (not needed for a first run) and, for the per-release parts, its second. The page carries the command TABLE and points at the rest.        |

---

#### Q2 — the page DERIVES the command tree from a new pure record, `packages/cli/src/commandCatalog.ts`, which `program.ts` BUILDS FROM

##### The decision

**Add `packages/cli/src/commandCatalog.ts`: a plain, `node:`-only, serializable
record of the CLI's command tree, which `packages/cli/src/program.ts` reads when
it registers each command. `lib/apiDocs/cli.ts` imports that record by relative
path and renders the table from it.**

This is Amendment 9 Q3's shape, reused rather than re-argued: the CLI declares a
fact once, in a module whose import graph is `node:` builtins, and the
documentation page reads the declaration instead of a copy of it. The property
that makes it worth the refactor is the same one Q3 chose it for — _a profile
added to `AGENT_PROFILES` must APPEAR on the page with no edit_ — restated for
commands: **a command added to the CLI appears in the published table with no
edit to any file the page owns.** That property survives the person who wrote the
page leaving, which is the only durable form of "keep the docs up to date".

##### What the record carries, and the one split inside it

| Fact                                        | Mechanism                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| invocation path (`login`, `auth status`, …) | **BUILT FROM** — `program.ts` registers from the record                        |
| one-line description                        | **BUILT FROM** — `program.ts` passes the record's string to `.description()`   |
| help group                                  | **BUILT FROM** — `HELP_GROUP` moves into the catalog; `help.ts` re-exports it  |
| each command's registered option flags      | **PINNED** — the record declares them; a CLI-side test asserts both directions |
| `DEFAULT_SERVER_URL`                        | **BUILT FROM** — moves into the catalog; `serverResolve.ts` re-exports it      |

The split is deliberate and is the only interesting line in this amendment.
_Built from_ is stronger — drift becomes structurally impossible — and it is
available wherever `program.ts` can consume the record without rewriting an
output surface. Descriptions and help groups qualify: they are strings
`program.ts` already passes through, so sourcing them changes where the literal
lives and nothing a user sees. **Option registration does not qualify.** Building
`.option(...)` calls from data would rewrite the flag order, the negated-boolean
spellings (`--no-browser`) and the per-flag descriptions that
`packages/cli/test/help.test.ts` pins as OUTPUT — a large, risky diff whose only
gain is over a failure a test already catches at the moment it is introduced. So
option flags are declared in the record and **pinned** by
`packages/cli/test/commandCatalog.test.ts`, which walks the real `buildProgram()`
tree and asserts agreement in both directions. That test can import `commander`
because it runs in the CLI's own environment —
`packages/cli/test/optionRegistrationAudit.test.ts` already does exactly this.

**Two constants move, and both are re-exported from where they live today**, so
no existing caller changes: `DEFAULT_SERVER_URL` (today in `serverResolve.ts`,
which imports two config modules and cannot be reached from the app) and
`HELP_GROUP` (today in `help.ts`, which imports `commander`). Recording the
`HELP_GROUP` move here is the point of writing this down: the record cannot carry
a command's help group while importing the module that declares it, and
discovering that mid-implementation is how a card acquires an unplanned import
cycle.

##### Rejected alternatives

| Rejected                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **(b) A parallel pure record PINNED to the real tree by a CLI-side test, with no `program.ts` refactor**          | The cheapest correct-today option, and it buys a weaker guarantee for a smaller diff. A command added to `program.ts` leaves the published table WRONG until someone edits the parallel record; the test turns that into a red build rather than a silent lie, which is real, but it is exactly the _"restate the table and assert it against the CLI"_ option Amendment 9 Q3 already weighed and rejected for the same reason: it does not make the page GROW with the tool. Adopted in part, for option flags only, where the refactor's cost flips the balance. |
| **(c) No derivation — type the command list and compare it against the built binary's `--help` output in a test** | Puts `packages/cli/dist` on the critical path of a documentation test, and on Vercel puts the CLI's build before the app's. Amendment 9 Q3 rejected the `exports`-subpath option for the same coupling, and a `--help` diff pins a rendering, not a fact: the curated surface's headings, wrapping and padding are commander's, so the test would fail on a commander upgrade that changed nothing about the CLI.                                                                                                                                                  |
| **Have the page fetch the command list from a running Motir server**                                              | The API does not expose one, and `lib/apiDocs/reference.ts:8`'s header already records why a page does not fetch its own product at build time: _"a network round trip, a failure mode and a bootstrapping problem for no gain."_                                                                                                                                                                                                                                                                                                                                  |
| **Generate a checked-in data module from `program.ts` with a script**                                             | A third artifact kept in step by a generator someone must remember to run — the two-artifact drift Story 11.4 exists to prevent, and rejected in these words by Amendment 9 Q3.                                                                                                                                                                                                                                                                                                                                                                                    |
| **Give `@motir/cli` an `exports` subpath and depend on it from the app**                                          | Unchanged from Amendment 9 Q3: `files: ["dist"]` makes a source-pointing export a dangling path for every npm consumer, and a `dist`-pointing one couples `next build` to the CLI being built first. Verified again this pass — `packages/cli/package.json`'s `exports` map is `{ "./package.json": "./package.json" }`.                                                                                                                                                                                                                                           |

---

#### Q3 — what the page DERIVES, and what it POINTS AT

##### The allocation

| The page states it by DERIVING                                         | Read from                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The command table — path, one-line description, help group             | `packages/cli/src/commandCatalog.ts`                                                                                     |
| Every command NAME and FLAG printed in the procedure's copyable blocks | the same record — a name or flag it does not carry fails the story gate                                                  |
| The install command's package name (`@motir/cli`)                      | `packages/cli/package.json`, as `tests/components/ConnectCliPanel.test.tsx` already reads it rather than trusting memory |
| The default server (`https://app.motir.co`), for the self-hosting note | `DEFAULT_SERVER_URL`, via the catalog                                                                                    |

##### And what it POINTS AT, with the reason named

Amendment 9 Q2's second limb is the test: _a fact whose truth cannot be asserted
by a check does not go on the page at all._ Four facts fail it, and the page
names the file for each rather than restating it — the shape Q3 used for the
vendor auto-approve flags:

| Not on the page                                    | Why it cannot be derived, and where it points                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The published CLI VERSION**                      | A per-release fact on a page no release lane edits — the MOTIR-2131 shape exactly. `npm install -g @motir/cli` needs no version, and the page says how to read one back (`motir --version`) instead of printing one.                                                                                                                                                                                                               |
| **The credential-resolution LADDER, rung by rung** | It is `resolveServerUrl`'s control flow, not a record: five rungs with an ambiguity branch and a canonical-host exception. Deriving it would mean parsing a function. The page states the ONE rung a first run needs — `--server` beats everything, the default is `DEFAULT_SERVER_URL` — and points at `motir help environment`, which the CLI already renders from its own code, and at `docs/cli.md` § _Files and environment_. |
| **What `motir doctor` CHECKS, check by check**     | The probe set is `doctor.ts`'s behaviour, and its agent-credential arm is `AGENT_PROFILES.credentialPaths` — which Amendment 9 Q3 established is NOT the same fact as a mount and is easy to publish wrongly. The page says what `doctor` is FOR and prints its invocation; the checks are the reference's.                                                                                                                        |
| **Anything about the sandbox image**               | Already published at `/docs/sandbox`, derived there. The page links it. Repeating it would create the second copy this whole amendment exists to prevent.                                                                                                                                                                                                                                                                          |

---

#### Q4 — the import boundary: Amendment 9 Q3's invariant becomes a TWO-module allowlist, not a wildcard

##### The decision

Amendment 9 Q3's first invariant is amended from one permitted importer to
**exactly two**, named individually. The other two invariants are unchanged and
now apply to both modules:

1. **`lib/apiDocs/cli.ts` and `lib/apiDocs/sandbox.ts` are the ONLY modules under
   `app/` or `lib/` that import from `packages/cli/**`.** Named, not patterned —
`lib/apiDocs/\*` as a rule would permit the next one without a decision, and
   the guard's value is that a third crossing is a deliberate edit someone has to
   justify in a diff.
2. **Each reaches a CLI module that imports nothing but `node:` builtins** —
   `agentProfiles.ts` (`node:path`) and `commandCatalog.ts` (nothing at all).
3. **What each EXPORTS is plain serializable data**, so a row may cross to a
   client component.

`tests/api-docs/sandbox-page.test.tsx`'s exact-array assertion therefore becomes

```ts
expect(offenders).toEqual(['lib/apiDocs/cli.ts', 'lib/apiDocs/sandbox.ts']);
```

**named here so nobody discovers it from a red test.** It is re-pointed, never
loosened: no wildcard, no `toContain`. The card that ADDS the second importer is
the card that amends it — MOTIR-2329 — and MOTIR-2333 asserts the final shape.

##### Why two, and why a number is the right bound at all

The invariant's job is not to keep the count at one; it is to keep every crossing
a decision. A page that documents a shipped tool must read that tool, and Motir
now documents two — the sandbox and the CLI — so the honest bound grows with the
documented surfaces rather than staying at a number that would force the next
page to lie or to copy. What does NOT grow is the second invariant: a crossing is
permitted only into a module with no dependency graph, which is the property that
keeps `commander` out of `next build`, and it is the one to refuse on when a
third request arrives.

---

#### Q5 — localization: recorded, not re-decided

Unchanged from Amendment 4 Q4 and Amendment 9 Q4. The page's long-form prose
lives as data in `lib/apiDocs/cli.ts`; the page CHROME goes through the `apiDocs`
next-intl namespace with `messages/en.json` + `messages/zh.json` parity. Command
names, flags, the package name and the default server URL are English by the same
rule that keeps operation text English: they are strings a machine consumes.

The design-asset area for this page is **`design/cli-guide/`** — a new content
area beside `design/agent-sandbox/`, not a rename of anything. `design/api-docs/`
keeps the docs shell and the two-tier rail, per Amendment 11 Q3's addresses-move
rule.

---

#### Consequences of this amendment

- **MOTIR-2324** (the command record) writes `packages/cli/src/commandCatalog.ts`
  as decided in Q2, moves `DEFAULT_SERVER_URL` **and `HELP_GROUP`** into it with
  re-exports from `serverResolve.ts` and `help.ts` so no caller changes, sources
  each command's description and help group in `program.ts` from the record, and
  adds `packages/cli/test/commandCatalog.test.ts` asserting two-directional
  agreement — commands, descriptions, help groups **and option flags** — against
  the real `buildProgram()` tree. `packages/cli/test/help.test.ts` and
  `packages/cli/test/optionRegistrationAudit.test.ts` pass unedited; that is the
  proof the refactor changed no output. **Option (a) won, so the card stands as
  written** — no re-scope and no archive is owed by this pass.
- **MOTIR-2326** (design) draws ONE page at `/docs/cli` with **no second tier**
  (Q1), the command table at desktop / tablet / 375px, and both entrances. The
  rail it draws is Amendment 11's two-tier rail with a fifth surface row; the
  sub-area tier is absent on this page, and the asset says so rather than leaving
  a reader to wonder.
- **MOTIR-2329** (the page) writes `lib/apiDocs/cli.ts` — the SECOND permitted
  importer — and is the card that amends
  `tests/api-docs/sandbox-page.test.tsx`'s offender array to the two-element form
  quoted in Q4, with this amendment named in the test's own comment. It renders
  the derived table, adds the rail's surface row, and links `/docs/cli` from
  `docs/cli.md`'s `## See also`.
- **MOTIR-2333** (the vitest gate) asserts the Q4 boundary in its final shape —
  an exact two-element set, both targets `node:`-only, both exports serializable
  — plus the truth gate against the record and the door-to-route seam.
- **MOTIR-2331** (the in-app door) and **MOTIR-2334** (E2E) are unaffected by
  this amendment beyond the route it fixes: `/docs/cli`.
- **`docs/cli.md` remains the reference**, per Amendment 9 Q2, and the only edit
  this story makes to it is the `## See also` link back.
- **Amendment 9 Q3's first invariant** now reads through this amendment; its body
  is not rewritten, which is the shape every amendment here keeps.

> **⚠️ Numbered 12, and a THREE-WAY number race is in flight — read this before
> merging.** Amendment 11 records the 10-vs-11 race it lost; this is the same
> thing one round later and wider. The last section on `origin/main` at authoring
> time was Amendment 11 and no OPEN pull request touched this file — which is
> exactly the wrong source, because the collisions are on branches with no PR
> yet. Checked across every unmerged branch after the fact:
>
> | Branch                               | Claims                                                |
> | ------------------------------------ | ----------------------------------------------------- |
> | `parent/MOTIR-2308-cli-docs` (this)  | **Amendment 12** — the CLI documentation              |
> | `parent/MOTIR-2309-mcp-docs`         | **Amendment 12** — the MCP is a `/docs/mcp` sub-area  |
> | `parent/MOTIR-1855-cli-v1-migration` | **Amendment 12** (counting a filtered set) **and 13** |
>
> None is merged. The remedy is the one Amendment 11 used and is **not** a
> blind renumber here — whoever merges SECOND (and third) renumbers to the next
> free number, records the race in its own header note, and adds a line saying
> anything citing the old number means that amendment. Every merge after the
> first will conflict at the append anchor, so the ordering is a decision for
> whoever holds the merge buttons, not something a branch can settle for itself.
>
> The three amendments do not contradict each other — the CLI and MCP ones apply
> Amendment 11 Q4's placement rule to different surfaces, and MOTIR-1855's is
> about `/api/v1` — so the conflict is textual, not substantive. **Anything
> elsewhere in this repository citing "Amendment 12" for the CLI documentation
> means THIS amendment, whatever number it ends up with**; the citations live in
> `packages/cli/src/commandCatalog.ts`, `program.ts`, `help.ts`,
> `serverResolve.ts`, `packages/cli/test/commandCatalog.test.ts`,
> `lib/apiDocs/cli.ts`, `tests/api-docs/`, and `design/cli-guide/design-notes.md`.

---

### Amendment 13 (2026-08-06) — the MCP is a `/docs/mcp` SUB-AREA whose second-tier index is the tool catalogue; the catalogue DERIVES its names, scopes and grouping from `TOOL_SCOPES`

> **⚠️ Numbered 13, not 12 — the three-way race Amendment 12's header records,
> resolved.** This amendment was authored as **Amendment 12**, on a branch whose
> base ended at Amendment 11. So were two others. Amendment 12's own header
> enumerates all three and states the remedy: whoever merges second renumbers to
> the next free number, records the race, and says what the old citation means.
> The CLI documentation (`parent/MOTIR-2308-cli-docs`) merged first and holds
> **12**; this one merged second and is **13**.
>
> The two do not contradict each other — they apply Amendment 11 Q4's placement
> rule to different surfaces — so the collision was textual, and nothing in
> either decision moved to resolve it. **Anything in this repository citing
> "Amendment 12" for the MCP documentation means THIS amendment, now 13.** Those
> citations were rewritten with the renumber and live in `lib/apiDocs/mcp.ts`,
> `tests/api-docs/`, `app/(public)/docs/mcp*`, and
> `design/mcp-server/design-notes.md`.
>
> **`parent/MOTIR-1855-cli-v1-migration` is still unmerged and still claims 12
> and 13.** Both are now taken; it renumbers to 14 and 15 when it lands.

**Amends:** Amendment 11's second open item — _"whether a sub-area other than the
API gets a second-tier index (a CLI command list, an MCP tool list)"_ — which is
now **closed for the MCP** (the CLI's half stays open, and stays MOTIR-2308's).
Amendment 11 Q1's rail gains a second sub-area with a second tier, and its route
inventory gains two NEW addresses; the tier model itself is applied, not changed.
**Leaves unchanged:** §1–§9 in full; Amendment 11 Q1's two-tier model, **Q2's
route-prefix rule for the `/api/v1` operation index** (which this amendment
applies to conclude that neither MCP page carries it), **Q3's redirect map**
(nothing moves here, so no rule is added), and **Q4's placement rule**, which is
APPLIED below rather than re-opened; Amendment 9 Q1's `/docs` rename and Q2's
first-run ownership rule, which Q3 below applies; **Amendment 7 in full** — the
MCP-versus-v1 pressure asymmetry and the payload derivation are the facts this
surface PUBLISHES, and it re-decides neither; Amendments 1–6, 8 and 10 in full.
**No `/api/v1` shape, path, scope or status changes here, and no MCP tool name,
argument, scope or payload changes here** — this amendment documents a shipped
surface and touches `lib/mcp/**` not at all.
**Card:** MOTIR-2321, under MOTIR-2309 (the MCP documentation story).

#### The problem

The MCP server is the surface the product is named after and the only one with no
public description at all. It is served at `POST /api/mcp`
(`app/api/mcp/route.ts`), it authenticates with a PAT a user mints in Settings,
and **39 tools** sit behind it (`MCP_TOOL_NAMES`, `lib/mcp/registry.ts`). Its
documentation is `docs/mcp.md` — **1,481 lines**, readable only by someone who has
cloned the repository. The in-app door makes the gap concrete:
`ApiTokensManager.tsx:31` sends a user who has just minted their first token to a
raw file on `github.com`.

Amendment 11 decided where such a page goes and deliberately left two things
open. This amendment settles them for the MCP, plus the one question that is
neither Amendment 11's nor the page's: **where the catalogue's facts come from.**
That last one is not a style question. `docs/mcp.md`'s tool catalog is **1,280 of
its 1,481 lines** (lines 157–1436), and a hand-maintained list of 39 tools sitting
beside a **generated** list of v1 operations on the same surface is a choice that
has to be defended or reversed — not drifted into.

---

#### Q1 — the MCP is a sub-area: `/docs/mcp` is the wiring page and index, `/docs/mcp/tools` is the tool catalogue

##### The decision, reached by APPLYING Amendment 11 Q4

Amendment 11 Q4's rule, quoted:

> **A documentation page lives under the prefix of the product surface it
> documents. A surface earns a prefix when it has more than one page: with one
> page it IS `/docs/<surface>`; the second page about that surface creates
> `/docs/<surface>/…`, moves the first inside it, and leaves a permanent
> redirect behind.**

The rule turns on ONE question — is this one page or two? — and it is answered
from the CONTENT, so answering it is the whole of Q1. **It is two.** The MCP
therefore earns its prefix immediately, and because nothing has shipped at
`/docs/mcp` yet, it earns it with **no move and no redirect**: the rule's
migration limb never fires for a surface that starts out as two pages.

| Page                         | Route             | What it is                                                                                                                              |
| ---------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP** (the sub-area index) | `/docs/mcp`       | What the MCP is; the MCP-versus-`/api/v1` fork; the endpoint, the credential and the scope it needs; one wired client; one working call |
| **Tools**                    | `/docs/mcp/tools` | The catalogue — every shipped tool, its gating scope and a one-line summary, grouped by scope. This surface's resource index            |

Both rows appear in the rail: `/docs/mcp` as the MCP's row in the **surface
tier**, and `/docs/mcp/tools` in the **second tier** that renders only inside the
sub-area — exactly the shape Amendment 11 Q1's tier table describes and
`/docs/api` already ships.

**Neither page renders the `/api/v1` operation index.** Amendment 11 Q2 decides
that by route prefix — _"a page renders the `/api/v1` operation index if and only
if it is inside the API sub-area"_ — and `/docs/mcp/*` is not. This is recorded
rather than left implied because the MCP page is the one page in the area whose
subject genuinely relates to the v1 operations (Amendment 7 derives its payloads
from their schemas), which is precisely the reasoning that would tempt an author
to make an exception.

##### Why two, on the evidence

Three readings, and they agree:

- **Proportion (rung 2, read not remembered).** In the reference this page fronts,
  the catalogue is **1,280 of 1,481 lines — 86%**. A section that is six-sevenths
  of the document is not a section.
- **The precedent on this very surface (rung 2).** The v1 reference earned
  `/docs/api` with its own second-tier navigation for an index of the same order:
  **38 operations today** — 13 work-item, 15 planning, 10 work-loop
  (`lib/api/v1/*/operations.ts`) — against **39 tools**. _(Amendment 11 says "~28";
  that was correct when written and Story 11.7's ten work-loop operations have
  landed since. The comparison it was making holds a fortiori: the two indexes are
  now the same size.)_ Treating 39 tools as a page section while 38 operations get
  a prefix would make the surface argue with itself.
- **The reader's two jobs.** Wiring an agent is a PROCEDURE — read once, top to
  bottom, done. Looking up a tool is an INDEX — returned to repeatedly, linked
  into, and scanned. Putting a procedure and an index on one page makes the
  procedure hard to finish and the index hard to find, which is the concrete form
  of what the proportion figure measures.

The mirror-product evidence Amendment 11 already recorded — Stripe, GitHub and
Cloudflare each putting an index of this size behind its own prefix with its own
navigation — is **cited here, not re-observed**. It was gathered for this exact
question one decision earlier.

##### The consequence this hands over, rather than dodges

**This makes the MCP the first `/docs` sub-area that is neither the API reference
nor a single page — which is verbatim the condition Amendment 11 recorded for
re-opening the `/docs` area ROOT.** So **MOTIR-2315** (_"the `/docs` index — the
front door of the documentation area is the area, not the API reference"_) is
reopened by its own trigger, on the day this ships. Two shipped entrances
(`ExploreTopBar.tsx:52`, `ExploreFooter.tsx:62`) and redirect rule 7 all still
land a reader on `/docs/api`, and with a third and fourth surface in the rail that
gets harder to defend, not easier.

**This amendment does not decide the index page.** It records that the trigger
fired and names the card that owns it — the disposition this ADR gives every
deferral.

##### Rejected alternatives

| Rejected                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) One page — `/docs/mcp` holds the wiring and the catalogue as anchored sections** (the sandbox guide's shape) | The sandbox guide is one page because it IS one page — a procedure with a seven-row profile table. This is a procedure plus a 39-row index that is 86% of the source document. Anchored sections do not fix that: an anchor is a way to reach part of a page, not a way to make a long page short, and the reader who wants the catalogue would still load the wiring guide to get it. |
| **(b′) Two pages, but the catalogue at `/docs/mcp` and the wiring at `/docs/mcp/getting-started`**                 | Inverts what the sub-area index is FOR. A reader arriving at `/docs/mcp` has not wired anything yet; landing them in a 39-row reference answers a question they have not reached. `/docs/api` puts the reference at the index because a reader there has usually already authenticated — the MCP reader has not.                                                                       |
| **Three pages — split the fork, the wiring and the catalogue**                                                     | The fork ("MCP or REST?") is three paragraphs and is the first thing a reader needs; a page they must click away from to start wiring adds a step to the only flow the surface has. Q4's rule earns a prefix on content, and there is not a third page's worth of content.                                                                                                             |
| **Defer to the design card**                                                                                       | Decides a route from what a mockup looks like. Q4's rule answers it from the page's content, and answering it here is what stops the design, the content module and the page card from each reaching a different answer.                                                                                                                                                               |

---

#### Q2 — names and scopes DERIVE from `lib/mcp/scopes.ts`; the summaries are AUTHORED and pinned to the shipped `tools/list`

##### The constraint that shapes the answer, read from the code

Two facts decide this, both `origin/main` @ `7ffa2ba4`:

- **`lib/mcp/scopes.ts` is safe for a public page.** It exports
  `TOOL_SCOPES: Record<McpToolName, TokenScope>` — **39 entries, total by
  construction** (a tool added to `MCP_TOOL_NAMES` without a scope fails
  typecheck) — and its **only** import is
  `import type { McpToolName } from './registry'`, which is **type-only and erased
  at build**. Importing it yields every tool NAME and every gating SCOPE and pulls
  in nothing at runtime.
- **`lib/mcp/registry.ts` is not.** It imports all 39 `lib/mcp/tools/*.ts`
  modules; `tools/getWorkItem.ts` alone imports `commentsService`,
  `projectsService` and `workItemsService`, and `workItemsService.ts:1-2` imports
  `@prisma/client` and `lib/db`. A page under `app/(public)/` that imported the
  registry would put **the service graph and the Prisma client into the dependency
  graph of an unauthenticated page**.

And the fact that makes this a split rather than a derivation: **a tool's `title`
and `description` are not data anywhere.** Each tool passes them as literals to
`server.registerTool(...)` (`lib/mcp/tools/whoami.ts:51-58` is the canonical
shape), so the only way to READ them is to import the module that also imports the
services.

##### The decision

**Derive what `TOOL_SCOPES` can give — every tool name, its gating scope, and the
grouping. Author the reader-facing one-line summaries in the content module, and
hold them true with a test, never with review.**

| Fact                                    | Source                                                         | Kind                 |
| --------------------------------------- | -------------------------------------------------------------- | -------------------- |
| The set of tools                        | `TOOL_SCOPES` keys (`lib/mcp/scopes.ts`)                       | **derived**          |
| Each tool's gating scope                | `TOOL_SCOPES` values                                           | **derived**          |
| The catalogue's groups + membership     | the tool's own scope — see the grouping decision below         | **derived**          |
| The scope legend, and the default grant | `TOKEN_SCOPES` and `DEFAULT_TOKEN_SCOPES` (same module)        | **derived**          |
| Each tool's one-line summary            | authored in `lib/apiDocs/mcp.ts` as a `Record<McpToolName, …>` | **authored, pinned** |

The summary map's `Record<McpToolName, …>` typing buys the same totality
`TOOL_SCOPES` has, for free: **a tool added to the registry with no summary is a
compile error in the content module**, and a summary for a tool that does not
exist is the same error from the other side. **No count is written as a literal** —
"39" appears in this dated decision record, never on the page; the page counts the
rows it derived.

`lib/apiDocs/mcp.ts` therefore imports **`lib/mcp/scopes.ts` and nothing else from
`lib/mcp/`**, directly or transitively. That is a boundary a test can assert, and
MOTIR-2330 asserts it.

##### The mechanism that holds an authored summary true

**A fingerprint pin, checked against the shipped surface.** The story's vitest
gate connects an in-memory `Client` to `buildMcpServer` over
`InMemoryTransport` — the pattern `tests/mcp/tool-coverage.test.ts` already uses,
in a test file where importing the registry costs nothing — reads `tools/list`,
and asserts three things:

1. **Set equality.** The names `tools/list` returns are exactly the keys of the
   authored map. Belt and braces over the compile-time totality, and the arm that
   catches a tool removed from the registry.
2. **Scope agreement.** Every catalogue row's scope equals `TOOL_SCOPES[name]` —
   pinning that the page reads the same map the gate enforces, not a copy.
3. **A fingerprint per tool.** The authored map carries, beside each summary, a
   short stable fingerprint of the shipped `title` + `description` the summary was
   written against. The test recomputes it from `tools/list` and fails when they
   diverge, naming the tool and saying what to do: **re-read the tool's
   description and re-write the summary.**

Limb 3 is the honest one, so it is worth stating what it does and does not
guarantee. It cannot prove a summary is GOOD — no test can. It proves the summary
was written against the description the server currently ships, which is exactly
the property Amendment 9 Q2's second limb asks for and exactly the failure mode
that has actually bitten this project: **not error, drift** (MOTIR-2010,
MOTIR-2131 — both correct on the day they shipped, both found later by a person).
The MCP surface is under Amendment 7's explicit licence to churn — _"rewording a
description or renaming an argument is how an agent's behaviour is tuned"_ — so
this page is documenting the one surface in the product that is EXPECTED to move
under it. A pin that turns that movement into a red build is the whole reason the
authored half is acceptable at all.

##### The grouping: by SCOPE, derived

**The catalogue groups by the tool's gating scope** — six groups, in
`TOKEN_SCOPES` order, with only the six group LABELS authored.

This is the `lib/apiDocs/reference.ts` pattern applied one surface over: its
`GROUPS` authors a label and an order and derives each operation's membership from
the operation's own data (its path). Here membership derives from the tool's own
scope, so **no per-tool grouping fact is authored** and a new tool lands in a group
the moment it has a scope — which is the moment it exists.

It is also the axis the reader is on. The page immediately above the catalogue
explains that a token carries scopes and that a call is refused when the tool's
scope is not granted; a catalogue grouped by scope answers the next question —
_"so what do I lose if I leave this one off?"_ — by construction. `docs/mcp.md`'s
own § _Token scopes_ table already presents the surface this way.

##### Rejected alternatives

| Rejected                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Import `lib/mcp/registry.ts` into the page and derive summaries from `description`**                                                 | The obvious move, and the reason for writing this section down: it pulls all 39 tool modules → the services → `@prisma/client` and `lib/db` into an unauthenticated public page's dependency graph. The tool descriptions are also written FOR AN AGENT — multi-sentence, argument-level — and would read as noise in a human's scan-and-choose table. |
| **Hand-maintain the whole catalogue, names included**                                                                                  | Puts a hand-typed list of 39 next to a generated list of 38 on the same surface, and makes a tool that ships undocumented a thing nothing can notice. The type system already refuses this for scopes; there is no reason to accept it for names.                                                                                                      |
| **Generate a build-time JSON artifact from the registry, and have the page read that**                                                 | Buys the same derivation with a generated file to keep in sync, a build step to run, and a new way to be stale — for a fact `TOOL_SCOPES` already hands over with a type-only import. `reference.ts`'s header rejects the neighbouring version of this (_"a page that fetched its own public URL…"_) for the same reason: no gain, new failure mode.   |
| **Assert each summary EQUALS the shipped `description`**                                                                               | Makes the summaries into copies of agent-facing prose, which defeats the point of authoring them, and turns Amendment 7's licensed churn into a red build for every reword whether or not the meaning moved.                                                                                                                                           |
| **Assert the summary's words appear in the description (a substring/keyword check)**                                                   | Passes on a summary that is confidently wrong and fails on one that is a good paraphrase. It measures vocabulary overlap and reports it as truth, which is worse than measuring nothing.                                                                                                                                                               |
| **Review, not a test**                                                                                                                 | The mechanism that failed twice already. Amendment 9 Q2's second limb exists to refuse exactly this answer.                                                                                                                                                                                                                                            |
| **Group by `docs/mcp.md`'s six prose groups** (_Reads & dispatch_, _Work-item writes_, _Search_, _Sprints_, _AI planning_, _Identity_) | A second hand-maintained ordering, living in a file this story does not own and cannot test, for a grouping the scope map gives derived. Its distinctions are also finer than the wiring reader needs — _Search_ is one tool.                                                                                                                          |
| **A declared `Record<McpToolName, CatalogueGroup>` map**                                                                               | Compile-total, so not unsafe — just 39 more authored facts than the scope axis needs, with nothing to hold them true. Six labels beat thirty-nine assignments.                                                                                                                                                                                         |

---

#### Q3 — the boundary against `docs/mcp.md`, and how much of the v1 framing the page owns

##### The rule, applied not re-derived

Amendment 9 Q2, quoted:

> **A fact belongs on the published page when a reader needs it to make their
> FIRST successful run happen, AND a test can hold it true. Otherwise it belongs
> in** [the reference].

`docs/mcp.md` stands where `packages/cli/sandbox/README.md` stood in Amendment 9:
the long-form reference written for someone who already has the repository. The
allocation below is that rule applied row by row, with the deciding limb shown.

##### The allocation

| The PAGE(s) own                                                                                                                                   | Decided by                                                                                     | `docs/mcp.md` keeps                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **What the MCP is**, in a paragraph, and the MCP-versus-`/api/v1` fork with its reasoning                                                         | limb 1 — it is the first choice a reader makes, and making it wrong is discovered months later | The architecture walk-through: the thin-adapter rule, the `ServiceContext` seam, the ASCII request diagram |
| **The endpoint** — `POST /api/mcp`, streamable HTTP only, stateless, never cached                                                                 | limb 1 + limb 2 — read from `app/api/mcp/route.ts`, and a test can pin it                      | Why `mcp-handler`, why a static path and not `[transport]`, why SSE is off                                 |
| **How to get a credential** — Settings → Account → API tokens, and that the plaintext is shown exactly once                                       | limb 1 — there is no first call without one                                                    | The token row's fields, the display prefix, the hash-storage detail, the full security list                |
| **The scope legend and the default grant**, derived from `TOKEN_SCOPES` / `DEFAULT_TOKEN_SCOPES`                                                  | limb 2 — derived, so it cannot drift                                                           | The scope→tool table as prose (the page's catalogue supersedes it for a reader)                            |
| **EVERY major client's wiring block** — Claude Code, Cursor, VS Code, Codex CLI, and a generic streamable-HTTP block, each with the bearer header | limb 1 — this IS the first run, and it is not one for most readers (see Q3a)                   | Nothing — it holds no client but Claude Code today                                                         |
| **One working call** and what a 401 looks like                                                                                                    | limb 1 — the reader has to know it worked                                                      | The full auth-failure taxonomy and the no-probing rationale                                                |
| **The catalogue** — every tool, its scope, one line each                                                                                          | limb 1 + limb 2 — derived names/scopes; summaries pinned by Q2's fingerprint                   | **The per-tool INPUT TABLES and output shapes** — 1,280 lines of argument-level reference                  |
| **A link to `docs/mcp.md`** for everything above, and a link back from it                                                                         | —                                                                                              | —                                                                                                          |

Two rows are worth their reasons.

**The per-tool input tables stay in the reference**, and this is the sharpest
application of limb 2 in the table. They are the surface Amendment 7 explicitly
licenses to churn — an argument renamed is a normal Tuesday — so publishing them
would put the fastest-moving facts in the product on the page least able to notice
they moved. The catalogue answers _"which tool do I want?"_; the reference answers
_"what does it take?"_, one click away, in the document that lives beside the code.

**The `PROD-<n>` example keys throughout `docs/mcp.md` are a known staleness**
(the project key is `MOTIR-<n>`), noticed while drawing this boundary and **not
fixed here** — MOTIR-2309's scope explicitly excludes rewriting the reference. It
is recorded because it is exactly the kind of fact limb 2 keeps off the page: a
literal example that nothing checks. The page's own worked call derives its key
from nothing — it uses the reader's own project.

##### Q3a — the client matrix: MORE than one client, and how a vendor-versioned fact is bounded

**Corrected 2026-08-06, same card, before the page was built.** This row first
read _"**One wired client** — the `.mcp.json` block and its `claude mcp add`
equivalent"_, against _"`docs/mcp.md` keeps every other client's wiring
variant."_ **Both halves were wrong**, and the second was wrong as a matter of
fact rather than judgement: `docs/mcp.md` § _Wiring an agent_ holds **Claude Code
and nothing else** — a `claude mcp add` line, the `.mcp.json` block it is
equivalent to, and a prose "any streamable-HTTP client" paragraph. There was no
"elsewhere" for the allocation to point at. The row described a division of
labour that did not exist, which is the failure mode this document's own
`⚠️ verify, don't cite` discipline exists to catch, committed in the table that
allocates by evidence.

The judgement half was wrong too. **Motir's pitch is that you hand work to an
agent, and it does not ship the agent** — the product's whole position is that
the reader brings their own. A page that wires exactly one vendor's client tells
every other reader that they are on an unsupported path, on the surface whose
entire job is to say _"bring your agent."_ One client is the right answer for a
first-run guide when there is one client; here the reader population is plural by
design.

**The decision: the page carries a wiring block per major client** — Claude Code,
Cursor, VS Code, Codex CLI — **plus the generic streamable-HTTP block**, which is
the one that actually covers the tail (Windsurf, Zed, Cline, Goose, a bespoke
agent) and which is therefore drawn as a first-class block rather than a
consolation paragraph.

**The tension this creates with limb 2, stated rather than dodged.** A third
party's config schema is a **vendor-versioned fact that no test of ours can hold
true** — the same shape as the sandbox's auto-approve matrix, which Amendment 9
Q2 pushed OFF the page for exactly this reason. The difference that changes the
answer is that the auto-approve matrix was a _nice-to-have comparison_ while
this is _the step_: a reader who cannot write the config has not had a first run
at all, so limb 1 is not merely satisfied, it is the whole page. Where the two
limbs genuinely conflict on a fact the reader cannot proceed without, **limb 1
wins and the staleness is BOUNDED rather than accepted**:

1. **Split the fact.** The parts that are OURS — the endpoint, that it is
   streamable HTTP only, the `Authorization: Bearer` header, the `motir_pat_`
   token shape — are stated ONCE, above the blocks, and are the facts a test
   pins. Each client block is then a transcription of those four facts into that
   vendor's file format, so a stale block is wrong about **syntax**, never about
   Motir.
2. **Date it and link out.** Every block carries the date its format was checked
   and a link to that vendor's own MCP documentation, so a reader who hits a
   mismatch knows the block is a convenience and where the authority is.
3. **Prefer each vendor's INDIRECTION over a pasted secret.** Where a client
   supports it, the block uses it — VS Code's `inputs` + `${input:…}` prompt,
   Cursor's `${env:…}` interpolation, Codex's `bearer_token_env_var` (which takes
   the variable's NAME, not the token). This is not a security aside: the guide
   that tells a reader to paste a live PAT into a file their repository tracks
   has taught them the wrong habit in the first five minutes.

**Formats verified against each vendor's own documentation, 2026-08-06** (rung 2
for a third party's surface — read, not recalled):

| Client          | File                                          | Shape                                                                         |
| --------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| **Claude Code** | `.mcp.json`, or `claude mcp add`              | `mcpServers` → `type: "http"`, `url`, `headers`                               |
| **Cursor**      | `~/.cursor/mcp.json` · `.cursor/mcp.json`     | `mcpServers` → `url`, `headers`; supports `${env:VAR}` interpolation          |
| **VS Code**     | `.vscode/mcp.json`                            | `servers` → `type: "http"`, `url`, `headers`; `inputs` + `${input:id}` prompt |
| **Codex CLI**   | `~/.codex/config.toml` · `.codex/config.toml` | `[mcp_servers.NAME]` → `url`, `bearer_token_env_var` (a variable NAME)        |

**This does NOT re-open Amendment 9 Q2's rule.** The rule stands and still
decides every other row of the table above. What Q3a adds is the tie-break the
rule did not have: _when the two limbs point opposite ways on a fact the reader
cannot proceed without, limb 1 wins and limb 2 becomes a containment
obligation_ — split, date, link, and prefer the indirection. A future page
reaching for that tie-break owes the same three steps.

##### How much of the v1 framing the page states

**The page publishes the REASONING; Amendment 7 keeps the decision.** Concretely,
the page says: the two surfaces describe one domain; the MCP is meant to churn
because rewording a description is how an agent's behaviour is tuned, while
`/api/v1` must not because published clients break; **so pick the MCP for an agent
you control and `/api/v1` for a client you ship**. It adds the one fact that makes
the pair credible rather than merely different — MCP payloads DERIVE from the v1
response schemas (Amendment 7), so the two catalogues describe provably the same
shapes — and it links `/docs/api` for the other half.

It does **not** restate the amendment (the `outputSchema` analysis, the SDK
behaviour, the branded-payload chokepoint are all internal reasoning), and it does
not re-decide it. The Motir-internal shorthand — _"`/api/mcp` is for agents,
`/api/v1` is for the CLI and third parties"_ — is a summary of a conclusion and
**is not what gets published**; a reader who is handed a slogan cannot tell whether
their case is the exception.

##### Rejected alternatives

| Rejected                                                                                        | Why                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Publish `docs/mcp.md` wholesale as the page**                                                 | 1,481 lines written for someone with a checkout, 1,280 of them argument-level reference that Amendment 7 licenses to churn. It moves the clone requirement rather than removing it — Amendment 9 Q2's own rejection, one surface over.                                                                                |
| **Wire ONE client (Claude Code) and send everyone else to the generic block**                   | The original answer here, corrected in Q3a before the page was built. It fails limb 1 for most of the audience — Motir does not ship the agent, so the reader brings their own — and it was resting on a false premise: `docs/mcp.md` holds no other client's wiring either, so there was nowhere to send them.       |
| **Carry no client blocks at all — state the four transport facts and let the reader transpose** | Maximally durable and maximally useless. The four facts ARE the whole content of each block; refusing to write them down in the four formats readers actually use saves this document from ever being stale by making the reader do transcription that we can do once. Q3a's dating and links bound the risk instead. |
| **Put the per-tool input tables on `/docs/mcp/tools`**                                          | The highest-churn facts on the page with no mechanism to notice they moved, and a 39-row scan turned into a 1,280-line document. If a reader needs the arguments they are one link from them, in the file that ships beside the code.                                                                                 |
| **Retire `docs/mcp.md` and make the page the only reference**                                   | Deletes the in-repo document an agent working in this repository reads, to remove a duplication the link already resolves. Reference stays reference; MOTIR-2309's boundary says so.                                                                                                                                  |
| **State the shorthand and link Amendment 7 for the reasoning**                                  | The shorthand is the conclusion with the reasoning removed — the one part a reader choosing between two surfaces actually needs. Linking an internal ADR from a public page also publishes an internal document by reference.                                                                                         |

---

#### Consequences of this amendment

- **MOTIR-2323** (design) draws two surfaces, not one — `/docs/mcp` and
  `/docs/mcp/tools` — plus the MCP's row in the surface tier AND the second tier
  that renders inside the sub-area, at every viewport, in `design/mcp-server/`. It
  also draws both doors: the rail, and the API-tokens panel's link.
- **MOTIR-2325** (`lib/apiDocs/mcp.ts`) implements Q2's split: derive from
  `TOOL_SCOPES`, author the summaries as a `Record<McpToolName, …>` with their
  fingerprints, group by scope with six authored labels, import nothing else from
  `lib/mcp/`, write no count as a literal. **It also carries Q3a's client
  matrix** — one wiring block per client, each declaring the vendor's file path,
  its `checkedOn` date and its documentation URL, with the four transport facts
  held ONCE and interpolated into every block so a client cannot disagree with
  the endpoint.
- **MOTIR-2330** additionally asserts Q3a's containment: every client block
  carries a `checkedOn` date and a vendor link, and the endpoint / header / token
  shape in each block equals the single source above them (a block that
  hard-codes its own URL is a red build).
- **MOTIR-2327** (the pages) ships **two** routes under Q1's table, adds the
  surface-tier row and the second tier, and renders the `/api/v1` operation index
  on neither.
- **MOTIR-2328** (the in-app door) re-points `MCP_GUIDE_HREF` at `/docs/mcp` — the
  wiring page, not the catalogue — and adds `docs/mcp.md`'s link back.
- **MOTIR-2330** (the vitest gate) owns Q2's three assertions and the
  registry-import boundary.
- **MOTIR-2332** (E2E) drives Q1's two addresses from the rail with no session,
  and the door from the tokens panel.
- **MOTIR-2315** (the `/docs` area root) is **reopened by its own recorded
  trigger** — see Q1's consequence. Nothing in this amendment decides it.
- **Amendment 11's second open item** gains a `⚠️ Amended` pointer to Q1 above;
  its body is not rewritten, which is the shape every amendment here keeps.
