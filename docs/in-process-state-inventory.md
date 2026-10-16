# In-process state inventory — motir-core `app`

**Story:** MOTIR-8547 · **Card:** MOTIR-8612 (research) · **Date:** 2026-10-14

Production runs two `app` machines (`fly.toml` `min_machines_running = 2`), so any
state an `app` process keeps between requests is already split in two. This
document lists the state a `git grep` sweep found, and says for each piece whether
a second machine can make its answer **wrong**, or only briefly **stale**.

It is a record of one search at one ref. A site the search did not match is not on
it. The meaning-level search below exists because a list of patterns can only
sample the wording.

## 1. Ref, scope and commands

- **Ref:** `origin/main` at `f29727ceadcca45816ab9b747a2f7a060b70fa75`.
- **Scope:** `lib/`, `app/` and `server.js`. Each search runs as `git grep <args> origin/main -- lib app server.js`, never against a working tree.
- **Excluded as client-only code:**
  - everything under `lib/hooks/`;
  - `components/`, which falls outside the three scope paths anyway;
  - every file whose first line is `'use client'`. The set is 487 files, produced by:

    ```sh
    git grep -l "^['\"]use client['\"]" origin/main -- lib app server.js
    ```

- **Excluded as tests:** files under `__tests__/` and `*.test.ts(x)` / `*.spec.ts(x)`.
- **Module-scope filter:** for the `new Map/Set/Weak*` patterns a hit counts only when the matched line starts at column 0. An indented `new Map` lives inside a function, a class or an object literal, so it is not module state. The `let`, timer and memoised-promise patterns are anchored at `^` in the regex itself.

