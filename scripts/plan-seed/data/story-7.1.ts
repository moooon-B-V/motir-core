import type { SeedStory } from '../types';

/**
 * Story 7.1 — Core ↔ AI API contract (motir-core ↔ motir-ai) + motir-ai's
 * persistence foundation. THE foundation of Epic 7: every later AI story
 * (7.2 chat, 7.3 generation, 7.4 augment/re-plan, 7.5 retrieval, 7.6 prompt
 * gen, 7.7 GitHub, 7.10 mistakes) rides this boundary.
 *
 * **Locked architecture (decided across the 2026-06-11 planning discussion
 * with Yue; recorded here as the contract every 7.x story inherits).**
 *
 * 1. **One-directional WRITES, asymmetric reads.** motir-core is the system
 *    of record (Principle #8/#19). The AI NEVER writes the plan tree
 *    directly. motir-core calls motir-ai to GENERATE; motir-ai returns a
 *    tree-DELTA as structured data; motir-core persists it through its OWN
 *    shipped `workItemsService` (the 4-layer write authority — every 6.4
 *    permission + the 404-not-403 tenant guard applies unchanged). motir-ai
 *    holds no write credential to core.
 *
 * 2. **7.1 is a tool-use SESSION, not a one-shot call.** Planning context is
 *    non-local (a story in Epic 5 can depend on a decision in Epic 1) and
 *    can't be pre-enclosed, so motir-ai HOSTS the planning agent and emits
 *    READ requests mid-loop. The whole tree is *reachable* every job and
 *    *transmitted* never — a global skeleton for breadth + on-demand
 *    retrieval (incl. comments + history) for depth. This is the
 *    graph-traversal-not-RAG shape Atlassian Rovo uses (the Teamwork Graph:
 *    "graph lookup instead of a vector dump"); Motir's plan is ALREADY a
 *    relational graph (parent/child rollup + is_blocked_by DAG + comments),
 *    so it gets Rovo's model with no graph DB and no vector store. Rovo is
 *    the cited rung-1 mirror (verified, not asserted — notes.html #33).
 *
 * 3. **Async job model.** Because the session is a multi-step loop, the
 *    boundary is `submit → jobId → poll/stream status`, NOT a held streaming
 *    connection. One model serves BOTH the 7.2 web chat AND the headless
 *    MCP/CLI planning tools (7.3/7.4 via 7.9) — two co-equal front doors over
 *    one 7.1 boundary; a chat-streaming-only contract would make the headless
 *    path a second-class bolt-on.
 *
 * 4. **motir-ai is STATEFUL — headless ≠ stateless.** Principle #19 gives
 *    motir-ai no UI; it never said no DB. motir-ai owns its OWN datastore for
 *    the three context classes that have no home in an open PM tool — this is
 *    `motir-meta` productized, and it SHARPENS the open-core line (motir-core
 *    stays a complete exportable Jira clone with zero AI tables):
 *      - **Direction docs** (vision / discovery / feasibility), per project,
 *        generated in the 7.2 init chat — schema + write owned by Story 7.2.
 *      - **Planning-mistakes knowledge** (the `notes.html` analog), injected
 *        at plan time — owned by Story 7.10.
 *      - **Code graph** per repo (codegraph engine, GitHub-read-fed,
 *        webhook-refreshed) — owned by Stories 7.5 (store) + 7.7 (refresh).
 *    7.1 establishes only the DB FOUNDATION + the per-project identity spine
 *    + the job store; each content store lands with its owning story.
 *
 * **What 7.1 is and is NOT.** 7.1 ships the *pipe + the walking skeleton*:
 * the authenticated boundary, the async job substrate, motir-ai's DB
 * foundation, a MINIMAL internal read-back (get-project-tree) + the persist
 * callback, and a trivial end-to-end `noop` plan job that proves the whole
 * loop (core submits → motir-ai reads the tree → returns a no-op delta →
 * core persists) BEFORE any real AI. It is NOT the planner intelligence
 * (7.3), the rich graph-traversal retrieval / code graph (7.5/7.7), the chat
 * (7.2), or the mistakes store (7.10). It is the contract those ride.
 *
 * **No UI in 7.1 → the design gate does not fire.** Every endpoint is
 * server-to-server. The chat front door (7.2) and any rendering of direction
 * docs are 7.2's surfaces and carry their own design subtask; 7.1 adds no
 * user-facing pixels.
 *
 * **Cross-epic dep audit (notes.html #32): PASSES.** Every 7.1 leaf depends
 * only on same-story 7.1.x cards and already-shipped Epic-2 services
 * (`workItemsService`). The read-back deliberately uses a NEW minimal
 * internal endpoint, NOT the 7.8 MCP read tools, so 7.1 carries no
 * forward-pointing dep on 7.8 — 7.1 is the foundation and ships first.
 */
