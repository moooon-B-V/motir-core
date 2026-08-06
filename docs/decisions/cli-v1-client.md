# `@motir/cli` is a generated, validating client of `/api/v1`

**Status:** accepted · **Story MOTIR-1855 · Subtask MOTIR-2209**

This record settles the five contracts Story 11.5 would otherwise settle five
times, once per card. It **cites** `public-api-conventions.md` rather than
amending it — the server contract is not what changes here — with one exception
recorded explicitly in Q2, where a sentence of that ADR's Amendment 4
consequences list is narrowed rather than followed.

## Context

`packages/cli` reaches the Motir server through **one file**:
`packages/cli/src/mcpClient.ts` is the only module under `packages/cli/src` that
imports `@modelcontextprotocol/sdk` or touches `callTool` / `structuredContent`.
Every one of the 32 call sites in `src/commands/` goes through `MotirClient`'s
methods, and `src/render.ts` never sees a wire value at all. So the migration is
a rewrite of one class's innards — and, precisely because it is that contained,
the interesting questions are all about the _shape of the seam_, not about the
commands.

Three properties of what ships today are what the five questions are answering:

1. **Responses are CAST, not parsed.** `callStructured` returns
   `result.structuredContent as T` against ~20 hand-written mirror interfaces.
   A server that renames a field produces `undefined` in a rendered table — a
   blank cell, no error, and no way for anyone to notice.
2. **The auth path reads prose.** `isUnauthorized` matches
   `/\b401\b|unauthorized/i` against an error _message_, which exists only
   because MCP reports auth failures in band. Over HTTP the status is the
   signal, and the regex becomes a liability the moment a legitimate error
   message contains the word.
3. **The CLI is published independently of the server.** A user runs
   `npm install -g @motir/cli` and points it at whatever Motir they have. The
   two versions are not deployed together and never will be.

`/api/v1` itself is settled: `withV1Route` is the single wrapper (auth →
rate-limit → handler), `lib/api/v1/errors.ts` owns the `{ code, error }`
envelope and the domain-code → status map, and Story 11.4 ships an OpenAPI 3.1
document emitted from the same `zod/v4` schemas the routes return, served at
`/api/openapi/v1.json`. Story 11.7 has landed the work-loop operations, so every
method `MotirClient` exposes now has an endpoint.

---

## Q1 — `openapi-typescript` for types, Ajv **standalone** for runtime validation

### The decision

Two generators over **one** document (`emitOpenApiDocument()`), producing two
committed artifacts:

