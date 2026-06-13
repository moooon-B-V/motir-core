import type { PlanStory } from '../types';

/**
 * Story 10.4 (Epic 10 — Platform administration & operations) — Test
 * infrastructure & CI performance. The OPERATIONS surface for the build
 * itself: keeping the CI pipeline that gates every PR fast as the suite
 * grows. Sits in Epic 10 (ops) rather than a product epic because it is
 * cross-cutting build infrastructure, not a user-facing capability.
 *
 * **Why this story exists now (finding #101, surfaced 2026-06-13).** The E2E
 * suite was sharded across a CI matrix (motir-core PR #882) — each leg on its
 * own ephemeral Postgres service container, `workers: 1` kept, wall-clock cut
 * from sum(specs) to max(leg). That made the **Vitest "integration + coverage"
 * job the next bottleneck**: ~11.5 min, of which ~99 % is the test step (setup
 * — install / generate / migrate — is ~40 s; v8 coverage instrumentation is
 * NOT the cost). It is slow because it is SERIAL: ~235 DB-backed test files run
 * one-at-a-time (`vitest.config.ts` `fileParallelism: false` +
 * `sequence.concurrent: false`) since every test imports the single `lib/db.ts`
 * `DATABASE_URL` client and resets via a global `TRUNCATE … CASCADE`
 * (`tests/helpers/db.ts`) — parallel forks on one DB would corrupt each other.
 *
 * **The fix is the standard, not a hack (the framing Yue locked in).**
 * Parallel test workers EACH BOUND TO THEIR OWN isolated database is the
 * industry-standard shape for DB-backed suites — Rails ships
 * `parallelize(workers: :number_of_processors)` (one database per worker);
 * Ecto's SQL Sandbox does connection-per-worker; mature Jest/Vitest suites use
 * the pool + a per-worker DB, commonly provisioned via Postgres
 * `CREATE DATABASE … TEMPLATE`. The genuinely non-standard thing is the CURRENT
 * single-shared-DB + `fileParallelism: false` setup — a deliberately-deferred
 * "serial is fine — total suite is small" call (the literal `vitest.config.ts`
 * comment) whose triggering condition (suite size) crossed the threshold
 * silently. So 10.4 brings the harness up to the standard.
 *
 * **The decisive constraint that picks IN-JOB over CI-sharding.** The coverage
 * gate is ~70 per-file ≥90 % thresholds in `vitest.config.ts`. In-job parallel
 * workers keep ONE Vitest run that aggregates v8 coverage across workers — the
 * thresholds need ZERO changes. Sharding across CI jobs (the E2E approach) would
 * fragment coverage and force a fiddly `nyc`-merge job that can't cleanly
 * replicate per-file-glob thresholds — bending the gate to dodge the root cause.
 * So 10.4 is explicitly in-job per-worker DB isolation, NOT a Vitest CI shard.
 *
 * **No design gate (Principle #13 does NOT fire).** This is test-harness /
 * config work — no UI surface, so no `design/` asset or `type: design`
 * dependency is required.
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** The single leaf
 * (10.4.1) depends on nothing — the real-Postgres harness it modifies already
 * exists (Epic-1 / Story 2.6 lineage), so `dependsOn: []` and the card is
 * `planned` (not `blocked`). No forward-pointing dep.
 */