| #   | Pattern                                             | Command (as run)                                                                                                        | Hits    |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | new Map                                             | `git grep -nE 'new Map\b' origin/main -- lib app server.js`                                                             | 34      |
| 2   | new Set                                             | `git grep -nE 'new Set\b' origin/main -- lib app server.js`                                                             | 116     |
| 3   | new WeakMap / WeakSet / WeakRef                     | `git grep -nE 'new Weak(Map\|Set\|Ref)\b' origin/main -- lib app server.js`                                             | 3       |
| 4   | module-scope let                                    | `git grep -nE '^(export )?let ' origin/main -- lib app server.js`                                                       | 30      |
| 5   | globalThis. / global.                               | `git grep -nE '\bglobalThis\.\|\bglobal\.' origin/main -- lib app server.js`                                            | 4       |
| 6   | setInterval( / setTimeout( at module scope          | `git grep -nE '^(export \|const \|let \|void )?[^ \t]*( = )?set(Interval\|Timeout)\(' origin/main -- lib app server.js` | 1       |
| 7   | memoized promise (inflight / module Promise / ??=)  | `git grep -nE '^(export )?(let\|const) \w*([Ii]nflight\|[Pp]romise)\b\|^\w+ \?\?= ' origin/main -- lib app server.js`   | 1       |
|     | **Sum**                                             |                                                                                                                         | **189** |
|     | **After de-duplicating identical `file:line` hits** |                                                                                                                         | **188** |

The two counts differ by 1 because one line matched two patterns: `lib/agentInstances/imageCatalog.ts:88` matched both `new Map` and the memoised-promise pattern. Each Hits count is taken after the scope exclusions and the module-scope filter, as described above.

**Reconciliation.** 188 unique hits = 21 rows in §2 that come from a grep hit, plus 167 lines in §3. §2 also carries 12 rows that no pattern matched. Those came from the library-default check (step 2) and the meaning-level search (§4), and each is marked _(not a grep hit)_.

### Library defaults that store in memory

- **Better-Auth 1.7.7** (`node_modules/better-auth/package.json` `"version": "1.7.7"`), `dist/context/create-context.mjs`:

  ```js
  rateLimit: {
    ...options.rateLimit,
    enabled: options.rateLimit?.enabled ?? isProduction,
    window: options.rateLimit?.window || 10,
    max: options.rateLimit?.max || 100,
    storage: options.rateLimit?.storage || (options.secondaryStorage ? "secondary-storage" : "memory")
  },
  ```

  The `memory` backend in `dist/api/rate-limiter/index.mjs` is a module-level `const memory = new Map()`. `lib/auth/index.ts` passes `rateLimit: { enabled: process.env['E2E_DISABLE_RATE_LIMIT'] !== '1', customRules: { '/request-password-reset': { window: 3600, max: 3 } } }`. It sets no `storage` and the config has no `secondaryStorage`, so **production counts Better-Auth's limits in a per-process Map**. Better-Auth's built-in special rules are `/sign-in`, `/sign-up`, `/change-password` and `/change-email` at 3 requests per 10 s. The key is the client IP plus the path.

- **mcp-handler 1.1.0.** With `disableSse: true` it never opens its Redis clients; `redisUrl` is read only on the SSE path. Each POST builds a fresh `McpServer` and a fresh `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator })` (`dist/index.mjs` ~l.313). `app/api/mcp/route.ts` passes no `sessionIdGenerator`, which leaves the transport in stateless mode. **No session survives between calls.**
- **jose 6.2.3**, used by `lib/github/oidcAuth.ts`. `createRemoteJWKSet` caches keys with `cacheMaxAge` 600000 ms and `cooldownDuration` 30000 ms (`dist/webapi/jwks/remote.js`). A token whose key id it does not know triggers a refetch, after the cooldown.
- **Cache libraries.** `package.json` declares none of `lru-cache`, `quick-lru`, `node-cache`, `keyv`, `cache-manager`, `redis`, `ioredis` or `@vercel/kv`. `git grep` finds no import of any of them under `lib/` or `app/`.
- **Next.js 16.3.6 caches.**
  - `next.config.ts` sets no `cacheHandler`.
  - No `unstable_cache` or `'use cache'` under `lib/` or `app/`.
  - No `export const revalidate`, and no `fetch(…, { next: { revalidate } })`.
  - Three `force-static` route handlers (`app/api/docs/cli-commands.json`, `app/api/openapi/public.json`, `app/api/openapi/v1.json`) render at build time.

  See §5 F4.

## 2. The sites this search returned

The classes are:

- **shared**: the state lives in a store every machine reads; the row names it.
- **safe per instance**: a second machine can only make the answer stale, within the stated bound.
- **moved**: per-instance state gives a wrong answer. The row names the store it should move to.

| file:line                                                                                              | What it holds                                                                                                                                   | Class             | Staleness bound (s) | Reason — and what a user sees in the window                                                                                                                                                                                                                                                                                                                                                                | Target shared store (moved)                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `lib/agentInstances/imageCatalog.ts:87`                                                                | `profileCache` — newest image version per agent profile                                                                                         | safe per instance | 600                 | `IMAGE_CATALOG_TTL_MS` = 600 s. After an image release, one machine may show "no update" on an agent for ≤ 600 s while the other shows the update.                                                                                                                                                                                                                                                         |                                                                                                                    |
| `lib/agentInstances/imageCatalog.ts:88`                                                                | `inflight` — the in-progress registry read per profile                                                                                          | safe per instance | 0                   | Holds a promise only while one registry read is in flight, so concurrent callers in this process share it. A second machine makes one more registry read; it never serves an older answer than `profileCache` does.                                                                                                                                                                                        |                                                                                                                    |
| `lib/agentInstances/imageCatalog.ts:90`                                                                | `digestByTag` — immutable tag → digest                                                                                                          | safe per instance | until restart (F3)  | An immutable tag never moves, so a cached digest cannot become wrong; the entry is never expired.                                                                                                                                                                                                                                                                                                          |                                                                                                                    |
| `lib/agentInstances/imageCatalog.ts:91`                                                                | `inflightTags` — in-progress tag lookups                                                                                                        | safe per instance | 0                   | Same as `inflight`: a single-flight promise for the duration of one read.                                                                                                                                                                                                                                                                                                                                  |                                                                                                                    |
| `lib/blob/s3.ts:43`                                                                                    | `cached` — the S3 client object, keyed on its config                                                                                            | safe per instance | 0                   | A client, not data: re-built when the config key changes. Objects live in the shared bucket.                                                                                                                                                                                                                                                                                                               |                                                                                                                    |
| `lib/github/appAuth.ts:138`                                                                            | `cache` — GitHub App installation tokens per role + installation                                                                                | safe per instance | 3540                | Held until expiry − `EXPIRY_SKEW_MS` (60 s); GitHub tokens last 3600 s. A token is a credential, not an answer: on uninstall/revocation GitHub rejects it on every machine alike (each sees the same 401/404). See F6 for the repository-set assumption.                                                                                                                                                   |                                                                                                                    |
| `lib/github/oidcAuth.ts:37`                                                                            | `jwksCache` — one jose remote JWKS resolver per URL                                                                                             | safe per instance | 600                 | jose `cacheMaxAge` 600 s, `cooldownDuration` 30 s; an unknown `kid` triggers a refetch, so a rotated GitHub OIDC key verifies after at most the 30 s cooldown on each machine. A publish from CI may be refused for ≤ 30 s after a key rotation.                                                                                                                                                           |                                                                                                                    |
| `lib/github/repoProvisioning.ts:207`                                                                   | `installationIdCache` — Motir Studio App installation id per org                                                                                | safe per instance | until restart (F3)  | Our own App on our own org: a stable property. If an operator reinstalls the App, a machine holding the old id fails the token mint (typed `RepoProvisioning*` error) until restart; it never provisions into the wrong place.                                                                                                                                                                             |                                                                                                                    |
| `lib/github/runGitCredential.ts:294`                                                                   | `botAuthors` — the App bot's commit name/email                                                                                                  | safe per instance | until restart (F3)  | Read once per process from `GET /app` + `GET /users/<slug>[bot]`; a failed read is not cached. Changes only if the App slug is renamed.                                                                                                                                                                                                                                                                    |                                                                                                                    |
| `lib/mcp/toolTracing.ts:82`                                                                            | `callsPerRoot` — tool-call count per root span                                                                                                  | safe per instance | 0                   | A WeakMap keyed by one request's root span; tracing only.                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                    |
| `lib/monitoring/loopBlockWatchdog.ts:250`                                                              | `watchdog` — this process's event-loop watchdog thread                                                                                          | safe per instance | 0                   | Process diagnostics: each machine watches its own event loop, which is the point.                                                                                                                                                                                                                                                                                                                          |                                                                                                                    |
| `lib/monitoring/processPressure.ts:160`                                                                | `state` — this process's CPU/GC counter windows                                                                                                 | safe per instance | 0                   | Process diagnostics read from this machine's cgroup; per-instance by nature.                                                                                                                                                                                                                                                                                                                               |                                                                                                                    |
| `lib/monitoring/sentryErrorCount.ts:76`                                                                | `projectIds` — Sentry project id per org/project slug                                                                                           | safe per instance | until restart (F3)  | Keyed by the configured slugs, so a changed setting re-resolves. Operator telemetry only; no user-facing answer.                                                                                                                                                                                                                                                                                           |                                                                                                                    |
| `lib/monitoring/transactionStall.ts:112`                                                               | `loopMonitor` — this process's event-loop delay histogram                                                                                       | safe per instance | 0                   | Process diagnostics; per-instance by nature.                                                                                                                                                                                                                                                                                                                                                               |                                                                                                                    |
| `lib/platform/staffSession.ts:175`                                                                     | `memo` — staff-session gate result per request `Headers`                                                                                        | safe per instance | 0                   | A WeakMap keyed by the request's own `Headers` object: it lives for one request and is collected with it.                                                                                                                                                                                                                                                                                                  |                                                                                                                    |
| `lib/publicAddresses/allowedOrigins.ts:46`                                                             | `cache` — registered-public-origin verdict per `Origin`, positive and negative                                                                  | safe per instance | 60                  | `TTL_MS = 60_000`, per-instance by decision (file header). A newly claimed address may be refused CORS on one machine for ≤ 60 s; a released address keeps a CORS grant ≤ 60 s. Both answers were true ≤ 60 s ago.                                                                                                                                                                                         |                                                                                                                    |
| `lib/rateLimit/store.ts:70`                                                                            | `resolved` — the memoised `sharedRateLimitStore()` choice                                                                                       | shared            | —                   | Memoises an env-derived choice only (`resolveRateLimitBackend()`): `postgres` whenever `DATABASE_URL` is set, which it always is in production; `fly.toml` does not set `MOTIR_RATE_LIMIT_STORE`. The counters it selects live in Postgres `rate_limit_counter` (`lib/rateLimit/postgresStore.ts`). See F2 for the `memory` opt-in.                                                                        |                                                                                                                    |
| `lib/services/aiPlanGateService.ts:62`                                                                 | `planCache` — paid-AI-plan answer per organisation                                                                                              | safe per instance | 30                  | `PLAN_CACHE_TTL_MS = 30_000`; `unknown` is never cached. After a purchase, one machine may refuse a fleet/Studio action as `ai_plan_required` for up to 30 s while the other accepts; after a lapse, admission continues up to 30 s. The answer is the plan as it stood ≤ 30 s ago, never another org's.                                                                                                   |                                                                                                                    |
| `lib/services/monitorCredentialService.ts:145`                                                         | `inFlightRefreshes` — this process's refresh promises                                                                                           | safe per instance | 0                   | Lets a stopping process await its own refreshes before disconnecting. The refresh LEASE is in Postgres (short transaction #1 locks and re-reads), so two machines cannot both refresh one credential.                                                                                                                                                                                                      |                                                                                                                    |
| `lib/services/readinessService.ts:46`                                                                  | `ready` — this process has warmed its pool                                                                                                      | safe per instance | 0                   | Readiness is a property of the machine itself; Fly health-checks each machine. Per-instance is the correct answer.                                                                                                                                                                                                                                                                                         |                                                                                                                    |
| `lib/services/readinessService.ts:47`                                                                  | `warming` — the memoised warm-up promise                                                                                                        | safe per instance | 0                   | Single-flights the warm-up for the row above.                                                                                                                                                                                                                                                                                                                                                              |                                                                                                                    |
| `lib/auth/index.ts` `authOptions.rateLimit` _(not a grep hit — library default)_                       | Better-Auth's built-in limiter buckets (`/sign-in`, `/sign-up`, `/change-password`, `/change-email` 3/10 s; `/request-password-reset` 3/3600 s) | shared            | —                   | Was **moved** at the ref: Better-Auth 1.7.7 defaults `storage` to `"memory"`, a module-level `Map`, so per machine the limit was `max × machines` (F1): WRONG, not stale. MOTIR-8613 set `customStorage` to `createBetterAuthRateLimitStorage()` (`lib/rateLimit/betterAuthStorage.ts`), which counts every bucket in Postgres `rate_limit_counter` under a `ba:` key; re-marked **shared** by this story. | Postgres `rate_limit_counter`, through `sharedRateLimitStore()` (`lib/rateLimit/betterAuthStorage.ts`, MOTIR-8613) |
| `lib/api/v1/rateLimit.ts` `createInProcessRateLimitStore` _(not a grep hit — the `memory` backend)_    | `counts` — per-key window counters, inside the factory                                                                                          | shared            | —                   | Selected only by an explicit `MOTIR_RATE_LIMIT_STORE=memory`; production resolves `postgres` (`rate_limit_counter`). Chosen, it would be wrong per machine — F2 / MOTIR-8614 refuse it in production.                                                                                                                                                                                                      |                                                                                                                    |
| `app/api/mcp/route.ts` _(not a grep hit)_                                                              | nothing between calls                                                                                                                           | safe per instance | 0                   | mcp-handler 1.1.0 with `disableSse: true`: a fresh `McpServer` + stateless transport per POST, no Redis. A call and its follow-up may land on different machines freely.                                                                                                                                                                                                                                   |                                                                                                                    |
| `app/api/workbench/stream/route.ts` _(not a grep hit)_                                                 | the open connection's cursor                                                                                                                    | safe per instance | 0                   | The cursor is a state watermark the client carries; a reconnect to the other machine resumes from it and re-reads, so a replay costs a redundant read, never a duplicate (route header). No module state.                                                                                                                                                                                                  |                                                                                                                    |
| `lib/live/liveSignalHub.ts` `getLiveSignalHub` _(not a grep hit)_                                      | the process's one `LISTEN` session and its subscriber set                                                                                       | safe per instance | 0                   | A per-process HINT source (MOTIR-8728): a NOTIFY reaches every listening session on the database, so every machine hears every write. A notification missed while it reconnects is healed by the stream backstop (60 s) and the reconnect catch-up read.                                                                                                                                                   |                                                                                                                    |
| `lib/workbench/workbenchStreamCoalescer.ts` _(not a grep hit)_                                         | per-key coalescing windows and the stream read limiter                                                                                          | safe per instance | 0                   | Timers and a queue for this process's own open streams (MOTIR-8729); it holds no data, and each stream's read stays the reader's own read of Postgres.                                                                                                                                                                                                                                                     |                                                                                                                    |
| `lib/services/workbenchWatermarkService.ts` _(not a grep hit)_                                         | nothing — computes the watermark per re-read                                                                                                    | shared            | —                   | Reads Postgres through `workItemRepository`, `watcherRepository`, `planChangeSessionRepository`, `approvalGateRepository`, … on every poll; the module-scope patterns return 0 hits in the file.                                                                                                                                                                                                           |                                                                                                                    |
| `lib/agentTerminal/relay/activityThrottle.ts` `ActivityThrottle` _(not a grep hit)_                    | last `touchActivity` time per agent instance                                                                                                    | safe per instance | 60                  | Runs in the RELAY process (`scripts/relay.ts`, `fly.relay.toml`), not the `app`; listed because the card names it. `TERMINAL_ACTIVITY_THROTTLE_MS` = 60 s; a second relay machine at worst doubles a once-a-minute bump.                                                                                                                                                                                   |                                                                                                                    |
| `lib/translation`, `planChangeSessionRepository.ts:388`, `folderRepository`, … _(meaning search §4.3)_ | single-flight and write locks                                                                                                                   | shared            | —                   | Postgres `pg_advisory_xact_lock` — held in the database, so it excludes across machines.                                                                                                                                                                                                                                                                                                                   |                                                                                                                    |
| `lib/jobs/engine/notify.ts` _(meaning search §4.3)_                                                    | the job-queue wake-up                                                                                                                           | shared            | —                   | Postgres `LISTEN/NOTIFY`; the queue itself is a table. Debounce (`lib/jobs/engine/debounce.ts`) is a `runAt` on the job row.                                                                                                                                                                                                                                                                               |                                                                                                                    |
| `lib/services/agentTerminalService.ts:76` _(meaning search §4.2)_                                      | terminal tickets with a 60 s TTL                                                                                                                | shared            | —                   | The ticket row and its `expiresAt` are in Postgres; a ticket minted on one machine redeems on the other.                                                                                                                                                                                                                                                                                                   |                                                                                                                    |
| `lib/services/ideaDraftService.ts:33` _(meaning search §4.2)_                                          | idea drafts with a 30 min TTL                                                                                                                   | shared            | —                   | Row with `expiresAt` in Postgres; claimable from either machine.                                                                                                                                                                                                                                                                                                                                           |                                                                                                                    |
| `lib/github/installState.ts`, `lib/gitlab/oauthState.ts` _(meaning search §4.8)_                       | OAuth/install round-trip state                                                                                                                  | shared            | —                   | No store: HMAC-signed with `BETTER_AUTH_SECRET` (identical on every machine), TTL 600 s. A callback landing on the other machine verifies.                                                                                                                                                                                                                                                                 |                                                                                                                    |
| React `cache()` callers — `getSession`, `requirePlatformStaff`, … (5 files) _(meaning search §4.5)_    | one value per render pass                                                                                                                       | safe per instance | 0                   | `cache()` memoises within a single server render and is inert outside one; it never outlives the request.                                                                                                                                                                                                                                                                                                  |                                                                                                                    |

## 3. Excluded hits

Each line is a grep hit that holds no state with an effect across requests, with the reason.

- `app/(admin)/admin/ideas/[slug]/_components/ideaDraft.ts:46` — browser-only: every importer is a `'use client'` file (IdeaEditForm.tsx)
- `app/(admin)/admin/planning-lessons/_components/LessonBits.tsx:23` — constant lookup table, never mutated
- `app/(admin)/admin/tenants/[orgId]/_components/ops/opsGate.ts:100` — `globalThis.crypto.randomUUID()` call — reads no state
- `app/(auth)/oauth/_components/ConsentRefused.tsx:28` — constant lookup table, never mutated
- `app/(authed)/dashboard/_components/widgetMeta.tsx:55` — constant lookup table, never mutated
- `app/(authed)/items/[key]/_components/AttachmentGlyph.tsx:19` — constant lookup table, never mutated
- `app/(authed)/items/[key]/_components/AttachmentGlyph.tsx:25` — constant lookup table, never mutated
- `app/(authed)/items/[key]/_components/translation/translationReducer.ts:113` — constant lookup table, never mutated
- `app/(authed)/my-agents/_components/useAgentChat.ts:93` — constant lookup table, never mutated
- `app/(authed)/my-agents/_components/useAgentTerminal.ts:105` — constant lookup table, never mutated
- `app/(authed)/my-agents/_components/useRunSessionWatch.ts:39` — constant lookup table, never mutated
- `app/(authed)/settings/account/_components/permissionMeta.tsx:92` — constant lookup table, never mutated
- `app/(authed)/settings/account/_components/permissionMeta.tsx:178` — constant lookup table, never mutated
- `app/api/dispatch-runs/[id]/stream/route.ts:56` — constant lookup table, never mutated
- `app/api/import/route.ts:11` — constant lookup table, never mutated
- `app/api/me/api-tokens/route.ts:42` — constant lookup table, never mutated
- `app/api/ready/next/route.ts:42` — constant lookup table, never mutated
- `app/api/ready/next/route.ts:43` — constant lookup table, never mutated
- `app/api/ready/route.ts:37` — constant lookup table, never mutated
- `app/api/ready/route.ts:38` — constant lookup table, never mutated
- `app/api/work-items/approval-gate/route.ts:80` — constant lookup table, never mutated
- `lib/activity/renderers.ts:490` — constant lookup table, never mutated
- `lib/agentInstances/imageCatalog.ts:85` — test seam: the swappable registry client
- `lib/agentInstances/imageCatalog.ts:86` — test seam: the swappable clock
- `lib/agentInstances/imageCatalog.ts:93` — fake-fleet test seam (`fakeUnavailable`)
- `lib/agentInstances/imageCatalog.ts:95` — fake-fleet test seam (`fakeNewest`)
- `lib/agentInstances/presentation.ts:40` — constant lookup table, never mutated
- `lib/agentInstances/runEnd.ts:33` — constant lookup table, never mutated
- `lib/api/v1/rateLimit.ts:164` — test-only override of the v1 store (`storeOverride`)
- `lib/api/v1/ready/schema.ts:252` — constant lookup table, never mutated
- `lib/api/v1/ready/schema.ts:253` — constant lookup table, never mutated
- `lib/api/v1/workItems/schema.ts:1193` — constant lookup table, never mutated
- `lib/apiDocs/mcp.ts:1441` — memo of a document derived from source; identical on every machine built from one image
- `lib/apiDocs/mcp.ts:1442` — memo of documents derived from source; identical on every machine built from one image
- `lib/approvalGates/choiceOptions.ts:43` — constant lookup table, never mutated
- `lib/approvalGates/decisionDocument.ts:40` — constant lookup table, never mutated
- `lib/approvalGates/refusals.ts:175` — constant lookup table, never mutated
- `lib/approvalGates/reviewVerdict.ts:39` — constant lookup table, never mutated
- `lib/approvalGates/subjectSummary.ts:112` — constant lookup table, never mutated
- `lib/automation/automationRuleForm.ts:90` — browser-only: every importer is a `'use client'` file (AutomationRuleEditor.tsx)
- `lib/automation/registry.ts:160` — constant lookup table, never mutated
- `lib/automation/registry.ts:448` — constant lookup table, never mutated
- `lib/billing/catalog.ts:222` — constant lookup table, never mutated
- `lib/blob/uploadClient.ts:70` — constant lookup table, never mutated
- `lib/deployment/adapters/fly/flyMachinesStatus.ts:34` — constant lookup table, never mutated
- `lib/email.ts:250` — constant lookup table, never mutated
- `lib/email.ts:260` — constant lookup table, never mutated
- `lib/email.ts:497` — comment text ("global" in prose)
- `lib/email.ts:501` — comment text ("global" in prose)
- `lib/filters/registry.ts:254` — constant lookup table, never mutated
- `lib/git/registry.ts:11` — code registry filled at import; identical on every machine
- `lib/github/repoProvisioning.ts:186` — test-only override of the readiness poll settings
- `lib/github/returnSurface.ts:77` — constant lookup table, never mutated
- `lib/i18n/messages.ts:24` — memo of merged message catalogues from source; identical on every machine
- `lib/import/engine/importResolver.ts:23` — constant lookup table, never mutated
- `lib/issues/executorDefaults.ts:105` — constant lookup table, never mutated
- `lib/issues/issueListAdvancedFilter.ts:99` — constant lookup table, never mutated
- `lib/issues/issueListAdvancedFilter.ts:172` — constant lookup table, never mutated
- `lib/issues/issueListView.ts:72` — constant lookup table, never mutated
- `lib/issues/parentRules.ts:78` — constant lookup table, never mutated
- `lib/jobs/engine/manifest.ts:70` — code registry (job manifest) filled at import; identical on every machine
- `lib/jobs/engine/registry.ts:64` — code registry (job definitions) filled at import; identical on every machine
- `lib/jobs/engine/subscribers.ts:41` — memoised import of the job registry modules (`loading`) — code, not data
- `lib/jobs/engine/subscribers.ts:43` — flag that the job registry module was imported (`registryLoaded`) — code, not data
- `lib/jobs/schedules.ts:20` — code registry (schedules) filled at import; identical on every machine
- `lib/mappers/dispatchRunMappers.ts:305` — constant lookup table, never mutated
- `lib/mappers/dispatchRunMappers.ts:306` — constant lookup table, never mutated
- `lib/mappers/fixReasonMappers.ts:21` — constant lookup table, never mutated
- `lib/mappers/fixReasonMappers.ts:33` — constant lookup table, never mutated
- `lib/mappers/planChangeMappers.ts:29` — constant lookup table, never mutated
- `lib/markdown/proseRanges.ts:54` — constant lookup table, never mutated
- `lib/mentions/workItemMentionSearch.ts:17` — constant lookup table, never mutated
- `lib/mergeQueue/queueExit.ts:129` — constant lookup table, never mutated
- `lib/monitoring/loopBlockWatchdog.ts:141` — inside the `WORKER_SOURCE` string literal — worker-thread source text, not app module state
- `lib/monitoring/loopBlockWatchdog.ts:142` — inside the `WORKER_SOURCE` string literal
- `lib/monitoring/loopBlockWatchdog.ts:143` — inside the `WORKER_SOURCE` string literal
- `lib/monitoring/loopBlockWatchdog.ts:213` — inside the `WORKER_SOURCE` string literal (the worker thread's own poll timer)
- `lib/monitoring/loopBlockWatchdog.ts:251` — test-only threshold override (`thresholdOverrideMs`)
- `lib/monitoring/processPressure.ts:81` — test seam: the swappable cgroup/procfs readers
- `lib/monitors/registry.ts:14` — code registry filled at import; identical on every machine
- `lib/monitors/returnSurface.ts:34` — constant lookup table, never mutated
- `lib/oauth/redirectPolicy.ts:12` — constant lookup table, never mutated
- `lib/onboarding/discoveryLoop.ts:68` — constant lookup table, never mutated
- `lib/onboarding/discoveryLoop.ts:592` — constant lookup table, never mutated
- `lib/onboarding/revisions.ts:33` — constant lookup table, never mutated
- `lib/permissions/builtinRoles.ts:325` — constant lookup table, never mutated
- `lib/permissions/resolve.ts:139` — constant lookup table, never mutated
- `lib/permissions/resolve.ts:147` — constant lookup table, never mutated
- `lib/planChange/failureRecord.ts:78` — constant lookup table, never mutated
- `lib/planning/guideView.ts:80` — constant lookup table, never mutated
- `lib/planning/pickAutoSend.ts:18` — browser-only: every importer is a `'use client'` file (AiCalloutMenu.tsx, PlanChangeRail.tsx, PlanningWorkspaceHost.tsx, ReportWidgetModal.tsx)
- `lib/planning/roadmapClient.ts:183` — constant lookup table, never mutated
- `lib/planning/roadmapClient.ts:190` — constant lookup table, never mutated
- `lib/planning/roadmapClient.ts:208` — constant lookup table, never mutated
- `lib/planning/surfaceSeed.ts:39` — browser-only: every importer is a `'use client'` file (AiCalloutMenu.tsx, PlanChangeRail.tsx, PlanningWorkspaceHost.tsx, ReportWidgetModal.tsx)
- `lib/plans/approvedShapeChange.ts:38` — constant lookup table, never mutated
- `lib/plans/approvedShapeChange.ts:69` — constant lookup table, never mutated
- `lib/plans/markOnlyPatch.ts:15` — constant lookup table, never mutated
- `lib/plans/planProgress.ts:187` — constant lookup table, never mutated
- `lib/plans/timeline.ts:26` — constant lookup table, never mutated
- `lib/plans/timeline.ts:38` — constant lookup table, never mutated
- `lib/plans/validatePatchKeys.ts:21` — constant lookup table, never mutated
- `lib/platform/spend.ts:24` — constant lookup table, never mutated
- `lib/platform/staffSession.ts:74` — constant lookup table, never mutated
- `lib/prisma/connectionError.ts:36` — constant lookup table, never mutated
- `lib/prisma/connectionError.ts:42` — constant lookup table, never mutated
- `lib/prisma/connectionError.ts:49` — constant lookup table, never mutated
- `lib/projectTags/vocabulary.ts:67` — constant lookup table, never mutated
- `lib/publicAddresses/providers.ts:94` — E2E fake DNS resolver (`fakeTxt`), selected only in the E2E lane — see F5
- `lib/publicAddresses/reservedNames.ts:99` — constant lookup table, never mutated
- `lib/rateLimit/authGuard.ts:59` — constant lookup table, never mutated
- `lib/rateLimit/store.ts:71` — test-only override of the shared store (`override`)
- `lib/reports/statisticTypes.ts:59` — constant lookup table, never mutated
- `lib/savedFilters/builtins.ts:118` — constant lookup table, never mutated
- `lib/savedFilters/subscriptions.ts:24` — constant lookup table, never mutated
- `lib/services/abandonedPlanService.ts:245` — constant lookup table, never mutated
- `lib/services/abandonedPlanService.ts:318` — constant lookup table, never mutated
- `lib/services/aiBugTelemetryService.ts:64` — constant lookup table, never mutated
- `lib/services/aiPlanGateService.ts:45` — constant lookup table, never mutated
- `lib/services/aiSharpenService.ts:92` — constant lookup table, never mutated
- `lib/services/aiSharpenService.ts:93` — constant lookup table, never mutated
- `lib/services/aiSprintPlanningService.ts:107` — constant lookup table, never mutated
- `lib/services/approvalGatesService.ts:834` — constant lookup table, never mutated
- `lib/services/changeRequestStatusSync.ts:120` — constant lookup table, never mutated
- `lib/services/decisionDocumentService.ts:37` — swappable resolver seam — holds a function, not data
- `lib/services/decisionDocumentService.ts:45` — swappable resolver seam — holds a function, not data
- `lib/services/designEvidenceService.ts:137` — constant lookup table, never mutated
- `lib/services/fleetAttributionService.ts:74` — constant lookup table, never mutated
- `lib/services/fleetAttributionService.ts:80` — constant lookup table, never mutated
- `lib/services/githubWebhookService.ts:123` — constant lookup table, never mutated
- `lib/services/githubWebhookService.ts:1319` — constant lookup table, never mutated
- `lib/services/gitlabWebhookService.ts:60` — constant lookup table, never mutated
- `lib/services/manualWorkGateService.ts:40` — constant lookup table, never mutated
- `lib/services/planChangeLateChangeService.ts:70` — constant lookup table, never mutated
- `lib/services/planChangeMailboxService.ts:93` — constant lookup table, never mutated
- `lib/services/planChangeSessionsService.ts:792` — constant lookup table, never mutated
- `lib/services/planSessionEndService.ts:79` — constant lookup table, never mutated
- `lib/services/planSharpeningService.ts:88` — constant lookup table, never mutated
- `lib/services/platformEnterpriseRequestService.ts:67` — constant lookup table, never mutated
- `lib/services/pullRequestMergeService.ts:933` — constant lookup table, never mutated
- `lib/services/pullRequestReconcileService.ts:150` — constant lookup table, never mutated
- `lib/services/pullRequestReconcileService.ts:474` — constant lookup table, never mutated
- `lib/services/resumeStateService.ts:149` — constant lookup table, never mutated
- `lib/services/triageService.ts:98` — constant lookup table, never mutated
- `lib/services/workItemContinueService.ts:65` — constant lookup table, never mutated
- `lib/services/workspaceRoleDefinitionService.ts:48` — constant lookup table, never mutated
- `lib/settings/projectNavAccess.ts:219` — constant lookup table, never mutated
- `lib/test-billing-mock.ts:271` — test double (billing mock) — see F5
- `lib/test-blob-mock.ts:38` — test double (blob mock) — see F5
- `lib/test-code-graph-mock.ts:69` — test double (code-graph mock journal) — see F5
- `lib/test-code-graph-mock.ts:108` — test double (code-graph mock flag) — see F5
- `lib/test-github-repos-mock.ts:183` — test double (GitHub repos mock) — see F5
- `lib/test-github-repos-mock.ts:184` — test double (GitHub repos mock) — see F5
- `lib/test-github-repos-mock.ts:185` — test double (GitHub repos mock) — see F5
- `lib/test-oauth-mock.ts:27` — comment text (`globalThis.fetch` mentioned in prose)
- `lib/workItems/bodyAboveFieldMove.ts:93` — constant lookup table, never mutated
- `lib/workItems/bodyAboveFieldMove.ts:94` — constant lookup table, never mutated
- `lib/workItems/containerCoverage.ts:72` — constant lookup table, never mutated
- `lib/workItems/linkRelationships.ts:44` — constant lookup table, never mutated
- `lib/workItems/readyFilter.ts:235` — constant lookup table, never mutated
- `lib/workItems/readyFilter.ts:258` — constant lookup table, never mutated
- `lib/workItems/readyFilter.ts:337` — constant lookup table, never mutated
- `lib/workItems/readyFilter.ts:355` — constant lookup table, never mutated
- `lib/workItems/repoDelivery.ts:130` — constant lookup table, never mutated
- `lib/workItems/statusLadder.ts:223` — constant lookup table, never mutated
- `lib/workbench/tab.ts:104` — constant lookup table, never mutated
- `lib/workflows/defaultWorkflow.ts:143` — constant lookup table, never mutated

## 4. Meaning-level search

The patterns above sample the wording. These searches look for the claim itself: something remembered between requests.

1. `git grep -nEi '^\s+(private |readonly |#)\S*(cache|inflight|seen|pending|throttle|dedup|last)\w*\s*[:=]' origin/main -- lib app server.js`. This finds class-held caches, which a module-scope pattern cannot see. It returned 4 lines:
   - `lib/jobs/engine/worker.ts:355` `renewalInFlight` belongs to the worker process group, which is out of scope.
   - `lib/dto/publicAddresses.ts:122` is a DTO field.
   - `lib/monitoring/processPressure.ts:97-98` are fields of a reading type.

   It added no row.

2. `git grep -nE 'TTL_MS|_TTL\b' origin/main -- lib`. Besides the TTLs already in the table (`IMAGE_CATALOG_TTL_MS`, `allowedOrigins` `TTL_MS`, `PLAN_CACHE_TTL_MS`) it found four. All of them write an `expiresAt` into Postgres:
   - `TERMINAL_TICKET_TTL_MS`;
   - `IDEA_DRAFT_TTL_MS`;
   - `CONFIRM_TOKEN_TTL_MS` / `UNCONFIRMED_FOLLOW_TTL_MS`;
   - `EMAIL_CHANGE_TOKEN_TTL_MS`.

   It added **2 rows**, the agent-terminal ticket and the idea draft. The follow-confirm and email-change tokens are stored rows of their own feature and are not caches.

3. `git grep -niE 'mutex|semaphore|pg_advisory|EventEmitter|LISTEN ' origin/main -- lib app server.js`. Every lock is a Postgres advisory lock: `translationSingleFlight.ts`, `planChangeSessionRepository.ts:388`, `folderRepository`, `pageRepository`, `workItemTranslationRepository` and `platformAuditLogRepository`. The job queue's wake-up is Postgres `LISTEN/NOTIFY` (`lib/jobs/engine/notify.ts`). There is no module-scope `EventEmitter`. It added **2 rows**, advisory locks and LISTEN/NOTIFY.
4. `git grep -nE '\b(dedup|debounce|throttle|once)\w*\b'`, filtered to declarations. It found `lib/jobs/engine/debounce.ts`, whose debounce is a `runAt` on the job row in Postgres. It added no row: the debounce is part of the job row already covered by the LISTEN/NOTIFY row.
5. React `cache()`. `git grep -lE "import \{[^}]*\bcache\b[^}]*\} from 'react'"` returned 5 files, among them `getSession` in `lib/auth/index.ts` and `requirePlatformStaff` in `lib/platform/auth.ts`. It added **1 row**.
6. `code_explore { query: "in-process cache", repo: "motir-core" }` on the hosted graph. Its in-scope results were `allowedOrigins` `cache`, `appAuth` `cache`, `_resetAiPlanCache`, the React `cache()` callers and `PUBLIC_IDEAS_CACHE_CONTROL`. The last is an HTTP `Cache-Control` header (`s-maxage=300`) for a CDN, not process memory. The other results were in `lib/hooks/`, `tests/` and `packages/cli/`, all outside scope. It added nothing new.
7. The known rows the card names that no pattern can match: the Better-Auth limiter, the in-process `memory` backend of the v1 limiter, `ActivityThrottle`, `/api/workbench/stream`, `workbenchWatermarkService` and the MCP route. Each is a row marked _(not a grep hit)_.
8. Signed state that replaces storage: `lib/github/installState.ts` and `lib/gitlab/oauthState.ts` sign their state with `BETTER_AUTH_SECRET`, with a 600 s TTL. It added **1 row**.

## 5. Findings

Findings raised to the owner. None of them is decided here.

- **F1 — Better-Auth's limiter is the one row a second machine makes wrong, today.**
  - Each limit counts per machine, so the effective ceiling is `max × machines`. On two machines:
    - `/sign-in`, `/sign-up`, `/change-password` and `/change-email` allow 6 per 10 s, not 3;
    - `/request-password-reset` allows 6 per hour, not 3.
  - A limit also resets whenever a machine restarts.
  - The `auth:*` scopes in `lib/rateLimit/authGuard.ts` already count in Postgres (`rate_limit_counter`), so these are the library's own buckets layered on ours.
  - Postgres is enough, no broker. Better-Auth supports both `storage: "database"` (a `rateLimit` model through the Prisma adapter, with an atomic `incrementOne`) and a `customStorage` `{ consume }` that could write through the existing `sharedRateLimitStore()`. The choice is MOTIR-8613's.
- **F2 — `MOTIR_RATE_LIMIT_STORE=memory` is still a legal production setting.**
  - `resolveRateLimitBackend()` picks `postgres` whenever `DATABASE_URL` is set. Production therefore uses Postgres today, and `fly.toml` does not set the variable (checked at the ref).
  - Nothing refuses `memory` in a production build, though. Setting it would split every app-level and `/api/v1` limit per machine, the same failure as F1.
  - The card that adds the guard is MOTIR-8614.
- **F3 — four caches have no TTL and live until the machine restarts.**
  - The four:
    - `repoProvisioning.ts:207` `installationIdCache`;
    - `runGitCredential.ts:294` `botAuthors`;
    - `sentryErrorCount.ts:76` `projectIds`;
    - `imageCatalog.ts:90` `digestByTag`.
  - Each holds a value that is immutable in practice: our App's installation on our org, the App's bot slug, a Sentry project's id, an immutable image tag. A change is an operator action.
  - If one changes, a machine that cached the old value fails loudly rather than answering wrong. A dead installation id makes the token mint fail; the other cases follow the same logic. A redeploy clears all four.
  - They are classified **safe per instance**, with the bound written as "until restart". That is the honest number, and it is not a number of seconds. The owner may prefer a TTL.
- **F4 — Next.js's incremental cache is per machine, and harmless only because nothing uses it.**
  - Next 16 keeps ISR and data-cache entries on each machine's filesystem unless a `cacheHandler` is configured, and none is.
  - It is harmless today for two reasons. The `revalidatePath` calls in server actions target authenticated, dynamic routes, which have no full-route cache entry. The three `force-static` routes are built into the image, so they are byte-identical on every machine.
  - The first `export const revalidate`, ISR page or `unstable_cache` call would bring per-machine cache state: a `revalidatePath` on one machine would not reach the other.
- **F5 — the test doubles are per process, which bites the two-instance harness (MOTIR-8616), not production.**
  - The doubles: `lib/test-blob-mock.ts:38`, `lib/test-billing-mock.ts:271`, `lib/test-github-repos-mock.ts:183-185`, `lib/test-code-graph-mock.ts:69/108` and `lib/publicAddresses/providers.ts:94` `fakeTxt`.
  - A two-server lane that seeds one of them through one server and reads through the other will see an empty double.
  - The harness should keep both servers on doubles that hold no state between requests, or seed through both servers.
- **F6 — one claim here is inferred, not verified: the GitHub installation-token row.**
  - The row assumes that a token minted without a `repositories` list covers repositories added to the installation after the mint.
  - If GitHub instead fixes the repository set at mint time, a machine holding a token minted before a repository was added would refuse that repository for up to 3540 s, while the other machine accepts it. That would be stale-divergent, not wrong, and it applies equally to one machine.
  - This was not tested.

No bug was filed. Every row classified per instance is a classification, not a defect, and F1 and F2 already have cards (MOTIR-8613 and MOTIR-8614).

## 6. Summary

**33 rows: 9 shared, 24 safe per instance, 0 moved.** At the ref the sweep ran on, one row was **moved**: **Better-Auth's built-in rate limiter** (`lib/auth/index.ts`, library default `storage: "memory"`), with Postgres as its target. MOTIR-8613 moved it onto `rate_limit_counter` and the row now reads **shared**; that is the only class this document has changed since the sweep. The move card (MOTIR-8615) found nothing else to move.