| artifact                                       | produced by                                                | what it is                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/src/api/schema.d.ts`             | `openapi-typescript`                                       | the `paths` / `components` type tree; every wire type the client names is an indexed lookup into it                      |
| `packages/cli/src/api/validators.js` + `.d.ts` | `ajv` (2020-12 dialect) compiled via `ajv/dist/standalone` | one exported validator per OPERATION success body, as plain JS                                                           |
| `packages/cli/src/api/operations.ts`           | the same generator script                                  | the operation table: `operationId → { method, path, scope, successStatus, responseComponent }`, read off `x-motir-scope` |

**Exact packages** (both **root** `devDependencies`, neither shipped):
`openapi-typescript` (v7, which targets OpenAPI 3.1 natively) and `ajv` (v8,
whose `ajv/dist/2020` entry point is the JSON-Schema-2020-12 dialect the
document is already written in, per Amendment 4 Q1).

**Exact build step:** `scripts/generate-cli-api.ts`, run from the repo root as
`pnpm generate:cli-api` (`tsx --tsconfig tsconfig.node.json`, the invocation
every other root script under `scripts/` already uses). It imports
`emitOpenApiDocument()` from `@/lib/api/v1/openapi/emit`, hands the document to
`openapi-typescript`'s programmatic API for the types, registers every
`components/schemas` entry on a single `Ajv2020` instance for `$ref`
resolution, and emits the standalone module with `esm: true`. It writes only
into `packages/cli/src/api/`. See Q2 for where the output lives and what keeps
it honest.

> **Why the script and its dependencies live at the ROOT rather than in
> `packages/cli`.** The generator's input is `emitOpenApiDocument()`, which is
> app code behind the `@/` alias — a script inside `packages/cli` cannot resolve
> it, and a workspace package cannot depend on the app that depends on it
> without a cycle. `packages/cli` keeps a `generate:api` script that delegates
> to the root one, so the command is discoverable from the package a reader is
> standing in, and the generated output still lands only under
> `packages/cli/src/api/`.

Two details that are decisions, not incidentals:

- **All schemas go onto ONE `Ajv2020` instance before compiling.** The emitter
  composes paged responses as `allOf: [$ref envelope, { items narrowing }]`
  (`emit.ts`'s `responseBodySchema`), so a validator compiled in isolation
  cannot resolve its own envelope reference.
- **Unknown `format` keywords are ignored, EXPLICITLY.** `z.toJSONSchema()`
  emits `format` on some strings; `ajv-formats` is deliberately **not** added.
  A wrong `date-time` string is not the failure this gate exists to catch, and
  a validator that rejects a legal-but-unusual date would turn a cosmetic
  server change into a hard CLI failure. The generator therefore passes
  `strictSchema: false` and no format library — stated here so the omission
  reads as a choice rather than an oversight.

### Why — and its honest cost

Ajv's error objects carry `instancePath` and `keyword`, which _is_ the story's
third acceptance criterion ("a precise error naming the field") without any
translation layer. Standalone mode means the published tarball ships neither
Ajv nor a schema blob: the validators are ordinary JavaScript functions. And
both generators read the same document the server emits, so there is exactly one
source and a diff is a real disagreement.

The costs, stated rather than glossed:

- **Two build steps and two committed artifacts** where a zod-regenerating
  approach would have one.
- **`validators.js` is machine-written, unreadable in review, and BIG** — 1.7 MB
  as generated (measured, 38 operations over 24 components), beside a 437 KB
  `schema.d.ts`. Nobody will ever read that diff, which is exactly why Q2(c)'s
  regenerate-and-compare guard, not human review, is what makes it trustworthy.
  Two decisions in the generator hold the number down and are worth keeping:
  `allErrors: false` (Ajv's default — the CLI names ONE field, and `allErrors`
  roughly triples the source), and exporting a validator per OPERATION only,
  with the components reachable through `$ref` rather than compiled a second
  time. `tsup` tree-shakes what the transport does not import, but the shipped
  bundle will still grow by several hundred KB; dropping
  `@modelcontextprotocol/sdk` in 11.5.6 is what pays for it, and 11.5.10 should
  state the net change in the changelog rather than let it pass unremarked.
- **Types and validators can in principle disagree** (two generators, one
  document). They cannot drift _from the server_, which is the drift that
  matters, but a bug in either generator is invisible until a payload hits it.
  Subtask 11.5.7 asserts the pairing on at least one real payload per operation.

### Rejected alternatives

| Rejected                                                                | Why it lost                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`openapi-zod-client` / `orval` — regenerate `zod` from the document** | Round-trips zod → JSON Schema → zod, a lossy re-translation of shapes `z.toJSONSchema()` produced in the first place, and puts a second zod dialect between the server's schema and the client's. |
| **Import the server's `zod` schemas directly into `packages/cli`**      | They are app code behind the `@/` alias and import from `lib/services/*`; a published npm package cannot depend on the Next app, and a user installing the tarball has no repo.                   |
| **TypeBox compiled validators**                                         | Same shape as Ajv, but requires re-expressing the document in a second schema dialect for no gain.                                                                                                |
| **Hand-written types plus hand-written runtime guards**                 | The exact defect the story exists to delete, reintroduced as two artifacts drifting instead of one generated.                                                                                     |
| **Types only, keep the `as T` cast**                                    | Fails the story's third acceptance criterion outright: a renamed field stays a silently-blank cell.                                                                                               |
| **Validate with the document fetched at runtime**                       | Ships a validator library and a schema blob to every installer, and makes every command's first act a spec download.                                                                              |

---

## Q2 — generate in-process from the emitter; COMMIT the output; two guards

### The decision

- **(a) Generate from `emitOpenApiDocument()` directly**, in-process, no
  network. The generator script imports the emitter.
- **(b) COMMIT the generated modules** under `packages/cli/src/api/`, so
  `pnpm build` in a fresh checkout, and `npm install` of the published tarball,
  need nothing but the repo.
- **(c) A CI guard regenerates and fails on a diff** — `pnpm generate:api &&
git diff --exit-code packages/cli/src/api`. This is what makes a committed,
  unreadable artifact trustworthy: it cannot be stale, and it cannot be
  hand-edited and survive.
- **(d) A second, separate guard asserts the SERVED route emits the same bytes
  as the emitter** — `JSON.parse` of `GET /api/openapi/v1.json`'s body deep-equals
  `emitOpenApiDocument()`. The route is `dynamic = 'force-static'` and does
  nothing but `NextResponse.json(emitOpenApiDocument())`, so this is one
  assertion, and it is what keeps the public URL honest for everyone who is not
  us.

(c) and (d) are deliberately **two** guards, not one. (c) says _our committed
client matches our emitter_; (d) says _our emitter matches what the world can
fetch_. Collapsing them would leave a world where the CLI is correct and the
published spec is wrong, or vice versa, with one green check either way.

### Reconciling with ADR Amendment 4 Q3

Amendment 4 Q3 decides **where the spec is served**, and this record does not
touch that: `/api/openapi/v1.json`, outside `app/api/v1`, anonymous, public API
under §8. What this record narrows is one sentence of that amendment's
**consequences** list:

> **11.5** generates the CLI's types from the Q3 URL and reads Q6's `info.version` for
> its skew gate.

That sentence was written for the generator Amendment 4 had in view — an
**external** one, belonging to an integrator with no access to our source. For
such a generator the URL is the only possible input, and Q3's own rejected
alternatives say so:

> **Publish only as a build artifact / repo file** (GitLab's shape) — §8 promises a
> stable URL a generator can fetch, and 11.5's CLI generation depends on it. A file
> in the repo is not fetchable by a client integrating against a running deployment.

That reasoning is about **publishing**, and it stands unchanged. It does not
follow that our own in-repo generator should fetch over HTTP, and the cost of
making it do so is concrete: `packages/cli`'s build would depend on a running
Next server — in CI, and for anyone who clones the repo and runs `pnpm build`.
A code-generation step that requires a live deployment of the thing it is
generating a client for is a bootstrap problem, not a design.

So: **the URL remains the contract for every external generator, and guard (d)
is what makes that promise real** — the served bytes are asserted equal to the
emitter's, so an integrator generating from the URL gets exactly what we
generated from the emitter. Amendment 4 Q3's decision is intact; its
consequences line is narrowed to "11.5 generates its types from the same
document the Q3 URL serves, and proves the two are identical."

### Rejected alternatives

| Rejected                                                                           | Why it lost                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Fetch `/api/openapi/v1.json` at build time** (Amendment 4's literal instruction) | Makes `pnpm build` in `packages/cli` depend on a running server, in CI and on a fresh clone.                                   |
| **Generate at install time / postinstall**                                         | Same dependency, moved to every user's machine, where it is worse.                                                             |
| **Generate into `dist/` and gitignore the output**                                 | The CI diff guard has nothing to compare against, so a stale generator becomes undetectable.                                   |
| **Generate into `node_modules` / a separate published package**                    | A second release lane and a second version to skew against, for one `.d.ts` and one `.js`.                                     |
| **One guard instead of two**                                                       | Leaves "our client matches our emitter" and "our emitter matches the public URL" indistinguishable; either can be false alone. |

---

## Q3 — nothing advertises the contract version; the gate probes the SPEC, on a mismatch it already detected

### The grep, and what it found

The card required this be verified rather than assumed. It was, on
`origin/main` @ `6d472611`:

```
$ grep -rn "V1_CONTRACT_VERSION\|V1_API_MAJOR" lib app tests packages
lib/api/v1/openapi/emit.ts:53   export const V1_API_MAJOR = 1;
lib/api/v1/openapi/emit.ts:64   export const V1_CONTRACT_VERSION = '1.0.0';
lib/api/v1/openapi/emit.ts:270  const major = options.major ?? V1_API_MAJOR;
lib/api/v1/openapi/emit.ts:271  const contractVersion = options.contractVersion ?? V1_CONTRACT_VERSION;
lib/apiDocs/reference.ts:2      import { toOpenApiSchema, V1_CONTRACT_VERSION } from '@/lib/api/v1/openapi/emit';
lib/apiDocs/reference.ts:301    contractVersion: V1_CONTRACT_VERSION,
tests/api/v1/openapi-registry.test.ts:148 …
tests/api-docs/reference-view-model.test.ts:70 …
```

**Outcome: NOTHING advertises it on a `/api/v1` response.** Specifically:

- **`withV1Route`** (`lib/api/v1/route.ts`) stamps exactly three header
  families on every exit path: `x-request-id`, and `x-ratelimit-{limit,remaining,reset}`
  from `rateLimitHeaders`. There is no version header.
- **`GET /api/v1/me`** returns `meSchema`, which is `.strict()` over exactly
  `{ user: { id, name, email }, workspaceId, scopes }`
  (`lib/api/v1/identity/schema.ts`). There is no version field, and `.strict()`
  means one cannot appear by accident.

The only surface carrying the number is the spec document itself, and the
reference page's view model — neither of which a v1 _response_ touches.

### What the card said to do, and why that is void

The card instructed: _"If nothing advertises it today, that surface is 11.7's to
add — `update_work_item` 11.7's acceptance criteria to carry it in THIS pass."_

**That instruction was written when 11.7 was open. It is now `done` and merged
(PR #1886, 2026-08-05).** Editing a shipped story's acceptance criteria would
change nothing about the running server and would leave this ADR resting on a
surface no card will build. Story 11.5's own boundary independently forbids the
alternative — _"does NOT change the server … every endpoint gap found by the
audit is 11.7's, and this story adds none."_

So the design below **requires no server change**, and it is the second of the
two shapes the card itself named: _"it compares only on a mismatch it already
detected."_ The "advertise it cheaply" surface remains a genuinely good idea and
is filed as its own card (see Consequences) rather than smuggled in here.

### The decision — a LAZY probe, triggered by a failure that has already happened

The generated artifact carries two build-time constants: `API_MAJOR` (`1`) and
`GENERATED_AGAINST` (the `info.version` of the document it was generated from,
`1.0.0` today).

**On the happy path the gate costs nothing — no header is read, no request is
made.** It is armed by, and only by, one of two observed failures:

1. **A boundary parse failure** — a 2xx body a generated validator rejects.
2. **A 404 whose body is NOT the v1 error envelope** — i.e. `{ code, error }`
   is absent, so Next returned an unrouted-path 404 rather than a domain
   `WORK_ITEM_NOT_FOUND`. That discriminator is what separates "this item does
   not exist" from "this endpoint does not exist."

On either trigger, **once per process** (a module-level latch), the client
fetches `GET {server}/api/openapi/v1.json`, reads `info.version`, and branches:

| observation                                             | verdict                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the spec is unreachable or unparseable                  | **no verdict.** Rethrow the original error unchanged — a probe failure must never become a skew diagnosis.                                               |
| `major(served) !== API_MAJOR`                           | **incompatible.** The CLI speaks a version this server does not serve.                                                                                   |
| same major, `minor(served) < minor(GENERATED_AGAINST)`  | **incompatible.** The server predates additions this CLI was generated against.                                                                          |
| same major, `minor(served) >= minor(GENERATED_AGAINST)` | **NOT skew.** §8 promises additive-only within a major, so the CLI's shapes must still parse. Rethrow the original parse error as the real defect it is. |

That last row is the load-bearing one: it stops the skew gate from becoming a
blanket excuse that launders a genuine server bug or a genuine CLI bug into
"upgrade something."

**"Incompatible" therefore means:** a major mismatch, **or** a server minor
behind the one the CLI was generated against _and_ a request that actually
failed. Within a major and forward in minors, §8's additive-only promise makes
the CLI compatible by construction, so no message is emitted for a newer server.

**Emitted ONCE per invocation**, before the underlying error, and it replaces
that error rather than accompanying it. The exact sentences:

- **Major mismatch** — message:
  `This CLI speaks Motir API v{API_MAJOR}, but {server} serves v{servedMajor}.`
  hint: `` Upgrade the CLI: `npm install -g @motir/cli@latest` ``
- **Minor behind** — message:
  `This CLI needs Motir API >= {GENERATED_AGAINST}; {server} serves {served}.`
  hint: `` Upgrade your Motir server, or install a CLI built for it: `npm install -g @motir/cli@<older>` ``

### Rejected alternatives

| Rejected                                             | Why it lost                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **A version header on every v1 response**            | Requires a server change; Story 11.5's boundary forbids one and its owner (11.7) has shipped. Filed as **MOTIR-2275** instead.       |
| **A `contractVersion` field on `GET /api/v1/me`**    | Same server change, and `meSchema` is `.strict()`, so it is a deliberate contract edit, not an addition.                             |
| **Fetch `/api/openapi/v1.json` on every invocation** | A spec download per command to read one string, on the path where nothing is wrong.                                                  |
| **Probe the spec once and cache it on disk**         | A cache with no invalidation signal — the server can be upgraded under it — trading a rare correct answer for a permanent stale one. |
| **Compare against the app's release version**        | Amendment 4 Q6 pins `info.version` as the _contract's_ number precisely because a release number churns on unrelated deploys.        |
| **Emit the message on every failed request**         | The story's fifth criterion asks for ONE clear message, not a per-field or per-call refrain.                                         |

---

## Q4 — a named adapter layer; wire types never reach a renderer

### The decision

Four layers inside `packages/cli/src`, with a one-way import rule:

```
src/api/          GENERATED ONLY — schema.d.ts, validators.js, operations.ts
src/transport.ts  fetch + bearer + boundary parse + status→error map + skew gate
src/adapters/     one function per operation: wire value → view model
src/viewModels.ts the CLI's OWN types — what render.ts consumes
src/render.ts     unchanged, forever
src/commands/     unchanged — they call MotirClient's 19 methods as they do today
```

- **`MotirClient` keeps its public method surface.** Same 19 names, same
  arguments, and each returns a **view model** — never a wire value. That is
  what makes "no command file changes" true rather than aspirational.
- **`src/viewModels.ts` is authored, not generated, and it is not a mirror of
  anything.** Its types are defined by what the renderers need. They are
  allowed to differ from the wire shapes in every particular, and the adapter
  is where that difference is expressed and reviewed.
- **`connect()` / `close()` collapse to no-ops behind the method surface** —
  kept only so the call sites that invoke them do not change, and removable in
  a later card once nothing calls them.

### The auditable rule

> **No file outside `src/transport.ts` and `src/adapters/` may import from
> `src/api/`.** A renderer, a view model, a command or `session.ts` naming a
> generated type is the defect, not a shortcut.

This is what makes the byte-identical promise checkable instead of asserted: if
no wire type can reach `render.ts`, then a server shape change can only ever
reach the renderer _through_ an adapter, where it is a visible edit. Subtask
11.5.7 asserts the rule mechanically over the import graph, alongside the
"`render.ts` is unchanged" diff assertion.

### Rejected alternatives

| Rejected                                                                   | Why it lost                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Renderers consume the generated types directly**                         | Makes every server shape change a `render.ts` change, which is precisely what this story forbids — and deletes the seam where byte-identity is kept. |
| **Adapt inside each `MotirClient` method, no separate layer**              | The mapping logic is the migration's real risk surface; burying it in 19 methods makes it untestable in isolation and unreviewable as a whole.       |
| **View models re-exported from the generated types (`type X = paths[…]`)** | A mirror by another name: the renderer's input silently changes whenever the wire does.                                                              |
| **Adapt in `render.ts` behind a shim**                                     | Changes `render.ts`.                                                                                                                                 |

---

## Q5 — the error taxonomy

Every failure the transport can produce, with the class raised, the exact
message and the exact hint. Three new classes join `CliError` / `AuthError` /
`NotLinkedError` in `packages/cli/src/errors.ts`; all extend `CliError`, so
`src/index.ts`'s existing clean-exit path is unchanged.

`{server}` is the resolved server URL; `{code}` / `{error}` are the v1 envelope's
own fields; `{requestId}` is the `x-request-id` header, present on **every** v1
response including errors.

| status / condition           | envelope `code`      | class                               | message                                                                      | hint                                                                        |
| ---------------------------- | -------------------- | ----------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **401**                      | `UNAUTHENTICATED`    | `AuthError` _(existing, unchanged)_ | `Token invalid or expired.`                                                  | ``Run `motir auth login` to authenticate.``                                 |
| **403**                      | `INSUFFICIENT_SCOPE` | `ScopeError` _(new)_                | `This token lacks the '{scope}' scope required for {operationId}.`           | `Create a token with the '{scope}' scope: Settings → Account → API tokens.` |
| **404**, v1 envelope present | any                  | `NotFoundError` _(new)_             | `{error}` — the server's own sentence                                        | ``Check the identifier, or run `motir ready` to list what you can reach.``  |
| **404**, envelope ABSENT     | —                    | _(skew probe, Q3)_                  | see Q3                                                                       | see Q3                                                                      |
| **402 · 409 · 412 · 422**    | any                  | `CliError`                          | `{error}` — the server's own sentence                                        | _(none — the server's sentence is the actionable one)_                      |
| **429**                      | `RATE_LIMITED`       | `RateLimitError` _(new)_            | `Rate limit exceeded. The budget refills at {resetAt as local time}.`        | `Retry in {resetAt − now} seconds.`                                         |
| **5xx**                      | —                    | `CliError`                          | `The Motir server failed ({status}). Request id: {requestId}.`               | `If it persists, quote the request id when reporting it.`                   |
| **network / DNS / TLS**      | —                    | `CliError`                          | `Could not reach {server}: {cause}.`                                         | ``Check the server URL and run `motir doctor`.``                            |
| **2xx, validator rejected**  | —                    | `ResponseShapeError` _(new)_        | `Unexpected response from {server} for {operationId}: {field} {ajvMessage}.` | ``Your CLI and this server may be out of step — run `motir doctor`.``       |
| **skew, major**              | —                    | `IncompatibleServerError` _(new)_   | see Q3                                                                       | see Q3                                                                      |
| **skew, minor behind**       | —                    | `IncompatibleServerError` _(new)_   | see Q3                                                                       | see Q3                                                                      |

Five things this table decides, each of which five cards would otherwise decide
differently:

1. **`{scope}` comes from OUR table, not from parsing the server's prose.**
   The emitted document carries `x-motir-scope` per operation
   (`lib/api/v1/openapi/security.ts`), so `src/api/operations.ts` knows the
   required scope for every call. Re-reading it out of an English sentence
   would be the `isUnauthorized` regex all over again.
2. **429 reports `x-ratelimit-reset`, and v1 sends no `Retry-After`** — by
   design (`lib/api/v1/openapi/headers.ts`: _"one absolute instant cannot go
   stale in transit the way a relative duration can"_). The header is **Unix
   epoch SECONDS**; the CLI renders it as a local time and derives the relative
   hint itself.
3. **The domain statuses (402/409/412/422) get NO CLI hint.** The server's
   `error` sentence is written for a human and is more specific than anything
   the client could add; a generic hint under it is noise.
4. **`AuthError`'s message and hint do not change.** The migration replaces
   _how_ a 401 is detected (status, not regex), not what the user reads.
   `isUnauthorized` is deleted with the MCP transport.
5. **`{requestId}` appears on the 5xx line only.** It is on every response, but
   it is actionable exactly when the failure is ours and opaque.
6. **`{field}` is NOT just `instancePath`** — verified against the real
   generated validators in 11.5.2, and the distinction is the whole criterion:
   - a wrong VALUE (`priority: 'urgent'`) reports `instancePath: '/priority'`;
   - a MISSING field reports the PARENT's path (`''`) with the name in
     `params.missingProperty`;
   - an UNEXPECTED field reports the parent's path with `params.additionalProperty`.

   A message built from `instancePath` alone therefore says
   _"` ` must have required property"_ for the case that matters most — a
   renamed server field, which is precisely the blank-cell failure this
   migration exists to end. So `{field}` is
   `instancePath + (params.missingProperty ?? params.additionalProperty ?? '')`,
   joined with `/`, and 11.5.3 asserts all three shapes.

### Rejected alternatives

| Rejected                                              | Why it lost                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Keep `isUnauthorized`'s message regex over HTTP**   | The status is the signal; a regex over prose false-positives on any error message containing "unauthorized". |
| **One `HttpError` class carrying the status**         | Every call site would re-branch on the number, which is the mapping this table exists to do once.            |
| **Rewrite the server's `error` sentence in the CLI**  | Two sentences for one condition, drifting; the server's is already user-facing.                              |
| **Add a `Retry-After` fallback for 429**              | v1 deliberately does not send one; reading a header the server never sets is dead code.                      |
| **Report a validator rejection as a bare `CliError`** | Loses `instancePath`, which is the entire point of parsing instead of casting.                               |

---

## Consequences

- **11.5.2** builds the Q1 generators and the Q2 artifact + both guards.
- **11.5.3** builds the transport core: the Q5 map, the Q3 gate, the boundary
  parse. It is where `ScopeError`, `NotFoundError`, `RateLimitError`,
  `ResponseShapeError` and `IncompatibleServerError` are added.
- **11.5.4 / 11.5.5** build the adapters and the methods under Q4's import rule.
- **11.5.6** deletes `@modelcontextprotocol/sdk`, `isUnauthorized` and
  `callStructured`.
- **11.5.7** asserts Q4's import rule over the graph, and the type↔validator
  pairing from Q1's stated cost.
- **MOTIR-2275 is filed for the server-side "advertise the contract version
  cheaply" surface** (Q3's rejected first option). It is a real
  improvement — it would turn the lazy probe into a free one — but it is a
  server change, 11.5's boundary forbids one, and its natural owner (11.7)
  shipped before this record was written. It is not a prerequisite for anything
  here: the lazy probe is correct on its own, and the header, when it lands,
  becomes a fast path in front of it rather than a replacement for it.

## Context refs

- `docs/decisions/public-api-conventions.md` — §5 pagination, §6 rate-limit
  headers, §8 additive-only, and Amendment 4 Q1 / Q3 / Q6.
- `docs/decisions/cli-login.md` — the precedent for a CLI-side ADR in its own
  file, and the credential this client presents.
- `lib/api/v1/openapi/emit.ts` — `emitOpenApiDocument()`, `V1_CONTRACT_VERSION`,
  `V1_API_MAJOR`, `toOpenApiSchema`'s `reused: 'inline'`, and the `allOf`
  envelope composition Q1's single-instance rule exists for.
- `lib/api/v1/openapi/security.ts` — `x-motir-scope`, the per-operation scope
  Q5 reads.
- `lib/api/v1/route.ts` — `withV1Route`; the three header families Q3's grep
  enumerates.
- `lib/api/v1/errors.ts` — the `{ code, error }` envelope, `UNAUTHENTICATED`,
  `INSUFFICIENT_SCOPE`, and the domain-code → status map Q5 mirrors.
- `lib/api/v1/rateLimit.ts` · `lib/api/v1/openapi/headers.ts` —
  `x-ratelimit-reset` as Unix epoch seconds, and why there is no `Retry-After`.
- `lib/api/v1/identity/schema.ts` — `meSchema`, `.strict()`, three fields.
- `app/api/openapi/v1.json/route.ts` — `force-static`, the bytes Q2(d) compares.
- `packages/cli/src/mcpClient.ts` — `isUnauthorized`, `callStructured`'s `as T`,
  and the 19 methods Q4 preserves.
- `packages/cli/src/errors.ts` — `CliError` / `AuthError` / `NotLinkedError`,
  which Q5 extends.