export const story_10_4: PlanStory = {
  id: '10.4',
  title: 'Test infrastructure & CI performance',
  status: 'in_progress',
  gitBranch: 'feat/PROD-10.4-test-infra-ci-performance',
  descriptionMd:
    'The OPS surface for the build pipeline itself (Epic 10): keep CI fast as ' +
    'the test suite grows. After the E2E suite was sharded across a CI matrix ' +
    '(PR #882), the **Vitest "integration + coverage" job is the slowest check ' +
    'on every PR** (~11.5 min) — because ~235 DB-backed test files run ' +
    'SERIALLY (`fileParallelism: false`), sharing one Postgres + a global ' +
    'truncate. This story parallelizes that suite the standard way: **parallel ' +
    'Vitest workers, each bound to its own isolated database**.\n\n' +
    '**Posture (Yue, 2026-06-13 — "if the standard is parallel then we do it ' +
    'properly, we don\'t hack it"):** per-worker DB isolation is the industry ' +
    'standard (Rails `parallelize` = one DB per worker; Ecto SQL Sandbox; ' +
    'Jest/Vitest pool + per-worker DB via Postgres `TEMPLATE` clone). The ' +
    'current serial single-shared-DB setup is the non-standard thing the ' +
    'harness has OUTGROWN (the `vitest.config.ts` "serial is fine — total suite ' +
    'is small" comment is now stale at 235 files).\n\n' +
    '**Scope:** the in-job per-worker DB isolation refactor of the real-Postgres ' +
    'harness (10.4.1) — provision a database per Vitest worker, flip ' +
    '`fileParallelism: true`, keep the coverage gate byte-identical.\n\n' +
    '**Out of scope (named, not silently dropped):** sharding the Vitest suite ' +
    'across CI jobs + an `nyc` coverage-merge (deliberately NOT chosen — it ' +
    'would fragment the per-file coverage gate; in-job worker aggregation keeps ' +
    'it intact); a transaction-rollback-per-test (Ecto-sandbox) rewrite of the ' +
    'reset strategy (the truncate model is kept — only its DB is now ' +
    'per-worker); and the E2E sharding already shipped in PR #882.',
  verificationRecipeMd:
    '- Pull the Story branch. Run the full Vitest job locally the way CI does ' +
    '(`pnpm test:coverage` against a real Postgres) and confirm it now runs ' +
    'with `fileParallelism: true` across N workers — wall-clock drops ' +
    'materially vs. the prior serial run (target ~2–3× on a 4-vCPU runner).\n' +
    '- **Isolation holds.** Two tests that would collide on shared rows (e.g. ' +
    'both create a workspace with the same slug) pass when run in parallel ' +
    'workers — proving each worker has its own database, not a shared one.\n' +
    '- **Coverage gate unchanged.** The run still enforces the ~70 per-file ' +
    '≥90 % thresholds in `vitest.config.ts` with NO edits to the thresholds; a ' +
    'deliberately-dropped branch in a gated file still fails the run.\n' +
    '- **RLS / role survives cloning.** A worker DB still enforces the RLS ' +
    'policies + the non-bypass `prodect_app` role + the structural triggers the ' +
    'migrations create (cluster-level role persists across `CREATE DATABASE`); ' +
    'a per-worker smoke assertion proves it.\n' +
    '- **CI is green and faster.** The "Vitest (integration + coverage)" job ' +
    'passes on the PR and its wall-clock is down from the ~11.5 min baseline.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '10.4.1',
      title: 'Parallelize the Vitest integration suite via per-worker database isolation',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 90,
      descriptionMd:
        'Make the real-Postgres integration suite run in PARALLEL by giving ' +
        'each Vitest worker its OWN database, then flipping ' +
        '`fileParallelism: true`. The suite is serial today ' +
        '(`vitest.config.ts` `fileParallelism: false` + ' +
        '`sequence.concurrent: false`) ONLY because ~235 files share the single ' +
        '`lib/db.ts` `DATABASE_URL` client + a global `TRUNCATE … CASCADE` ' +
        '(`tests/helpers/db.ts`) — parallel forks on one DB corrupt each ' +
        'other. Per-worker DB isolation removes that constraint the standard ' +
        'way (Rails `parallelize` / Ecto sandbox / Vitest pool + per-worker DB).\n\n' +
        '**Design:**\n\n' +
        '1. **Provision a database per worker via a `globalSetup`.** In a Vitest ' +
        '`globalSetup` (runs once in the main process), clone the migrated ' +
        'database into N worker DBs with `CREATE DATABASE prodect_test_w<k> ' +
        'TEMPLATE <migrated_db>` (fast file-copy — avoids re-running migrations ' +
        'N times). N = the worker count (cap at CPU count; on the 4-vCPU CI ' +
        'runner that is 4). Teardown drops the worker DBs.\n' +
        '2. **Bind each worker to its DB before `lib/db.ts` loads.** Each worker ' +
        'derives `DATABASE_URL` from `process.env.VITEST_POOL_ID` (or ' +
        '`VITEST_WORKER_ID`) and MUST set it BEFORE the `db` singleton is first ' +
        'imported — the `forks` pool gives each worker its own module instance, ' +
        'so a distinct URL per worker = a distinct connection per worker. **The ' +
        'import-ordering is the main risk:** `lib/db.ts` reads the URL at ' +
        'module-eval, and the inngest `setupFiles' +
        '` (`tests/helpers/inngestSetup.ts`) already imports `db`, so the ' +
        'override must land earliest (a setup module ordered before it, or in ' +
        'the per-worker setup path).\n' +
        '3. **Flip `fileParallelism: true`** (and drop `sequence.concurrent: ' +
        'false` if no longer needed). The per-test `truncate*` helpers are ' +
        'UNCHANGED — they now only touch the worker’s own DB, so no cross-test ' +
        'bleed.\n' +
        '4. **Keep the coverage gate byte-identical.** A single Vitest run still ' +
        'aggregates v8 coverage across all workers, so `vitest.config.ts`’s ~70 ' +
        'per-file ≥90 % thresholds need ZERO changes. (This is the reason for ' +
        'in-job workers over CI-sharding — see the module header.)\n' +
        '5. **Prove the RLS surface survives cloning.** The migrations create ' +
        'RLS policies + the non-bypass `prodect_app` role + structural ' +
        'triggers. The role is CLUSTER-level so it persists across ' +
        '`CREATE DATABASE`; GRANTs/policies/triggers are copied by the ' +
        '`TEMPLATE`. Add a per-worker smoke assertion that a worker DB enforces ' +
        'them identically before trusting the isolation.\n\n' +
        '**Validate locally before pushing** (the sandbox has Postgres on ' +
        ':5433): create two template-clone DBs and run a small subset with ' +
        '`fileParallelism: true`, confirming no cross-worker row bleed and that ' +
        'the RLS smoke passes — CI then verifies the full gate. Do NOT run the ' +
        'whole suite locally (the shared :5433 + the project convention — ' +
        '`motir-core/CLAUDE.md`).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Vitest integration suite runs with `fileParallelism: true` across ' +
        'N workers (N ≤ CPU count), each worker bound to its OWN database ' +
        'provisioned by a `globalSetup` via `CREATE DATABASE … TEMPLATE`; the ' +
        'worker DBs are dropped on teardown.\n' +
        '- The "Vitest (integration + coverage)" CI job passes and its ' +
        'wall-clock is materially below the ~11.5 min serial baseline (target ' +
        '~2–3× on the 4-vCPU runner).\n' +
        '- The ~70 per-file coverage thresholds in `vitest.config.ts` are ' +
        'UNCHANGED and still enforced (a deliberately-dropped branch in a gated ' +
        'file still fails the run).\n' +
        '- Two tests that would collide on shared rows pass under parallel ' +
        'workers (isolation proven); a per-worker smoke assertion proves a ' +
        'cloned worker DB enforces the RLS policies + the `prodect_app` role + ' +
        'the structural triggers.\n' +
        '- The per-test `truncate*` reset model is kept (only its DB is now ' +
        'per-worker); no test is silently skipped or quarantined to make the ' +
        'parallel run pass.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/vitest.config.ts` — `fileParallelism` / ' +
        '`sequence.concurrent` (the flags to flip), `setupFiles`, and the ' +
        'per-file coverage thresholds (which must stay unchanged).\n' +
        '- `motir-core/tests/helpers/db.ts` — the global `truncate*` helpers ' +
        '(unchanged; now per-worker DB).\n' +
        '- `motir-core/tests/helpers/inngestSetup.ts` — the existing setup that ' +
        'imports `db` (the import-ordering constraint for the URL override).\n' +
        '- `motir-core/lib/db.ts` — the Prisma singleton that reads ' +
        '`DATABASE_URL` at module-eval (per-worker override target).\n' +
        '- `motir-core/prisma/` migrations — the RLS policies + `prodect_app` ' +
        'role + structural triggers the worker DBs must still enforce.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage gate; ' +
        'PRODECT_FINDINGS.md #101 (the originating finding); PR #882 (the E2E ' +
        'sharding this follows on from).',
      dependsOn: [],
    },
  ],
};