export const story_7_1: SeedStory = {
  id: '7.1',
  title: 'Core ↔ AI API contract + motir-ai persistence foundation',
  status: 'planned',
  gitBranch: 'feat/PROD-7.1-core-ai-contract',
  descriptionMd:
    'The documented HTTP boundary the open core calls into for every AI ' +
    'capability, plus the persistence foundation that makes motir-ai a ' +
    'stateful service. **All of Epic 7 rides this contract**, and it is ' +
    'shaped so a future native AI-coding executor plugs in behind the same ' +
    'dispatch shape (MOTIR.md § What Motir is).\n\n' +
    '**The boundary (locked, see the module header for the full rationale):**\n\n' +
    '- **core → ai**: submit a planning job (`POST /v1/jobs` → `202 ' +
    '{ jobId }`), poll/stream status (`GET /v1/jobs/:id` [+ `/stream`]). ' +
    'Async because a planning run is a multi-step tool-use loop, not a ' +
    'single completion. ONE model serves the 7.2 chat AND the headless ' +
    'MCP/CLI planners.\n' +
    '- **ai → core**: during a job, motir-ai READS the plan tree (a minimal ' +
    'internal `GET /api/internal/ai/plan-tree`, job-scoped-token auth) and ' +
    'REQUESTS the persist of its proposed tree-delta (`POST ' +
    '/api/internal/ai/plan-delta`), which motir-core commits through the ' +
    'shipped `workItemsService` — **the AI never writes the tree directly; ' +
    'write authority stays in core**.\n' +
    '- **motir-ai owns its own DB**: 7.1 stands up the datastore + a ' +
    'per-project identity spine + the `plan_job` store. The three content ' +
    'stores (direction docs / mistakes / code graph) are introduced by ' +
    'their owning stories (7.2 / 7.10 / 7.5+7.7).\n\n' +
    '**Scope:** the contract decision + envelope/error taxonomy (7.1.1); ' +
    "motir-ai's DB foundation + project identity (7.1.3); the async job " +
    'substrate + endpoints (7.1.4); the motir-core server-to-server client ' +
    '(7.1.5); the minimal internal read-back + persist callback (7.1.6); a ' +
    '`noop` end-to-end plan job that proves the loop (7.1.7); contract tests ' +
    'both sides (7.1.8); the documented boundary (7.1.9); and the ' +
    'provision/secret prerequisite (7.1.2).\n\n' +
    '**Out of scope (named so they land in their own stories, not here):** ' +
    'the planner intelligence + real issue-tree generation (7.3); the chat ' +
    'front door + direction-doc generation (7.2); rich graph-traversal ' +
    'retrieval, comments/history reads, and the code-graph store (7.5); the ' +
    'GitHub App read + webhook code-graph refresh (7.7); the ' +
    'planning-mistakes store + learning loop (7.10); per-type prompt ' +
    'generation (7.6).',
  verificationRecipeMd:
    '- **Boundary smoke (the contract).** With both services running ' +
    'locally (`motir-ai` on its dev port, `motir-core` on `:3000`, each ' +
    'pointed at the other via env): from a motir-core server context, submit ' +
    'a `noop` plan job for the `PROD` project → receive `202 { jobId }`; poll ' +
    '`GET /v1/jobs/:id` → it transitions `queued → running → succeeded`; the ' +
    'job result reports it READ the project tree and persisted a no-op delta ' +
    '(zero work items created/changed). This proves core→ai→(read tree)→ai→' +
    '(persist)→core end to end with no real AI.\n' +
    '- `pnpm test` (motir-core) + the motir-ai test suite — the contract ' +
    'tests in 7.1.8 cover: the envelope + error taxonomy round-trip; the job ' +
    'lifecycle state machine incl. a forced `failed`; the read-back ' +
    'job-scoped token (reads ONLY its own project; an expired/foreign token ' +
    'is rejected; 404-not-403 on a cross-tenant project); the persist ' +
    'endpoint commits through `workItemsService` (not raw Prisma) and honors ' +
    'every 6.4 permission; the service-credential auth rejects a missing/' +
    'blank token on both internal endpoints.\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** ' +
    'Confirm NO `motir-ai` import appears anywhere in `motir-core` (the call ' +
    'is over HTTP only), and motir-ai contains NO Prisma client for, or ' +
    "direct DB connection to, motir-core's database — it reaches the plan " +
    'tree ONLY through the 7.1 read-back endpoint. Browsers never call ' +
    'motir-ai.\n' +
    '- **Provisioning (7.1.2) confirmation.** The motir-ai datastore exists, ' +
    'the shared service credential is set on both sides, and the env keys ' +
    'named in 7.1.1 are present in each deployment — Yue confirms (no PR).\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    "fails, comment with what didn't work and Motir will produce a " +
    'follow-up Subtask under the same Story.',
  items: [
    {
      id: '7.1.1',
      title: 'Decision — the 7.1 contract: async job model, envelope, auth, error taxonomy',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** decision (the keystone ADR every other 7.1 card — and ' +
        'every later AI story — builds against). Produce a living contract ' +
        'document; no app behavior ships here, but the shapes it fixes are ' +
        'load-bearing.\n\n' +
        'Write `motir-ai/docs/contract.md` (the authoritative boundary spec, ' +
        'owned by the closed side; `motir-core` links it from a short ' +
        '`docs/ai-boundary.md` pointer). It MUST fix:\n\n' +
        '1. **Directions.** core→ai (submit/poll/stream a job) and ' +
        'ai→core (read plan tree + request persist). Diagram the asymmetry: ' +
        'writes are core-only; the AI proposes deltas.\n' +
        '2. **Async job model.** `POST /v1/jobs` → `202 { jobId }`; `GET ' +
        '/v1/jobs/:id` → `{ status, result?, error? }` with status in ' +
        '`queued | running | succeeded | failed | canceled`; optional `GET ' +
        '/v1/jobs/:id/stream` (SSE) for token/progress streaming the chat ' +
        'consumes. Define the `jobKind` enum (`noop` now; `generate_tree`, ' +
        '`expand_item`, `augment`, `replan` reserved for 7.3/7.4).\n' +
        '3. **Request/response envelope.** A versioned envelope (`v1`) ' +
        'carrying `tenant` (workspace+project identity), `jobKind`, a ' +
        'request-scoped `context` bag (discovery/code context land later), ' +
        'and the job-scoped read-back token (see auth). Result envelope ' +
        'carries the proposed tree-delta shape (the unit core will persist).\n' +
        '4. **Auth (two grants).** (a) a SERVICE credential for the ' +
        'core↔ai channel (a shared bearer / signed request — pick one, ' +
        'justify; mTLS deferred unless trivial); (b) a short-lived ' +
        'JOB-SCOPED token minted by core at submit, carried in the job, that ' +
        'motir-ai presents on the read-back endpoints — it encodes the ' +
        'requesting user + project so every read-back is permission-checked ' +
        'as that user, and it expires with the job.\n' +
        '5. **Error taxonomy.** A typed error union (problem+json style: ' +
        '`type`, `title`, `status`, `code`) shared by both sides, mapping ' +
        "core's typed service errors and motir-ai's job errors to stable " +
        'codes. List the env keys each side needs (so 7.1.2 can provision ' +
        'them): core — `MOTIR_AI_URL`, `MOTIR_AI_SERVICE_TOKEN`; ai — ' +
        '`DATABASE_URL`, `MOTIR_CORE_URL`, `CORE_CALLBACK_SECRET`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/docs/contract.md` exists and fixes all five sections ' +
        'above with concrete request/response JSON examples for `POST ' +
        '/v1/jobs`, `GET /v1/jobs/:id`, `GET /api/internal/ai/plan-tree`, ' +
        '`POST /api/internal/ai/plan-delta`.\n' +
        '- The async (not held-stream) model is justified in one paragraph ' +
        'citing the two-front-doors requirement.\n' +
        '- The env-key inventory is explicit (it is the input to 7.1.2).\n' +
        '- `motir-core/docs/ai-boundary.md` pointer exists and states the ' +
        'open-core invariant (browsers never call motir-ai; the AI never ' +
        'writes the tree directly).\n\n' +
        '## Context refs\n\n' +
        '- This module header (the locked architecture).\n' +
        '- `motir-ai/README.md` — the open-core boundary rationale (ADR-008, ' +
        'principle #19).\n' +
        '- MOTIR.md § "What Motir is" — the three-layer pipeline + the ' +
        'native-AI-coding extension seam.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the persist ' +
        'authority the delta commits through.',
      dependsOn: [],
    },
    {
      id: '7.1.2',
      title: 'Provision motir-ai datastore + the core↔ai service credential (manual)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 30,
      descriptionMd:
        '**Type:** manual/human (no PR — dashboard / secret / infra work, ' +
        'mirror 1.6.7; marked done on Yue’s confirmation). A coding ' +
        'agent cannot provision a database instance or mint a production ' +
        'secret. Wired here via `dependsOn` so the prerequisite is visible at ' +
        'PLAN time (notes.html #30), not discovered at run time.\n\n' +
        'Using the env-key inventory fixed by 7.1.1:\n\n' +
        '1. **Provision the motir-ai datastore** — a Postgres instance ' +
        'SEPARATE from motir-core’s DB (the open-core data boundary: ' +
        'motir-ai’s direction docs / mistakes / code graph live apart ' +
        'from the open PM substrate). For local dev a `docker-compose` ' +
        'Postgres suffices (added in 7.1.3); this subtask is the CLOUD ' +
        'instance for the deployed contract.\n' +
        '2. **Mint the shared service credential** (`MOTIR_AI_SERVICE_TOKEN` ' +
        '/ `CORE_CALLBACK_SECRET`) and set it on BOTH deployments.\n' +
        '3. **Wire env** on each side: core gets `MOTIR_AI_URL` + the service ' +
        'token; ai gets its `DATABASE_URL`, `MOTIR_CORE_URL`, and the ' +
        'callback secret.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A motir-ai Postgres instance exists (cloud), separate from ' +
        'motir-core’s.\n' +
        '- The shared service credential is set on both deployments and the ' +
        'two services can reach each other over HTTPS.\n' +
        '- All env keys from 7.1.1’s inventory are present in each ' +
        'environment.\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 7.1.1’s env-key inventory.\n' +
        '- `motir-core` Vercel/Neon setup (1.6.7) as the precedent shape for ' +
        'provisioning + secret wiring.',
      dependsOn: ['7.1.1'],
    },
    {
      id: '7.1.3',
      title: 'motir-ai persistence foundation — ORM + per-project identity spine',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Stand up motir-ai’s OWN database layer (it currently has only ' +
        'a Hono `src/index.ts` — no persistence). Introduce Prisma (matching ' +
        'motir-core’s ORM so the team carries one mental model), a ' +
        'local `docker-compose` Postgres, and the FOUNDATION schema only:\n\n' +
        '- **`AiProject`** — the per-tenant identity spine every motir-ai ' +
        'store hangs off: `{ id, coreWorkspaceId, coreProjectId, createdAt }` ' +
        '(mirrors a motir-core workspace+project by id; motir-ai never ' +
        'duplicates the plan tree, only references it). A unique on ' +
        '`(coreWorkspaceId, coreProjectId)`.\n' +
        '- (Tables for direction docs / mistakes / code graph are NOT added ' +
        'here — each lands with its owning story 7.2 / 7.10 / 7.5. This card ' +
        'is the spine + migration tooling, not the content stores.)\n\n' +
        'Establish the same layering motir-ai will reuse: a thin repository ' +
        'module per entity (single Prisma op) and a service layer — keep it ' +
        "lightweight but mirror motir-core's Route→Service→Repository spirit " +
        'so the closed repo is legible to the same team. Add `pnpm migrate` / ' +
        '`pnpm prisma generate` scripts and a `.env.example`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/schema.prisma` exists with the `AiProject` model ' +
        'and a first migration; `pnpm prisma generate` + `pnpm migrate` run ' +
        'clean against the local docker Postgres.\n' +
        '- `motir-ai/docker-compose.yml` brings up a local Postgres for dev/' +
        'test (mirror motir-core’s).\n' +
        '- A repository + service pair for `AiProject` (find-or-create by ' +
        'core ids) with a unit test.\n' +
        '- `.env.example` lists `DATABASE_URL`, `MOTIR_CORE_URL`, ' +
        '`CORE_CALLBACK_SECRET` (the keys 7.1.1 fixed).\n' +
        '- No motir-core DB connection string anywhere in motir-ai — the ' +
        'plan tree is reached only via the 7.1 read-back, never a shared DB.\n\n' +
        '## Context refs\n\n' +
        '- `motir-ai/src/index.ts`, `motir-ai/package.json` — the current ' +
        'Hono skeleton to extend.\n' +
        '- `motir-core/prisma/schema.prisma` + `motir-core/docker-compose.yml` ' +
        '+ `motir-core/CLAUDE.md` § 4-layer — the patterns to mirror ' +
        '(lightly) on the closed side.\n' +
        '- 7.1.1 § envelope (the `tenant` identity the spine encodes).',
      dependsOn: ['7.1.1'],
    },
    {
      id: '7.1.4',
      title: 'Async job substrate — `plan_job` store + submit/status/stream endpoints',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the async job engine in motir-ai (the spine of every planning ' +
        'run). Durable + self-hostable — a Postgres-backed job table + an ' +
        'in-process worker loop, NOT an external queue SaaS (keeps ' +
        'self-hosting one-binary; a real broker can swap in behind the same ' +
        'interface later — no shortcut, just no premature SaaS dependency).\n\n' +
        '- **`PlanJob`** model: `{ id, aiProjectId, kind, status, ' +
        'requestJson, resultJson?, errorJson?, createdAt, startedAt?, ' +
        'finishedAt? }`; `status` machine `queued → running → ' +
        '{ succeeded | failed | canceled }`.\n' +
        '- **Worker**: a claim-one-and-run loop (FOR UPDATE SKIP LOCKED so ' +
        'parallel workers don’t double-claim) that dispatches by ' +
        '`kind`. For now only `kind: noop` is registered (7.1.7 implements ' +
        'its handler); unknown kinds fail cleanly.\n' +
        '- **Endpoints** (service-credential auth): `POST /v1/jobs` ' +
        '(validate envelope, persist `queued`, return `202 { jobId }`), ' +
        '`GET /v1/jobs/:id` (status + result/error), `GET /v1/jobs/:id/' +
        'stream` (SSE; emits status transitions + any handler progress ' +
        'events — the chat consumer subscribes).\n\n' +
        'Map typed errors to the 7.1.1 taxonomy. The handler interface ' +
        '`(job, ctx) => Promise<Result>` is what 7.3/7.4 register real ' +
        'planners against — design it as the extension point.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Submitting a job persists `queued` and returns `202 { jobId }` ' +
        'immediately (no blocking on execution).\n' +
        '- The worker claims with `FOR UPDATE SKIP LOCKED`, runs the ' +
        'registered handler, and writes `succeeded`/`failed` + result/error.\n' +
        '- `GET /v1/jobs/:id` reflects each transition; `/stream` emits them ' +
        'over SSE and closes on a terminal state.\n' +
        '- The service credential is required on all three endpoints ' +
        '(missing/blank → 401, per the taxonomy).\n' +
        '- A `kind`-keyed handler registry exists with `noop` registered as ' +
        'a stub (real handler is 7.1.7); an unknown kind → clean `failed`.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.1 § job model + envelope + error taxonomy.\n' +
        '- 7.1.3 — the Prisma foundation + `AiProject` the job references.\n' +
        '- `motir-core` SSE usage (the /ready live-badge pattern, 7.0) for ' +
        'the stream shape.',
      dependsOn: ['7.1.3'],
    },
    {
      id: '7.1.5',
      title: 'motir-core → motir-ai client (server-to-server, request-scoped)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The motir-core side of the boundary: a server-only client that ' +
        'submits jobs to motir-ai and polls/streams status. This is the seam ' +
        'the 7.2 chat, 7.3/7.4 generation, and the 7.8 planning tools all ' +
        'call — so it is a clean internal abstraction, not endpoint-specific ' +
        'glue.\n\n' +
        '- `lib/ai/motirAiClient.ts` — `submitJob(kind, tenant, context, ' +
        'ctx)` → `{ jobId }`; `getJob(jobId)`; `streamJob(jobId)` ' +
        '(async-iterable of status/progress). Authenticates with ' +
        '`MOTIR_AI_SERVICE_TOKEN`; targets `MOTIR_AI_URL`. It is a leaf ' +
        'primitive (like `lib/email.ts`) — services import it; routes never ' +
        'do.\n' +
        '- **Mint the job-scoped read-back token** at submit (signed with ' +
        '`CORE_CALLBACK_SECRET`, encoding the requesting user + project + a ' +
        'short TTL) and include it in the job envelope, so motir-ai’s ' +
        'read-back (7.1.6) is permission-checked AS that user.\n' +
        '- Browser-safe boundary: this module is server-only (never bundled ' +
        'to the client); the open-core invariant is that browsers never ' +
        'reach motir-ai.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `submitJob` posts a valid 7.1.1 envelope (incl. the freshly minted ' +
        'job-scoped token) and returns the `jobId`.\n' +
        '- `getJob` / `streamJob` surface status + result/error mapped from ' +
        'the 7.1.1 taxonomy into motir-core typed errors.\n' +
        '- The client reads its config from env; a missing `MOTIR_AI_URL` / ' +
        'token fails fast with a clear error.\n' +
        '- Server-only: importing it from a client component is a build ' +
        'error (e.g. `import "server-only"`).\n' +
        '- No business logic in routes — any caller route delegates to a ' +
        'service that uses this client (4-layer).\n\n' +
        '## Context refs\n\n' +
        '- 7.1.1 § envelope + auth (the token shape).\n' +
        '- `motir-core/lib/email.ts` — the leaf-primitive pattern to mirror.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['7.1.1'],
    },
    {
      id: '7.1.6',
      title: 'Internal read-back + persist callback (the ai→core surface)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The motir-core endpoints motir-ai calls DURING a job. Deliberately ' +
        'minimal here — the rich graph-traversal retrieval (comments, ' +
        'history, code graph) is 7.5; 7.1 ships only what the walking ' +
        'skeleton needs.\n\n' +
        '- **`GET /api/internal/ai/plan-tree`** (job-scoped-token auth) — ' +
        'returns the project’s work-item SKELETON ' +
        '(`{ key, kind, title, status, parentKey }[]`, the cheap breadth ' +
        'projection) for the token’s project. Goes through ' +
        '`workItemsService` (a read method) — NOT raw Prisma. The token’s ' +
        'user + project scope is enforced: it reads ONLY that project, ' +
        '404-not-403 on anything else (finding #26).\n' +
        '- **`POST /api/internal/ai/plan-delta`** (job-scoped-token auth) — ' +
        'accepts the proposed tree-delta and COMMITS it through ' +
        '`workItemsService` (create/update work items), applying every 6.4 ' +
        'permission + tenant guard as the token’s user. Returns the ' +
        'created/updated keys. **This is the ONLY write path the AI has, and ' +
        'it runs in core** — motir-ai cannot mutate the tree any other way.\n\n' +
        'Both validate the job-scoped token (signature + TTL + project ' +
        'match) and reject expired/foreign tokens. These live under ' +
        '`/api/internal/*` and are service-to-service only (never CORS-' +
        'exposed to browsers).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `plan-tree` returns the skeleton projection for the token’s ' +
        'project only; a token for another project → 404; an expired token → ' +
        '401.\n' +
        '- `plan-delta` persists via `workItemsService` (verified: no raw ' +
        'Prisma in the route; the create path is the same service the UI ' +
        'uses), honors 6.4 permissions, and returns the resulting keys.\n' +
        '- An empty delta is a valid no-op (persists nothing, returns `[]`) — ' +
        'this is what 7.1.7’s `noop` job exercises.\n' +
        '- 4-layer respected throughout; both endpoints reject a ' +
        'missing/blank token.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.5 — the job-scoped token it mints (this verifies it).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the read + ' +
        'create/update authority (the delta commits through it).\n' +
        '- 7.1.1 § auth + the tree-delta result shape.\n' +
        '- Story 7.5 (stub) — the RICH retrieval that supersedes this minimal ' +
        'read later (graph traversal + comments + code graph); 7.1.6 is the ' +
        'skeleton it grows from.',
      dependsOn: ['7.1.5'],
    },
    {
      id: '7.1.7',
      title: '`noop` end-to-end plan job — the walking skeleton proving the loop',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Wire 7.1.4 + 7.1.5 + 7.1.6 into a single trivial round-trip that ' +
        'proves the WHOLE boundary works before any real AI lands. Implement ' +
        'the `noop` job handler in motir-ai: on run, it (1) calls the ' +
        'read-back `GET /api/internal/ai/plan-tree` with the job-scoped ' +
        'token, (2) records the skeleton size in its result, (3) submits an ' +
        'EMPTY delta to `POST /api/internal/ai/plan-delta` (a no-op persist), ' +
        '(4) returns `succeeded`. Add a motir-core service method + a thin ' +
        'internal trigger (a server action or a `dev`-only route) that ' +
        'submits the `noop` job for the active project via the 7.1.5 client.\n\n' +
        'This is the integration keystone: it exercises submit → worker → ' +
        'read tree → persist (empty) → succeeded, across two services and ' +
        'both auth grants, end to end. Every later jobKind (7.3 ' +
        '`generate_tree`, 7.4 `expand_item`/`augment`/`replan`) replaces the ' +
        'no-op middle with real planning — the rails are these.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Submitting a `noop` job for `PROD` drives ' +
        '`queued→running→succeeded`; the result reports the read tree size ' +
        'and a zero-change persist.\n' +
        '- The job-scoped token flows core→ai→core: motir-ai authenticates ' +
        'both read-back calls with it; a tampered token fails the job ' +
        'cleanly as `failed` with the taxonomy error.\n' +
        '- No work items are created or modified by a `noop` run (verified ' +
        'against the DB).\n' +
        '- The trigger is server-side only and not exposed in production UI ' +
        '(dev/internal).\n\n' +
        '## Context refs\n\n' +
        '- 7.1.4 (job substrate + handler registry), 7.1.5 (client + token), ' +
        '7.1.6 (read-back + persist).\n' +
        '- 7.1.1 § job lifecycle + error taxonomy.',
      dependsOn: ['7.1.4', '7.1.5', '7.1.6'],
    },
    {
      id: '7.1.8',
      title: 'Contract tests — both sides of the boundary',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Lock the boundary against drift. Because the open and closed repos ' +
        "can't share a private package, the CONTRACT TEST is what keeps the " +
        'two envelope/error implementations in agreement. Cover both sides:\n\n' +
        '- **Envelope + taxonomy round-trip** — a request/response built on ' +
        'one side parses cleanly on the other; every error `code` maps both ' +
        'ways.\n' +
        '- **Job lifecycle** (motir-ai) — `queued→running→succeeded`; a ' +
        'handler that throws → `failed` with a taxonomy error; an unknown ' +
        '`kind` → clean failure; `/stream` emits transitions and closes on ' +
        'terminal.\n' +
        '- **Read-back auth** (motir-core) — the job-scoped token reads ONLY ' +
        'its project; a foreign-project token → 404; an expired token → 401; ' +
        'a tampered signature → 401.\n' +
        '- **Persist authority** (motir-core) — `plan-delta` commits through ' +
        '`workItemsService` (assert via repository read, the allowed ' +
        'cross-layer test reach), honors 6.4 permissions, and an empty delta ' +
        'is a valid no-op.\n' +
        '- **Service credential** — both internal endpoints + the /v1/jobs ' +
        'endpoints reject missing/blank credentials.\n\n' +
        'Tests use a real Postgres on each side (no mocks — motir-core’s ' +
        'standing rule; mirror it in motir-ai), per `motir-core/CLAUDE.md`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass on both sides; the suites run in each ' +
        'repo’s CI.\n' +
        '- A deliberately mismatched error code (a drift simulation) makes ' +
        'the round-trip test FAIL — proving the test actually guards ' +
        'agreement.\n' +
        '- The motir-core cases respect the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) for any new service/repo code.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.1–7.1.7 (everything under test).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate.',
      dependsOn: ['7.1.7'],
    },
    {
      id: '7.1.9',
      title: 'Document the boundary — the living `contract.md` + open-core posture',
      status: 'blocked',
      type: 'content',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        'Finalize `motir-ai/docs/contract.md` (started as 7.1.1’s ' +
        'decision) into the LIVING reference now that the endpoints exist: ' +
        'real request/response examples captured from 7.1.7’s `noop` ' +
        'round-trip, the job lifecycle diagram, the auth (service credential ' +
        '+ job-scoped token) flow, the error-code table, and the env ' +
        'inventory. Add the **open-core posture** section restating the ' +
        'invariants every future AI story inherits: browsers never call ' +
        'motir-ai; the AI never writes the tree directly (persist is ' +
        'core-side through `workItemsService`); motir-ai holds no connection ' +
        'to core’s DB; reads are job-scoped + permission-checked. Update ' +
        '`motir-core/docs/ai-boundary.md` to link it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `contract.md` documents all four endpoints with real captured ' +
        'examples, the lifecycle, the auth flow, the error table, and the env ' +
        'inventory.\n' +
        '- An "open-core invariants" section enumerates the four invariants ' +
        'above as the contract every later AI story rides.\n' +
        '- `motir-core/docs/ai-boundary.md` points to it; no secrets are ' +
        'committed (examples use placeholders).\n\n' +
        '## Context refs\n\n' +
        '- 7.1.1 (the decision this finalizes), 7.1.7 (the captured ' +
        'examples).\n' +
        '- `motir-ai/README.md` (the open-core framing to stay consistent ' +
        'with).',
      dependsOn: ['7.1.7'],
    },
  ],
};
