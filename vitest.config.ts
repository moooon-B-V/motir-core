import { defaultExclude, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { TEST_DB_WORKERS } from './tests/helpers/parallelDb';
// MOTIR-3144 — the structural-guard lane's membership. Imported rather than
// restated so this config's `exclude` and that config's `include` cannot drift.
// ⚠️ Spelling `defaultExclude` back in is required: supplying `exclude` REPLACES
// Vitest's default, so omitting it would put `node_modules` and `dist` back into
// the run.
import { STRUCTURAL_GUARD_SPECS } from './tests/helpers/structuralGuardLane';

// Load .env into process.env before Vitest evaluates the test files. Next.js
// does this automatically at runtime; Vitest does not. Without this load,
// lib/db.ts throws "DATABASE_URL is not set" at module-import time and the
// suite fails before any test runs.
loadEnv();

// Test-only defaults for the env vars `lib/auth/index.ts` reads at module
// load. We do NOT overwrite anything a developer set in .env (override:false
// is dotenv's default). These placeholders only kick in when a CI/dev shell
// has nothing set — they let the auth module import without throwing, which
// is required for any test that touches Better-Auth's surface. They never
// reach a real OAuth server.
process.env['GOOGLE_CLIENT_ID'] ??= 'test-google-client-id';
process.env['GOOGLE_CLIENT_SECRET'] ??= 'test-google-client-secret';
process.env['BETTER_AUTH_SECRET'] ??= 'test-better-auth-secret-32-bytes-long-please';
// GitHub integration (Story 7.10 · MOTIR-1498). The encryption key is a fixed
// 64-hex test value (decodes to 32 bytes) so tokenCrypto round-trips in tests;
// the OAuth client id/secret let the identity service resolve config without a
// real GitHub app (the fetch calls are stubbed per-test). Never reach GitHub.
process.env['GITHUB_APP_CLIENT_ID'] ??= 'test-github-client-id';
process.env['GITHUB_APP_CLIENT_SECRET'] ??= 'test-github-client-secret';
process.env['GITHUB_TOKEN_ENCRYPTION_KEY'] ??=
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
// Linear import "Connect" OAuth app (Story 7.16 · MOTIR-1655). Client id/secret
// let linearImportOAuthService resolve config without a real Linear app (the
// token exchange is stubbed per-test); import-token encryption falls back to
// GITHUB_TOKEN_ENCRYPTION_KEY above. Never reach Linear.
process.env['LINEAR_OAUTH_CLIENT_ID'] ??= 'test-linear-client-id';
process.env['LINEAR_OAUTH_CLIENT_SECRET'] ??= 'test-linear-client-secret';
// Plane import "Connect" OAuth app (Story 7.16 · MOTIR-1656). Client id/secret
// let planeImportOAuthService resolve Cloud config without a real Plane app (the
// token exchange is stubbed per-test); import-token encryption falls back to
// GITHUB_TOKEN_ENCRYPTION_KEY above. Never reach Plane.
process.env['PLANE_OAUTH_CLIENT_ID'] ??= 'test-plane-client-id';
process.env['PLANE_OAUTH_CLIENT_SECRET'] ??= 'test-plane-client-secret';

// Vitest defaults to the Node environment for integration tests against a
// real Postgres. The first browser-style component test arrived in Story 1.4
// (the Markdown render smoke test): it opts into happy-dom per-file via a
// `// @vitest-environment happy-dom` directive at the top of the file, so the
// global default stays `node` and the DB-backed suites are unaffected. If
// component tests proliferate, split this into `vitest.workspace.ts` rather
// than dual-moding here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // MOTIR-3144 — the whole-tree structural guards run in their OWN job
    // (`vitest.guards.config.ts`, `structural-guards` in `ci.yml`), not here.
    //
    // They parse `lib/` + `app/` through the TypeScript compiler API and touch
    // no database. Inside this run they were competing for CPU with the suites
    // that make it slow, under v8 coverage instrumentation, on a 15 s
    // `testTimeout` sized for a query — and they timed out for reasons that had
    // nothing to do with what they check. `bare-transaction-guard` cost 8.1 s
    // alone and blew a 120 s hook budget on CI twice in a row.
    //
    // ⚠️ This is an EXCLUDE, not a duplicate. Unlike the design-asset lane —
    // whose specs stay in this list because that lane exists to run them on
    // MORE branches — the point here is that these stop executing in the
    // sharded job. The one list lives in `vitest.guards.config.ts` so the two
    // cannot drift, and `tests/ci-structural-guards-lane.test.ts` fails if a
    // whole-tree guard is missing from it.
    //
    // Locally: `pnpm test:guards`. They contribute no coverage to any gated
    // file (not one imports from `lib/` or `app/`), so the merged report is
    // unchanged by their absence.
    exclude: [...defaultExclude, ...STRUCTURAL_GUARD_SPECS],
    // Per-worker database isolation (Story 10.4.1). `globalDb` clones the
    // migrated base DB into one `…_test_wN` database PER worker before any
    // worker forks; `perWorkerDb` (FIRST setupFile — must run before
    // `inngestSetup`, which imports `@/lib/db`) rebinds DATABASE_URL to this
    // worker's clone before the `db` singleton reads it. That isolation is what
    // makes `fileParallelism: true` safe — each worker truncates only its OWN
    // database. See tests/helpers/parallelDb.ts for the shared wiring.
    globalSetup: ['./tests/setup/globalDb.ts'],
    // Setup order matters: perWorkerDb MUST precede inngestSetup. inngestSetup
    // stubs inngest.send to a no-op so the unconditional `work-item/created` +
    // `work-item/field.changed` emits (Subtask 6.6.2) don't throw on the
    // keyless test client. Event-asserting tests re-spy.
    // `actEnvironment` turns React's act environment ON for the happy-dom files
    // (it self-scopes on `window`, so the Node files are untouched). That makes
    // React flush passive effects synchronously inside RTL's act scopes, which
    // REMOVES the effect-ordering race class MOTIR-1736/1737 hit — see that file
    // for the mechanism and the contract it imposes on component tests.
    // `inFlightProbe` is LAST and is a no-op unless `MOTIR_INFLIGHT_PROBE=1`
    // (MOTIR-3077): it registers one `afterEach` that reads `pg_stat_activity`
    // for work this worker started and did not wait for. Off by default — it
    // costs a round trip per test and its import is dynamic, so an ordinary run
    // does not even construct the admin client.
    setupFiles: [
      './tests/helpers/perWorkerDb.ts',
      './tests/helpers/actEnvironment.ts',
      './tests/helpers/inFlightProbe.ts',
    ],
    // Cross-FILE parallelism is now safe (each worker has its own DB, above).
    // `sequence.concurrent` stays false so test()s WITHIN a file still run
    // sequentially against that worker's single connection. `maxWorkers` is
    // pinned to the worker-DB count (Vitest 4 top-level option) so
    // VITEST_POOL_ID never exceeds a provisioned database.
    fileParallelism: true,
    maxWorkers: TEST_DB_WORKERS,
    sequence: {
      concurrent: false,
    },
    testTimeout: 15_000,
    // MOTIR-1265 — give lifecycle hooks their own, larger budget. Vitest
    // defaults `hookTimeout` to 10s, which was BELOW the 15s `testTimeout` and
    // applied to the `beforeEach` `truncateAll()` every DB-backed suite runs.
    // The multi-table `TRUNCATE … CASCADE` is legitimately variable under the
    // concurrent-worker CI load (see tests/setup/globalDb.ts, where
    // `synchronous_commit = off` now removes the fsync stall that was the root
    // cause); this headroom keeps a rare IO spike from red-lighting the whole
    // job (which, via merge-with-main CI, taxes every open PR). Belt-and-braces
    // with the globalDb fix — not a substitute for it.
    hookTimeout: 30_000,
    // Coverage (Subtask 1.4.7, extended by 2.6.4). The Epic-2 load-bearing
    // modules must stay at ≥90% branches/functions/lines. 1.4.7 gated the
    // work-item data model — the service + its three repositories. 2.6.4 adds
    // the Story-2.2 workflow layer (`workflowsService` + `workflowsRepository`)
    // to the gate, closing coverage-gap #4: that layer shipped ungated, and
    // `workItemsService` grew across Stories 2.3–2.5 (detail / tree / list /
    // pagination) after the 1.4.7 numbers were measured. 4.1.4 adds
    // `backlogService` (issue↔sprint association + backlog rank + the bounded
    // reads). 4.6.7 adds the Story-4.6 reports layer — `reportsService` (the
    // burndown + velocity aggregates) + `reportsMappers` + `sprintRepository`
    // (grown by 4.6.4's bounded completed-sprints read) + the 4.6.2 chart
    // primitives. We scope `include` to exactly these files so the report (and
    // the per-file thresholds below) stays focused on the surface this Epic is
    // responsible for, rather than diluting the signal across the whole tree.
    // Other modules carry their own coverage stories in their own Subtasks. v8
    // is the provider (matches @vitest/coverage-v8).
    //
    // ⚠️ A FILE UNDER A NEXT.JS ROUTE GROUP IS ENTERED AS `app/**/…`, NEVER AS
    // ITS LITERAL PATH (MOTIR-2449). `(authed)` is a real directory on disk, but
    // `(` is GROUPING SYNTAX to picomatch/tinyglobby — the matchers the coverage
    // provider uses — so `app/(authed)/settings/…` resolves to no file at all.
    // The file then never enters the report, and a `thresholds` key naming it
    // gates nothing: an unmatched key is not an error in Vitest, it is an empty
    // coverage map that passes every percentage. Twenty entries sat in exactly
    // that state, silently, until `tests/coverage-gate-globs.test.ts` was
    // written — that test now fails the build on any pattern or key that reaches
    // no file, in EITHER half, so this comment is a courtesy and not the guard.
    coverage: {
      provider: 'v8',
      include: [
        // Story MOTIR-3440 · Subtask MOTIR-3449 — the two ARRIVAL PRIMITIVES this
        // story added. `PageSkeleton` is the wrapper/header/reveal every in-page
        // frame composes (MOTIR-3531); `SettingsPaneFrame` is the settings
        // family's pane frame, which all eleven settings panes mount (MOTIR-3558).
        // Both are pinned in `thresholds` below and both were MEASURED first, per
        // the note above: 100 statements / 100 branches / 100 functions / 100
        // lines apiece, on this branch.
        //
        // ⚠️ THE STORY'S SEVENTEEN CHANGED `page.tsx` FILES ARE NOT HERE, and
        // that is a stated gap rather than an oversight. They are async Server
        // Components: covering one in vitest means rendering it, and rendering it
        // means AWAITING it — which is the opposite of the pending state this
        // story is about. Their behaviour is asserted structurally instead
        // (`tests/navigation/*-arrival.test.ts`, 59 tests) and end to end.
        //
        // ⚠️ CORRECTED (MOTIR-3568) — THE REASON GIVEN HERE WAS "this repo has
        // no RSC render harness, so no `app/**/page.tsx` has ever been in this
        // report", AND BOTH HALVES WERE FALSE WHEN IT WAS WRITTEN. Six route
        // components were already in this list — `app/**/docs/page.tsx`,
        // `docs/api/page.tsx`, `docs/api/getting-started/page.tsx`,
        // `docs/api/stability/page.tsx`, `docs/sandbox/page.tsx` (all five also
        // GATED at 90/90/90 in `thresholds`) and `docs/layout.tsx` — and Story
        // 11.4 covered them by RENDERING them, with a `renderPageToHtml` helper
        // over `react-dom/server.edge` declared in three `tests/api-docs/*`
        // suites. Four `tests/planning/*` suites `await` a page and walk the
        // returned tree. The technique existed in seven files; what did not
        // exist was one place to find it and the request-scoped shims an AUTHED
        // page needs.
        //
        // The true statement is narrower and is now the one this file makes: no
        // page under `app/(authed)` had ever been in the report. Five of them
        // are, REPORT-ONLY, in the MOTIR-3568 block below, and the harness they
        // are covered by is `tests/helpers/serverPageHarness.tsx`. The seventeen
        // stay out until somebody measures them, which is this list's own rule
        // rather than a verdict about what is renderable.
        'components/ui/PageSkeleton.tsx',
        'components/settings/SettingsPaneFrame.tsx',
        // Story 8.9 (Follow the build) · Subtask 8.9.8 — the files this story
        // adds that carry LOGIC. MEASURED on this branch before being pinned,
        // per the note above.
        //
        // ⚠️ The story's `app/**` surfaces are NOT here, for the reason the
        // block above gives: the changelog page, the feed route, the two follow
        // landings and the two API routes are async Server Components and route
        // handlers, and this repo has no RSC render harness. They are asserted
        // through their services (`tests/publicProjects`), through the island's
        // own component test, and end to end by 8.9.9.
        'lib/publicProjects/followTokens.ts',
        'lib/publicProjects/changelogCursor.ts',
        'lib/publicProjects/atomFeed.ts',

        // Story 8.4 · Subtask MOTIR-1135 — capturing what a person agreed to and
        // asking again when a document MATERIALLY changes. MEASURED first, per
        // the note above: **100 statements / 100 branches / 100 functions / 100
        // lines on every one of these five files**, over `tests/legal/` on this
        // branch, so the floors below are a ratchet under a real number rather
        // than an aspiration.
        //
        // The surface earns a gate because what it enforces is a CLAUSE, not a
        // feature: `motir.co/legal/terms` §14 promises that non-material
        // changes take effect when published with no prompt, and `consent.ts`'s
        // MAJOR/MINOR-vs-PATCH rule is the whole of how that promise is kept. A
        // regression there is a broken published promise that no other test in
        // the tree would catch.
        //
        // ⚠️ `app/(auth)/re-consent/**` IS NOT HERE. Its two islands are covered
        // by `tests/components/reconsent-card.test.tsx` and its behaviour end to
        // end by MOTIR-1137, and nobody has measured the page itself.
        // (This note used to give the reason as "this repo has no RSC render
        // harness". That was false when written and is corrected in the
        // MOTIR-3449 block above; a harness now exists at
        // `tests/helpers/serverPageHarness.tsx`, so the page is a MEASURE-then-pin
        // candidate like any other file rather than an impossibility.)
        'lib/legal/consent.ts',
        'lib/legal/documents.ts',
        // MOTIR-4010 — where the three legal surfaces point once the documents are
        // configuration. Pinned with its siblings: a wrong answer here is a link
        // to a document nobody published, or a rail door that vanishes.
        'lib/legal/links.ts',
        'lib/legal/reconsentGate.ts',
        'lib/repositories/legalAcceptanceRepository.ts',
        // Story MOTIR-4669 · MOTIR-4684 — the repository-tenancy surface. Each
        // MEASURED on this branch before being pinned below, per the note above:
        // statements 96.61 / branches 85.56 / functions 100 / lines 98.35 across
        // the five together, with every remaining arm dispositioned on the card.
        'lib/services/organizationRepoService.ts',
        'lib/services/organizationAccessService.ts',
        'lib/settings/organizationSettingsNav.ts',
        'lib/mappers/organizationRepoMappers.ts',
        'lib/projectRepos/roomSections.ts',
        'lib/services/legalAcceptanceService.ts',
        // Story 8.4 · Subtask MOTIR-3698 — the data-subject-request SUBSTRATE
        // (account erasure + personal-data export). All three MEASURED at
        // 100/100/100/100 on this branch before being pinned, per the note at
        // the top of this block. The two windows and both repositories are what
        // 8.4.18-8.4.23 all read or write, so a regression here is a regression
        // in every slice above them.
        'lib/users/dataSubjectRequests.ts',
        'lib/repositories/accountDeletionRequestRepository.ts',
        'lib/repositories/dataExportRequestRepository.ts',
        // Story 8.4 · Subtask MOTIR-3700 — the schedule/cancel WRITE that sits on
        // that substrate, and the sign-in seam that cancels. Both MEASURED at
        // 100/100/100/100 on this branch before being pinned. They are gated for
        // the reason the substrate is: an account deletion is the most
        // destructive thing a reader can ask for, and the two arms a regression
        // would silently take out — the `P2002` translation and the best-effort
        // catch around the post-commit sign-out — are exactly the ones no
        // happy-path test exercises. (`lib/auth/accountDeletionCancellation.ts`
        // stood beside it until MOTIR-3742 removed the sign-in cancel.)
        'lib/services/accountDeletionService.ts',
        // Story 8.4 · Subtask MOTIR-3702 — the ERASURE SWEEP that acts on those
        // rows: the vocabulary, the service that performs the three DECISION 3
        // groups, and the cron definition that runs it. All three MEASURED at
        // 100/100/100/100 on this branch before being pinned, per the note at
        // the top of this block. Gated for a reason stronger than the two above
        // it: this is the only code in the product that makes
        // `motir.co/legal/privacy` §6's *"we erase or anonymise within 30
        // days"* true, and the arms a regression would take out silently — the
        // status re-read under the lock that makes a day-29 cancel stick, the
        // per-account catch that stops one failure holding the queue, the
        // organization block re-checked at erasure time — are exactly the ones
        // no happy-path test exercises. The job DEFINITION is included as well
        // (unlike `attachmentGc`, and like `codeGraphOffboardSweep`): a
        // retention sweep whose handler never runs is a window the product
        // states and never enforces.
        'lib/users/accountErasure.ts',
        'lib/services/accountErasureSweepService.ts',
        'lib/jobs/definitions/accountErasureSweep.ts',
        'lib/repositories/publicFollowRepository.ts',
        'lib/services/publicFollowService.ts',
        'lib/services/publicFollowDigestService.ts',
        // Story MOTIR-2256 · Subtask MOTIR-2302 — the permission MODEL and its
        // enforcement seam. Every administrative gate in the product now routes
        // through these four files, and until this story they were not in the
        // coverage report at all, so the ≥90% per-file gate never applied to the
        // code that decides who may do what.
        //
        // ⚠️ REPORT-ONLY, deliberately: they are added to `include` but NOT to
        // `thresholds` below, so CI publishes the number without gating on one
        // nobody has measured. The honest sequence is measure first, then pin —
        // pinning a threshold blind is how a gate gets loosened later to make a
        // build pass, which is worse than not having it. The follow-up is to read
        // the number off the first CI run and add the four `thresholds` entries.
        // Story MOTIR-3414 · Subtask MOTIR-3426 — the Postgres job engine and the
        // three repositories it added. The story gate MEASURED every file before
        // pinning it below: 98.8 statements / 95.7 branches / 99.0 functions /
        // 99.7 lines over the set, with every FILE clearing 90 on all four axes.
        // Pinned at the project's 90 rather than at the measurement, so ordinary
        // churn does not fail the build while a real regression does.
        // Story MOTIR-1789 (Agent runs) — the DISPATCH RUN seam's own files, and
        // the point of naming them here is that until now NONE of the story's
        // surface was in the report at all, so the ≥90% per-file gate has never
        // applied to a line of it.
        //
        // ⚠️ NO LONGER REPORT-ONLY — MOTIR-1798 MEASURED THEM AND PINNED THEM,
        // which is the sequence the blocks above state. The numbers it read, over
        // the eleven suites that import these files (nothing else does, so that
        // is a COMPLETE measurement for them):
        //
        //   dispatchRunMappers          100 / 100 / 100 / 100
        //   dispatchRunRepository       100 / 100 / 100 / 100
        //   dispatchRunCardRepository   100 / 100 / 100 / 100
        //   dispatchRunEventRepository  100 / 100 / 100 / 100
        //   dispatchRunService          96.61 S / 90.71 B / 100 F / 96.15 L
        //
        // Two of them only reached those numbers because the measurement named
        // the gaps and tests were written for them: the repositories' CURSOR
        // arms had never once been taken (`skip: 1` is what stops a page
        // repeating its anchor row), and the service was at 87% branches until
        // its edges — a scope that resolves to nothing, a leg moving OFF
        // `skipped`, the event cap, a run with no events — were covered.
        // The floor was never lowered and nothing was excluded.
        'lib/services/dispatchRunService.ts',
        'lib/repositories/dispatchRun*.ts',
        'lib/mappers/dispatchRunMappers.ts',
        'lib/jobs/engine/**',
        'lib/repositories/jobQueueRepository.ts',
        'lib/repositories/jobStepRepository.ts',
        'lib/repositories/jobEventRepository.ts',
        // Story MOTIR-3758 · Subtask MOTIR-3766 — the story gate adopts the
        // platform-health service, which this story extended with the queue
        // backlog reading (`readQueueHealth`) that `/api/health/queue` serves.
        // It was NOT gated before, and a file an external monitor depends on is
        // exactly the wrong place for coverage to be nobody's business. MEASURED
        // on this branch over `tests/platform`: 100 statements / 95.45 branches /
        // 100 functions / 100 lines. Pinned at the project's 90, not at the
        // measurement, so ordinary churn does not fail the build.
        'lib/services/platformHealthService.ts',
        // Story MOTIR-3416 · Subtask MOTIR-3472 — the SCHEDULED cutover's own new
        // surface. `lib/jobs/engine/scheduler.ts` needs no entry: the glob above
        // is a glob precisely so a new engine file joins the gate without anyone
        // remembering, and the story gate measured it at 100/100/100.
        //
        // `catchUp.ts` is GATED (it measured 100 and is a const vocabulary, so
        // there is nothing for churn to erode). `defineJob.ts` is REPORT-ONLY —
        // added to `include`, deliberately NOT to `thresholds` — by the same rule
        // the two blocks below state: it measures 90.9 statements / 80 branches
        // over `tests/jobs/`, and the branches BELOW 90 are pre-existing arms of
        // the Inngest wrapper this story did not touch (this story's own change
        // RAISED it from 78). Pinning it at 90 now would mean covering someone
        // else's surface to land a scheduler; publishing the number is the honest
        // step, and the pin belongs to whoever owns that gap.
        'lib/jobs/catchUp.ts',
        'lib/jobs/defineJob.ts',
        'lib/permissions/**',
        'lib/services/projectAccessService.ts',
        // Story MOTIR-2765 · Subtask MOTIR-2771 — the acceptance-receipt freeze.
        // Same finding as the block above, on a different surface: the evidence
        // service, its repository and its typed errors were NOT in the coverage
        // report at all, so the ≥90% per-file gate never applied to the code that
        // decides whether a human's approval can be overwritten. MOTIR-2764 put a
        // refusal there; this makes the number visible.
        //
        // ⚠️ REPORT-ONLY for the same reason and by the same rule: added to
        // `include`, deliberately NOT to `thresholds`, so CI publishes a number
        // nobody has measured yet rather than pinning one blind. Read it off the
        // first CI run and pin then — `tests/coverage-gate-globs.test.ts` fails
        // the build on a key that reaches no file, so the pin cannot be vacuous.
        'lib/acceptanceEvidence/**',
        'lib/services/acceptanceEvidenceService.ts',
        'lib/repositories/acceptanceEvidenceRepository.ts',

        // Story MOTIR-2554 · Subtask MOTIR-2558 — the shell's CONTEXT PATH.
        // `ShellTierNav` decides which tiers a person sees at which width (the
        // ladder in `design/shell/design-notes.md` § *The context row*) and
        // `ProjectTier` decides which of three states the last tier is in. Both
        // are new decision code on the one row every authed screen renders, and
        // neither was in the report before this story. `TopNav` joins them
        // because it is the host whose props the two now depend on.
        //
        // The glob form is the `app/**/…` one for the reason the block comment
        // above gives: a literal `app/(authed)/…` key matches no reported file
        // and would gate nothing.
        'app/**/_components/ShellTierNav.tsx',
        'app/**/_components/ProjectTier.tsx',
        'app/**/_components/TopNav.tsx',

        // Story MOTIR-2258 · Subtask MOTIR-2476 — the permission-gated shell.
        // The two registries are the load-bearing new code (one decides which
        // settings rooms exist for an actor, the other which nav destinations
        // do), and the guard that refuses a hidden destination is the file that
        // keeps hiding from becoming the whole story. GATED, not report-only:
        // all three are new in this story, so there is no pre-existing number to
        // pin blind.
        //
        // ⚠️ WRITTEN WITH `app/**/`, NOT `app/(authed)/` — a route group's
        // parentheses are extglob syntax to the matcher v8 globs with, so a
        // literal path matches nothing and the file silently never enters the
        // report (MOTIR-2449; `tests/coverage-gate-globs.test.ts` fails the build
        // on any pattern that reaches nothing).
        'lib/settings/projectSettingsNav.ts',
        'lib/settings/projectNavAccess.ts',
        'app/**/_components/ProjectAccessProvider.tsx',

        // Story MOTIR-3878 · Subtask MOTIR-4223 — customer-owned addresses, the
        // whole surface the story's ten motir-core cards added. MEASURED first
        // and pinned below, the sequence this block follows everywhere.
        //
        // ⚠️ `app/**/`, NOT `app/(authed)/`, for the reason the block above
        // records: a route group's parentheses are extglob syntax to the
        // matcher, so a literal path matches nothing and the file silently never
        // enters the report.
        'lib/publicAddresses/**',
        'lib/repositories/publicAddressRepository.ts',
        'lib/services/publicSubdomainService.ts',
        'lib/services/customDomainService.ts',
        'lib/services/publicAddressesService.ts',
        'lib/services/publicAddressCertificatesService.ts',
        'lib/jobs/definitions/publicAddressCertificateRefresh.ts',
        'app/api/public/hosts/**/route.ts',
        'app/api/workspaces/**/public-subdomain/route.ts',
        'app/api/projects/**/public-addresses/**/route.ts',
        'app/**/settings/project/public-address/_components/*.tsx',

        // Story MOTIR-1215 · Subtask MOTIR-3646 — the require-2FA control and
        // its Server Action. MEASURED at 100/100/100/100 each before being
        // pinned below, the sequence this block follows everywhere.
        //
        // ⚠️ THE PAGE ITSELF IS NOT HERE, and that is the family's stated gap
        // rather than an omission: no `app/**/page.tsx` has ever entered this
        // report (an async Server Component would have to be awaited to be
        // covered, and this repo has no RSC render harness). Its behaviour is
        // asserted structurally in `tests/navigation/settings-workspace-org-arrival.test.ts`
        // and by the route SMOKE in `tests/components/org-security-pane.test.tsx`.
        //
        // The COMPONENT is the piece worth gating: MOTIR-3647 mounts this same
        // file at the workspace tier, so a regression here breaks two surfaces.
        // Story MOTIR-3808 · Subtask MOTIR-3816 — the to-do list's whole
        // surface, measured before being pinned below.
        //
        // ⚠️ THE TWO `app/` ENTRIES ARE `app/**`, NOT THEIR LITERAL PATHS. They
        // live under `app/(authed)/items/[key]/`, and `(` is GROUPING SYNTAX to
        // picomatch — the literal path matches no file, the entry gates nothing,
        // and the threshold beside it passes vacuously (MOTIR-2449, the note at
        // the head of this block). Measured through the `app/**` form:
        // TodoListSection 99.35 / 90.58 / 100 / 100, and the service+repository+
        // mapper+DTO group 98.58 / 94.59 / 100 / 98.40.
        'lib/repositories/workItemTodoRepository.ts',
        'lib/services/workItemTodosService.ts',
        'lib/dto/workItemTodos.ts',
        'lib/mappers/workItemTodoMappers.ts',
        'lib/workItemTodos/limits.ts',
        'lib/workItemTodos/errors.ts',
        'app/**/items/[key]/todoActions.ts',
        'app/**/items/[key]/_components/TodoListSection.tsx',
        'app/**/_components/RequireTwoFactorCard.tsx',
        'app/**/organization/security/actions.ts',
        // Story MOTIR-1215 · Subtask MOTIR-3647 — the workspace tier's action and
        // the fold-in that gained the control's SECOND home. Measured at
        // 100/100/100/100 apiece before pinning.
        'app/**/workspace/security/actions.ts',
        'app/**/_components/WorkspaceFoldInSection.tsx',
        // Story MOTIR-1215 · Subtask MOTIR-3648 — the enforcement gate and the
        // screen it holds people at. Measured at 100/100/100/100 apiece.
        'lib/auth/twoFactorGate.ts',
        // Story MOTIR-1215 · Subtask MOTIR-3653 — the API half of the same gate,
        // and the module ~190 route files now authenticate through. Measured at
        // 100/100/100/100 before pinning.
        'lib/auth/requireCompliantSession.ts',
        'app/**/two-factor-required/page.tsx',
        'app/**/two-factor-required/_components/SignOutLink.tsx',
        // …and the island that tells the server gate to look again once a
        // second factor lands. Without it the satisfied panel above is
        // unreachable and a person who enrols stays held. Measured at
        // 100/100/100/100.
        'app/**/two-factor-required/_components/HeldEnrolment.tsx',
        // ⚠️ `_guard.tsx` is REPORT-ONLY (below `thresholds`), and the reason is
        // worth stating rather than quietly omitting: MOTIR-2476 measured it at
        // 50% lines, and the uncovered half is `guardSettingsPage`'s body — one
        // service round trip and two translation lookups, reachable only with a
        // database. Its DECISION (`resolveSettingsRefusal`) and its RENDER
        // (`SettingsRefusalState`) were split out for exactly this reason and are
        // both fully covered. Pinning 90 here would either gate on a number the
        // unit suite cannot reach, or invite mocking the access service in a
        // component test — and the repo's rule is one mock, `getSession`. The
        // honest sequence is the one this file already follows twice above:
        // measure first, publish the number, pin it when the DB-backed arm lands.

        // Story MOTIR-2282 · Subtask MOTIR-2264 — the Roles & permissions
        // screens and the read behind them. The two files above were already
        // report-only; these are the surface THIS story added or widened, and
        // the four that are new code are GATED in `thresholds` below.
        //
        // ⚠️ `lib/repositories/projectMembershipRepository.ts` is REPORT-ONLY on
        // purpose, exactly like `projectAccessService.ts`: this story added one
        // method to a file most of which predates it, and pinning the whole file
        // at 90% would gate code no card here wrote or tested. Measuring it is
        // the honest first step; the pin belongs to whoever owns that surface.
        'lib/mappers/permissionMappers.ts',
        'lib/settings/projectSettingsNav.ts',
        'lib/repositories/projectMembershipRepository.ts',
        // ⚠️ WRITTEN WITH `app/**/`, NOT `app/(authed)/`, AND THAT IS LOAD-BEARING.
        // A route-group segment's parentheses are extglob syntax to the matcher
        // v8 coverage globs with, so a LITERAL `app/(authed)/…` path matches
        // nothing and the file silently never enters the report. Measured on this
        // branch: the same four files enter it under `app/**/…` and are absent
        // under `app/(authed)/…`. See MOTIR-2449 — four component thresholds
        // already in this file are keyed the literal way and are therefore inert.
        'app/**/settings/project/roles/_components/*.tsx',

        // Story MOTIR-2257 · Subtask MOTIR-2486 (the story gate) — the custom-role
        // WRITE surface. `lib/permissions/**` above already reported the policy
        // modules; these are the service, the repository and the two route
        // handlers this story added, and all four are GATED below.
        //
        // ⚠️ WRITTEN WITH `**`, NOT A LITERAL `[key]`, FOR THE SAME REASON THE
        // ROUTE-GROUP NOTE ABOVE GIVES — and it is a DIFFERENT syntax biting: in
        // a glob, `[key]` is a CHARACTER CLASS matching one of `k`/`e`/`y`, so a
        // literal `app/api/projects/[key]/roles/route.ts` names a directory
        // called `k`. `tests/coverage-gate-globs.test.ts` fails the build on
        // either mistake rather than passing vacuously.
        'lib/services/projectRoleDefinitionService.ts',
        'lib/repositories/projectRoleDefinitionRepository.ts',
        'app/api/projects/**/roles/route.ts',
        'app/api/projects/**/roles/**/route.ts',

        // Story 5.7 (in-app notifications) · Subtask 5.7.6 — the per-user
        // notification-preference layer (the channel gate) lands gated.
        'lib/services/notificationPreferencesService.ts',
        'lib/repositories/notificationPreferenceRepository.ts',
        'lib/mappers/notificationPreferenceMappers.ts',
        'lib/notifications/preferences.ts',
        // Story 5.7 · Subtask 5.7.7 — the in-app model + fan-in + read/mark API
        // service/repo/job logic (5.7.2–5.7.4) joins the gate, completing the
        // story's coverage contract (the 5.7.6 preference layer is gated above).
        'lib/repositories/notificationRepository.ts',
        'lib/services/notificationsService.ts',
        'lib/services/notificationFanInService.ts',
        'lib/jobs/definitions/notificationFanIn.ts',
        'lib/notifications/errors.ts',
        'lib/services/workItemsService.ts',

        // Bug MOTIR-3050 — the blocker-readiness classifier, LIFTED OUT of
        // `workItemsService` (gated just above) so `plansService.materialize`
        // can reach the same rule when it chooses a materialized add's birth
        // status. Moving gated code into an ungated file would have quietly
        // dropped it out of the report, so it is re-entered here and pinned at
        // the same 90 the file it came from carries. Measured on this branch
        // before pinning: 100 lines / 100 functions / 100 branches.
        'lib/workItems/blockerReadiness.ts',
        // ⚠️ ADDED BY THE STORY GATE (MOTIR-3001 · MOTIR-3200). The ready
        // FILTER shape has never been in the report at all — not gated at a low
        // number, absent — which is the state this config's own header calls
        // out: "the file then never enters the report, and a `thresholds` key
        // naming it is a key nobody checks." MOTIR-3196 put two new axes, a
        // reserved literal and a typed refusal in it, so it is entered and
        // pinned here. Measured on this branch before pinning, over
        // `tests/ready/` + the two ready route/vocabulary files:
        // 95.83 lines / 100 functions / 93.33 branches.
        'lib/workItems/readyFilter.ts',
        'lib/services/backlogService.ts',
        'lib/repositories/workItemRepository.ts',
        'lib/repositories/workItemLinkRepository.ts',
        'lib/repositories/workItemRevisionRepository.ts',
        'lib/services/workflowsService.ts',
        'lib/repositories/workflowsRepository.ts',
        'lib/services/reportsService.ts',
        'lib/mappers/reportsMappers.ts',
        'lib/repositories/sprintRepository.ts',
        'components/ui/charts/scale.ts',
        'components/ui/charts/LineChart.tsx',
        'components/ui/charts/BarChart.tsx',
        'components/ui/charts/ChartFrame.tsx',
        'components/ui/charts/ChartLegend.tsx',
        'components/ui/charts/ChartDataTable.tsx',
        // Story MOTIR-2542 · Subtask MOTIR-2550 — the AI entitlement predicates.
        // Two one-line pure functions, and the reason they are gated is that the
        // defect they fix was a surface reading a raw DTO field instead of
        // asking them. Gated in `thresholds` below.
        'lib/billing/aiEntitlement.ts',
        'lib/repositories/commentRepository.ts',
        'lib/repositories/commentMentionRepository.ts',
        'lib/services/commentsService.ts',
        'lib/mappers/commentMappers.ts',
        'lib/mentions/parse.ts',
        // Story 5.4 labels/components/watchers (5.4.1) — the five data-access
        // leaves ship gated from day one; the services join in 5.4.2–5.4.4.
        'lib/repositories/labelRepository.ts',
        'lib/repositories/workItemLabelRepository.ts',
        // 5.4.2 — the folksonomy service layer.
        'lib/services/labelsService.ts',
        'lib/mappers/labelMappers.ts',
        'lib/repositories/componentRepository.ts',
        'lib/repositories/workItemComponentRepository.ts',
        'lib/repositories/watcherRepository.ts',
        'lib/services/activityService.ts',
        'lib/activity/renderers.ts',
        'lib/mappers/activityMappers.ts',
        // Story 5.3 custom fields — the three data-access leaves (5.3.1) +
        // the definitions half of the service and its mappers (5.3.2); the
        // values half (5.3.3) extends the same service file under this gate.
        'lib/repositories/customFieldDefinitionRepository.ts',
        'lib/repositories/customFieldOptionRepository.ts',
        'lib/repositories/customFieldValueRepository.ts',
        'lib/services/customFieldsService.ts',
        'lib/mappers/customFieldMappers.ts',
        // Story 5.2 (attachments): the service joins the gate with 5.2.7's
        // orphan-GC sweep (the 2.3.7 upload half already carries its tests);
        // the repo leaf + the panel mapper join with 5.2.2's management
        // surface.
        'lib/services/attachmentsService.ts',
        'lib/repositories/attachmentRepository.ts',
        'lib/mappers/attachmentMappers.ts',
        // Story 6.2 (saved filters): the persistence + permission layer
        // (Subtask 6.2.1) gates from day one — the matrix, the envelope
        // round-trip, and the degraded-state branches are the contract.
        'lib/services/savedFiltersService.ts',
        'lib/repositories/savedFilterRepository.ts',
        'lib/repositories/savedFilterStarRepository.ts',
        'lib/mappers/savedFilterMappers.ts',
        'lib/savedFilters/access.ts',
        'lib/savedFilters/builtins.ts',
        // Story 6.3 (dashboards): the grid substrate (Subtask 6.3.1) gates
        // from day one — the TOTAL widget registry, the permission rule,
        // the cap, and the move ordering are the contract.
        'lib/services/dashboardsService.ts',
        'lib/repositories/dashboardRepository.ts',
        'lib/repositories/dashboardWidgetRepository.ts',
        'lib/mappers/dashboardMappers.ts',
        'lib/dashboards/widgetRegistry.ts',
        // Story 6.3 (dashboards & reports): the 6.3.2 widget/report data
        // reads — the statistic-type registry, the window/bucket math, and
        // the route param parsers gate from day one (the service / repo /
        // mapper halves extend already-gated files above).
        'lib/reports/statisticTypes.ts',
        'lib/reports/buckets.ts',
        'lib/reports/params.ts',
        // Story 6.6 (automation rules): the 6.6.1 schema/registry/service
        // backend gates from day one — the TOTAL trigger/action registries,
        // the admin-gated CRUD + caps, the stored-envelope round-trip, and the
        // condition degraded-state branch are the contract (no engine yet —
        // 6.6.2).
        'lib/automation/registry.ts',
        'lib/automation/fields.ts',
        'lib/automation/constants.ts',
        'lib/services/automationRulesService.ts',
        'lib/repositories/automationRuleRepository.ts',
        'lib/mappers/automationRuleMappers.ts',
        // 6.6.2 — the execution engine + its audit-row leaf join the gate.
        'lib/services/automationEngineService.ts',
        'lib/repositories/automationRuleExecutionRepository.ts',
        // Story 7.8 (MCP server) · Subtask 7.8.1 — the PAT auth substrate
        // every other 7.8 subtask rides gates from day one: the create/verify/
        // revoke lifecycle, the secret-never-persisted fence, and the
        // last-used throttle are the contract. (7.8.9 extends the gate to the
        // MCP registry + tool modules.)
        'lib/services/apiTokensService.ts',
        'lib/repositories/apiTokenRepository.ts',
        'lib/mappers/apiTokenMappers.ts',
        'lib/apiTokens/token.ts',
        'lib/apiTokens/errors.ts',

        // Story MOTIR-2572 · Subtask MOTIR-2585 (the story gate) — what a token
        // GRANTS, and the surfaces that offer and render it. This story replaced
        // the six 7.7-era scope strings with the MOTIR-2254 permission catalog,
        // and none of the code that does it was in the coverage report before.
        //
        // GATED, not report-only: every file here is new in this story (or, for
        // `scopes.ts`, reduced to the legacy-expansion table this story wrote),
        // so there is no pre-existing number that a 90 would retroactively
        // gate — the honest-sequence caveat the blocks above give does not
        // apply. All eight were MEASURED at or above the floor before being
        // pinned; the lowest is `CreateTokenModal.tsx` at 90.9% branches.
        //
        // ⚠️ `app/**/`, NOT `app/(authed)/` — the route-group parentheses are
        // extglob syntax to the matcher, so a literal path silently matches
        // nothing (MOTIR-2449).
        'lib/tokens/grant.ts',
        'lib/mcp/toolPermissions.ts',
        'lib/mcp/permissionGate.ts',
        'lib/mcp/scopes.ts',
        // Bug MOTIR-3342 — the UNKNOWN-ARGUMENT gate at the same registration
        // seam as `permissionGate.ts` above, and gated on the same terms. It
        // decides whether an argument a caller mis-spelled is refused or
        // silently deleted, which is exactly the kind of decision that must not
        // ship un-measured: the defect it fixes lost three cards' whole bodies
        // under a success line. MEASURED on this branch before pinning.
        'lib/mcp/strictInput.ts',
        'app/**/settings/account/_components/permissionMeta.tsx',
        'app/**/settings/account/_components/CreateTokenModal.tsx',
        'app/**/settings/account/_components/apiTokensClient.ts',
        // Story 7.2 (AI infrastructure) · Subtask 7.2.11 — the org cost
        // dashboard read service: the 6.10.4 access gate + the server-side
        // scope narrowing (an admin's validated drill, a member locked to
        // their own project slice) are the no-leak contract. Locked by 7.2.12.
        'lib/services/aiUsageService.ts',
        // Story 7.7 (Motir MCP server) · Subtask 7.7.12 — the story-closing
        // suite extends the gate to the MCP tool surface: the registry and every
        // tool module. (The shared field-schema / summary / normalize helpers
        // under `tools/` — workItemRef / sprintRef / readyFilters — are NOT tool
        // modules and stay ungated.) `tests/mcp/story-roundtrip` drives them over
        // the real `/api/mcp` transport; `tests/mcp/tool-coverage` walks the
        // per-tool summary / edge branches.
        // Story 11.6 · Subtask 11.6.2 (MOTIR-2228) — the payload SEAM: the brand
        // that makes `toolOk` refuse an underived payload, the exemption +
        // migration registries, the derived shared-resource set, and the
        // work-item payload shapes. Gated from the start: an ungated new module
        // is exactly the invisible member the seam exists to make impossible.
        'lib/mcp/payloads/brand.ts',
        'lib/mcp/payloads/define.ts',
        'lib/mcp/payloads/exemptions.ts',
        'lib/mcp/payloads/sharedResources.ts',
        'lib/mcp/payloads/workItems.ts',
        // Subtask 11.6.4 (MOTIR-2230) — the project / sprint / identity family.
        'lib/mcp/payloads/planning.ts',
        // Subtask 11.6.5 (MOTIR-2231) — the work-loop family + the seal.
        'lib/mcp/payloads/workLoop.ts',
        // Subtask 11.6.6 (MOTIR-2232) — the drift guard + the tool→payload map.
        'lib/mcp/payloads/driftGuard.ts',
        'lib/mcp/payloads/registry.ts',
        // Story MOTIR-2284 · Subtask MOTIR-2289 — the Children panel's List ↔
        // Graph switcher. (`WorkItemRoadmap`, the adapter it mounts, is already
        // gated above.)
        // Story MOTIR-2560 — the editable quick-view rail. Every file the story
        // ADDED or made a write surface, entered as `app/**/…` because a literal
        // `app/(authed)/…` reaches no file (MOTIR-2449) and would gate nothing.
        'app/**/items/_components/QuickViewRailEdit.tsx',
        'app/**/items/_components/fieldChipEditing.ts',
        'app/**/items/_components/customFieldEditing.tsx',
        'app/**/items/_components/IssueQuickViewPanel.tsx',
        // Story MOTIR-4181 — the proposal peek's own two files. Added to
        // `include` and deliberately NOT to `thresholds`, by this config's own
        // rule: the number comes off the first CI run, and pinning a floor
        // before measuring one is how a gate ends up asserting a guess.
        'components/planning/ProposalPeek.tsx',
        'components/workItems/ProposalPeekMarks.tsx',
        'app/**/items/_components/IssueQuickViewController.tsx',
        // …and the SEAM the payload widening landed in. `workItemsService.ts`
        // (the other half) is already included + gated above.
        'lib/mappers/quickViewMappers.ts',
        'app/**/items/[key]/_components/ChildPanel.tsx',
        'app/**/items/[key]/_components/ChildList.tsx',
        'lib/mcp/registry.ts',
        'lib/mcp/tools/getWorkItem.ts',
        'lib/mcp/tools/listReady.ts',
        'lib/mcp/tools/nextReady.ts',
        'lib/mcp/tools/createWorkItem.ts',
        'lib/mcp/tools/transitionStatus.ts',
        'lib/mcp/tools/addComment.ts',
        'lib/mcp/tools/searchWorkItems.ts',
        'lib/mcp/tools/whoami.ts',
        'lib/mcp/tools/listProjects.ts',
        'lib/mcp/tools/listSprints.ts',
        'lib/mcp/tools/validateSprint.ts',
        // Work-item finishability — the tool, plus the shared loose/tight
        // predicate both validators use (Subtask 7.8.23).
        'lib/mcp/tools/validateWorkItem.ts',
        'lib/workItems/validity.ts',
        // Story MOTIR-3093 · Subtask MOTIR-3095 — the PROJECTED validity mode.
        // The new plan-level tool and the shared `planId` / temp-ref plumbing
        // both validators and (MOTIR-3096) the projected reads address a plan
        // through. Both MEASURED before being pinned, on this branch, with
        // `tests/mcp/validate-plan.test.ts`: 100 / 100 / 100 each.
        'lib/mcp/tools/validatePlan.ts',
        'lib/mcp/tools/planRef.ts',
        // Subtask MOTIR-3096 — the PROJECTION itself, lifted out of
        // `planValidityService` when the projected READS became its second
        // consumer. Gated on its own because it is now the ONE place a plan is
        // merged into a live tree: a regression here changes what BOTH the
        // validity verdicts and the reads answer, and blended into the validity
        // service's number it would be invisible.
        'lib/services/planProjectionService.ts',
        // Bug MOTIR-3123 — the FINISHABILITY engine itself. It was in neither
        // half of this config until now, so the ≥90%-per-file gate had never
        // applied to the file that answers "can this plan be finished?" — the
        // check `generate_tree` runs as its pre-commit post-condition, the one
        // the three §4 `validate-plan*` routes expose, and (MOTIR-3095) the one
        // a PAT can reach. A gate never pointed at a file is indistinguishable
        // from one that passes: nothing goes red and no number looks wrong.
        // MEASURED FIRST and GATED in `thresholds` below — see the numbers and
        // the suite set there.
        'lib/services/planValidityService.ts',
        // The PROSE-vs-GRAPH advisory beside those rules (MOTIR-1969) — the pure
        // reference/severity extractor and the service that resolves + gates it.
        'lib/workItems/proseVsGraph.ts',
        'lib/services/proseGraphAdvisoryService.ts',
        // The repository SET's per-repo DELIVERY classifier and its one shared
        // field component (Story MOTIR-2725 · MOTIR-2417). Gated on their own
        // because they are the seam the completion gate and BOTH surfaces read:
        // a regression here makes the panel disagree with the gate, and blended
        // into workItemsService's number it would be invisible.
        'lib/workItems/repoDelivery.ts',
        'components/workItems/RepositorySetField.tsx',
        // The repository REFERENCE's data-access leaf (Story MOTIR-2732 ·
        // MOTIR-3039). Gated on its own for the same reason `repoDelivery.ts`
        // above is: it is the ONE place a card's repositories are read and
        // written, so a regression here moves where an agent is dispatched, and
        // blended into `workItemsService`'s number it would be invisible.
        'lib/repositories/workItemRepoRepository.ts',
        // The PROJECT repository set on the planning-job envelope (MOTIR-3044).
        // Gated on its own because it is a CROSS-REPO contract: the consumer is in
        // motir-ai, so a regression here is invisible from this side until a plan
        // comes back unpinned.
        'lib/ai/projectRepoContext.ts',
        'lib/mcp/tools/createSprint.ts',
        'lib/mcp/tools/updateSprint.ts',
        'lib/mcp/tools/deleteSprint.ts',
        'lib/mcp/tools/moveToSprint.ts',
        'lib/mcp/tools/moveToBacklog.ts',
        'lib/mcp/tools/startSprint.ts',
        'lib/mcp/tools/completeSprint.ts',
        'lib/mcp/tools/markIntegrated.ts',
        'lib/mcp/tools/completeSession.ts',
        'lib/mcp/tools/linkWorkItems.ts',
        // Story MOTIR-3525 · Subtask MOTIR-3526 — the pull-request LINK door. In
        // the gate from the start: an ungated new tool module is exactly the
        // invisible member the 7.7.12 sweep put every other one here to prevent.
        // `tests/mcp/linkPullRequest` walks the adapter's arms (both address
        // forms, the disagreement refusal, the two write paths, the tenancy
        // refusals) and `tests/mcp/linkPullRequestTransport` drives it over the
        // real `/api/mcp` transport, which is what covers `registerLinkPullRequest`.
        'lib/mcp/tools/linkPullRequest.ts',
        'lib/mcp/tools/updateWorkItem.ts',
        'lib/mcp/tools/archiveWorkItem.ts',
        'lib/mcp/tools/deleteWorkItem.ts',
        // Story 7.9 · MOTIR-1825 — the AI plan-expansion tool + its outcome read
        // join the same gate (`tests/mcp/expand-item` drives both).
        'lib/mcp/tools/expandItem.ts',
        // Story 7.9 · MOTIR-1837 — the plan CONTENT read (the proposals behind
        // that outcome's count); `tests/mcp/get-plan` drives it.
        'lib/mcp/tools/getPlan.ts',
        // Story MOTIR-3098 · Subtask MOTIR-3102 — the two DISCOVERY reads, the
        // surface an agent uses to answer *does this already exist?* Both are
        // new in this story, so there is no pre-existing number to pin blind:
        // GATED, not report-only. Their shared payload code is already gated
        // through `lib/mcp/payloads/workItems.ts` above.
        'lib/mcp/tools/skeleton.ts',
        'lib/mcp/tools/searchWorkItemsSemantic.ts',
        // Story 7.9 · MOTIR-1842 — the dependency-EDGE projection both LIST
        // reads attach; `tests/mcp/dependency-edges` drives it.
        'lib/mcp/dependencyEdges.ts',
        // Story 7.10 · Subtask 7.10.8 (MOTIR-896) — the GitHub integration's
        // webhook state machine + installation grant mirror + code-graph feed
        // dispatch + the planning-envelope repo-set producer join the gate.
        'lib/services/githubWebhookService.ts',
        'lib/services/githubInstallationService.ts',
        'lib/services/codeGraphIndexService.ts',
        'lib/github/indexEnqueue.ts',
        'lib/github/webhookSignature.ts',
        'lib/ai/codeContext.ts',
        // Story 7.30 (changing a plan is a CONVERSATION) · Subtask MOTIR-1732 —
        // the story-level gate. The conversation's persistence layer
        // (MOTIR-1728), the launcher↔host contract + its route gate
        // (MOTIR-1729), and the rail's diff index + client state machine
        // (MOTIR-1730) join together, once the story's code has merged and the
        // numbers are real. The client TRANSPORT is gated too: it is the only
        // path the rail reaches the server by, and it shipped untested.
        // Story MOTIR-1343 · MOTIR-1819 — the ASK seam. Every file here is new
        // code this card wrote, MEASURED on this branch before being pinned (the
        // sequence this block prescribes throughout):
        //   `aiAskService.ts`  96.2 stmts / 93.9 branches / 100 funcs / 100 lines
        //   `askResult.ts`     100 / 100 / 100 / 100
        // Both are GATED in `thresholds` below.
        //
        // ⚠️ THE THREE ROUTE FILES WERE REPORT-ONLY, AND ARE NOW GATED
        // (MOTIR-1822). The exemption said: what is uncovered is the `throw err`
        // rethrow of an error the shared mapper did not recognise, reachable only
        // by an exception type no service on the path raises — so publish the
        // number, and "the pin belongs to whoever makes that arm reachable."
        //
        // The story gate made it reachable, and honestly rather than by walking a
        // line: an unmapped throw IS a real outcome, and the assertion that
        // matters is that it surfaces as a FAULT instead of being flattened into
        // a plausible 4xx that hides which side failed. The stream route's own
        // arms came with it — a failure after the headers are sent can no longer
        // choose a status, so the only way the rail learns why it stopped is a
        // terminal `error` frame, and a stream that just ends reads as "the job
        // finished" and files nothing.
        //
        // MEASURED on this branch before pinning, with `askRoutes` + `askGate` +
        // `askStreamRoute` + `planChangeTurnIntent`:
        //   `ask/route.ts`               92.9 branches / 100 funcs /  96.0 lines
        //   `ask/settle/route.ts`         100 / 100 / 100
        //   `ask/[jobId]/stream/route.ts` 94.4 / 100 / 100
        //
        // ⚠️ WRITTEN WITH `**`, NOT A LITERAL `[jobId]`, for the reason this file
        // records twice already: in a glob `[jobId]` is a CHARACTER CLASS, so the
        // literal path names a directory that does not exist and the entry would
        // quietly cover — and gate — nothing.
        'lib/services/aiAskService.ts',
        'lib/planning/askResult.ts',
        'app/api/ai/ask/**/route.ts',
        'lib/services/planChangeSessionsService.ts',
        'lib/repositories/planChangeSessionRepository.ts',
        'lib/repositories/planChangeTurnRepository.ts',
        'lib/mappers/planChangeMappers.ts',
        'lib/planChange/errors.ts',
        'lib/planning/launcher.ts',
        'lib/planning/workspaceHost.ts',
        'lib/planning/planChangeDiff.ts',
        'lib/planning/planChangeClient.ts',
        'lib/hooks/usePlanChangeConversation.ts',
        // Story 7.12 · Subtask 7.12.3 (MOTIR-909) — CONTEXTUAL planning. The
        // conversation's scoping is now a permission boundary: which anchors a
        // turn plans against, and whether each one was view-gated, is decided in
        // these two files. They join the same gate as the rest of the
        // conversation stack they extend.
        'lib/planChange/scope.ts',
        'lib/services/contextualPlanningService.ts',
        // Story MOTIR-2786 · MOTIR-2787 — the planning-target LOCK. It decides
        // whether a second session may take an item another is expanding, and its
        // release path decides whether an item ever becomes plannable again; a
        // missed branch there is an epic nobody can plan, with no user-facing
        // remedy. Measured before pinning, per the note at the head of this
        // block: service 100/93.1/100, repository + lease module + sweep job all
        // 100 across the board.
        'lib/services/planTargetLockService.ts',
        'lib/repositories/planTargetLockRepository.ts',
        'lib/planChange/targetLock.ts',
        'lib/jobs/definitions/planTargetLockSweep.ts',
        // MOTIR-3064 — the abandoned-plan reconciler. Its decision table is the
        // whole card: which job states mean "the producer is not coming back",
        // and which of them mean "we do not know yet". A missed branch there is
        // either a project whose auto-planning stays paused for good or a live
        // generation cut off mid-run, and neither surfaces as an error.
        'lib/services/abandonedPlanService.ts',
        'lib/jobs/definitions/abandonedPlanSweep.ts',
        // Story 7.12 · Subtask 7.12.5 (MOTIR-911) — the CONFIRMATION GATE at the
        // persist boundary. This module decides whether an approved proposal set
        // may become rows at all (the kind-parent grammar, the intra-plan ref
        // graph, done-work immutability); it is the load-bearing SAFETY contract
        // of the planning pipeline, so every branch of the verdict is gated.
        'lib/plans/validateProposals.ts',
        // Story 7.12 · Subtask 7.12.6 (MOTIR-912) — the REVIEW-AND-CONFIRM seam
        // the story's rail runs on (MOTIR-1746/1747). `planReview.ts` answers the
        // three questions every AI-planning entrance asks of a run (is a proposal
        // pending? what did the approve land? what does a failed decision mean?)
        // and `planReviewClient.ts` is the ONE HTTP client all four of them
        // confirm through. They were the story's newest, least-gated code and they
        // sit directly on the confirm-before-write path, so they join the floor.
        'lib/planning/planReview.ts',
        'lib/planning/planReviewClient.ts',
        // Story 7.13 · Subtask 7.13.3 (MOTIR-916) — the auto-plan CADENCE
        // trigger. This module decides, with no human in the loop, whether to
        // spend a planning job on a tenant: the pending-proposal gate, the drain
        // threshold, the stub nomination, the actor it submits as, and the
        // per-project failure isolation. An untested branch here is an
        // unattended one, so every branch of the decision is gated.
        'lib/services/autoPlanCadenceService.ts',
        // Story 7.13 · Subtask 7.13.7 (MOTIR-920) — the REST of the story's
        // merged surface joins the gate its cadence half already sits under.
        // Measuring coverage over 7.13 as a whole (rather than per subtask, as
        // each landed) found the residue: the cron DEFINITION that wraps the
        // sweep shipped at 0% (the schedule, the retry budget and the registry
        // wiring were all unproven), and so did the planner-model PICKER whose
        // two mapping functions decide whether a tenant's pinned model survives
        // a save. Both are now gated, together with the sprint-persist +
        // settings services this story's other subtasks shipped, so the whole
        // 7.13 surface is held to the same floor rather than only the piece
        // MOTIR-916 happened to enrol.
        'lib/services/aiSprintPlanningService.ts',
        'lib/services/projectAiSettingsService.ts',
        'lib/ai/sprintAssignment.ts',
        'lib/mappers/projectAiSettingsMappers.ts',
        'lib/projectAiSettings/limits.ts',
        'lib/projectAiSettings/plannerModels.ts',
        'lib/jobs/definitions/autoPlanCadenceTick.ts',
        // Story MOTIR-1803 (roadmap auto-drill) · Subtask MOTIR-1808 — the
        // story's changed surface joins the gate once its code card (MOTIR-1807)
        // merged and the numbers are real. Both files are CLIENT components with
        // no service behind them: the descend predicate, the per-level suppression
        // ref and the adapter's cache/refresh generations are decided here and
        // reach the browser with nothing else in the way, so an untested branch
        // is an unproven one. `tests/components/roadmapAutoDrillGate.test.tsx`
        // carries the top-up + the DTO→adapter→canvas seam.
        // Story MOTIR-3833 · MOTIR-3840 — the roadmap-refinement surface, MEASURED
        // before being gated (this list's own rule). `canvasGeometry` gained the
        // arrival view, `RoadmapView` the URL↔level wiring and the fold budget, and
        // the legend-collapse hook is new. Three files this story changed are
        // deliberately NOT here, each with its number: `projectCanvasModel.ts`
        // (L100 B83.33 F100 — the shortfall is twelve pre-existing `?? fallback`
        // arms on maps seeded by construction, none of them this story's),
        // `PlanningCanvas.tsx` (L75.16 B64.88 F75 — a pre-existing pan/zoom/drag
        // component this story added one optional prop to), and
        // `app/(authed)/roadmap/page.tsx` (an async Server Component; the rule at
        // the top of this list is that a page joins only once somebody measures it).
        'lib/planning/canvasGeometry.ts',
        'components/planning/RoadmapView.tsx',
        'lib/hooks/useDependencyLegendCollapsed.ts',
        'components/planning/ProjectRoadmapCanvas.tsx',
        'components/planning/WorkItemRoadmap.tsx',
        // Story MOTIR-1755 · Subtask MOTIR-2205 — the planning phase card's DOOR
        // joins the same gate, and for the same reason: these three are CLIENT
        // modules with no service behind them, so the decisions they make — which
        // level the drill is served from, which stations are openable, and what the
        // card is allowed to ASSERT about a journey — reach the browser with nothing
        // in between. The badge in particular is a claim about provenance, and every
        // untested branch of it is a claim nobody checked.
        'components/planning/preplanStationLevel.tsx',
        'components/planning/PlanningOriginCluster.tsx',
        'components/planning/workItemLevel.tsx',
        // Story MOTIR-1863 (connect the CLI) · Subtask MOTIR-1870 — the whole
        // `motir login` surface joins the gate now that every code card has
        // merged and the numbers are real. This is a CREDENTIAL path: the
        // service is the one seam where a browser session becomes a bearer
        // token, the routes are the CLI's wire contract (RFC 8628 error codes a
        // published binary branches on), and `DeviceApproval` is the approval
        // screen whose four-fact inventory IS the device grant's phishing
        // mitigation — the ADR says in as many words that losing it invalidates
        // the decision's risk assessment. An untested branch in any of them is
        // an unproven one on the path that hands out credentials.
        'lib/services/cliDeviceService.ts',
        'lib/repositories/deviceCodeRepository.ts',
        'lib/mappers/cliDeviceMappers.ts',
        'lib/cliDevice/constants.ts',
        'lib/cliDevice/errors.ts',
        'lib/cliDevice/userCode.ts',
        'app/api/cli/device/start/route.ts',
        'app/api/cli/device/token/route.ts',
        'app/api/cli/device/approve/route.ts',
        'app/api/cli/device/grant/route.ts',
        'app/**/device/_components/DeviceApproval.tsx',
        'app/**/settings/account/_components/ConnectCliPanel.tsx',
        // Story MOTIR-1775 · MOTIR-1896 — the CI-minutes METER (the measurement
        // half of `docs/decisions/ci-minutes-allowance.md`). Gated from day one:
        // every figure here becomes a charge on a user's credit balance via
        // MOTIR-1901, so a silent regression in the arithmetic, the period key
        // or the idempotency guard is a billing bug, not a test-coverage nit.
        'lib/ciMetering/runnerRates.ts',
        'lib/ciMetering/normalize.ts',
        'lib/ciMetering/period.ts',
        'lib/ciMetering/config.ts',
        'lib/services/ciMinutesMeterService.ts',
        'lib/services/ciMinutesReconciliationService.ts',
        'lib/repositories/ciWorkflowRunUsageRepository.ts',
        'lib/repositories/ciPeriodUsageRepository.ts',
        'lib/jobs/definitions/ciMinutesReconcile.ts',
        // Story MOTIR-1916 · MOTIR-1924 — the FLEET COST meter, joining the
        // metering block above for the same reason and one level down: these
        // figures are what Motir's own margin is read from, and §M's ×1.00
        // product decision is defended by them. A silent regression in the
        // attribution, the period key or the per-runner idempotency guard would
        // not misbill a customer — it would quietly misinform the decision about
        // whether to re-price the allowance, which is worse for being invisible.
        // (The wider FLEET floor — the provisioning path, the port, the
        // adapters — is MOTIR-1927's deliverable, not this card's.)
        'lib/services/ciFleetCostMeterService.ts',
        'lib/repositories/ciContainerUsageRepository.ts',
        'lib/repositories/ciContainerPeriodCostRepository.ts',
        // Story MOTIR-1775 · MOTIR-1901 — the CI-minutes ENTITLEMENT (the
        // charging half of the same decision). Gated for the reason the meter's
        // comment above anticipates: these modules DECIDE what to bill and when
        // to refuse a dispatch, so an untested branch here is a wrong charge or a
        // wrongly-blocked customer.
        'lib/ciMetering/allowance.ts',
        'lib/services/ciAllowanceService.ts',
        'lib/repositories/ciPeriodChargeRepository.ts',
        // Story MOTIR-1775 · MOTIR-1781 — the repo-CREATION primitive. Gated
        // because its failure modes are IRREVERSIBLE in a way a normal service's
        // are not: an untested branch here creates a second repository, adopts one
        // that belongs to another tenant, or loses the record of a repository that
        // now exists in Motir's org with nothing pointing at it. There is no
        // rollback for any of those (ADR §4.2), so the branch coverage IS the
        // safety net.
        'lib/github/repoProvisioning.ts',
        'lib/services/projectRepoProvisioningService.ts',
        // Story MOTIR-1916 · MOTIR-1972 — the PER-PROJECT RUNNER GROUP. Gated
        // for the same reason the primitive above is, one layer over: an
        // untested branch here leaves a project sharing a runner group with
        // another tenant, or with none at all. `docs/decisions/ci-runner-fleet.md`
        // §7.3 makes the group's access list the thing that stops a runner Motir
        // booted for project X from serving project Y's queued job — including a
        // job MOTIR-1922's gate DECLINED — so every branch that decides which
        // repositories the list holds is a tenancy branch, and its failure is
        // silent when it happens.
        'lib/github/runnerGroups.ts',
        'lib/services/projectRunnerGroupService.ts',
        // Story MOTIR-1916 · MOTIR-1927 — THE REST OF THE FLEET. MOTIR-1924's
        // entry above gates the cost meter and defers the wider floor here ("the
        // provisioning path, the port, the adapters — MOTIR-1927's deliverable");
        // this is that deferral collected.
        //
        // Gated as one surface because the fleet's failures are all SILENT and
        // all expensive: a container nobody tore down bills forever, a runner in
        // the wrong group serves a job the gate declined, a cap read outside its
        // lock is not a cap. None of those surfaces as an error — they surface as
        // an invoice or as another tenant's CI — so the branch that decides each
        // one is the only place the guarantee is checkable at all.
        //
        // ⚠️ THE PORT ITSELF LEFT THIS GATE, AND ITS FLOOR WENT WITH IT
        // (MOTIR-4299). Ten of the eleven files that used to be listed here are
        // now `packages/orchestrator/src/**` and are gated by that package's own
        // `vitest.config.ts` at the SAME ≥90 per-file floor, run by `ci.yml`'s
        // `orchestrator` job. The reason they were listed is unchanged — §4 calls
        // the swappable interface "the single most load-bearing output: it is
        // what makes this decision reversible", and an adapter half of which is
        // unexercised is an interface with one caller rather than a port — so the
        // gate MOVED rather than being dropped. What stays here is the one file
        // that did not move: the app's COMPOSITION ROOT.
        'lib/orchestrator/index.ts',
        // Story MOTIR-1916 · MOTIR-2006 — THE BOOT PREFLIGHT, joining the same
        // surface for the same reason, stated at its sharpest by the fault it
        // exists to catch: MOTIR-1980's fleet shipped code-complete and unable to
        // pull a single image, and every predicate in the tree answered
        // "configured". The preflight is the one thing that would have said
        // otherwise, so an unexercised branch in it is the guarantee going
        // missing exactly where it went missing before.
        'lib/services/fleetPreflightService.ts',
        // Story MOTIR-1981 · MOTIR-1992 — THE INDEX FLEET, joining the gate for
        // the reason §6 states: this path's whole output is a `job_run` row that
        // is a PERMANENT claim that a repo has a code graph. Everything
        // downstream — the enqueue gate, the operator sweep, the onboarding
        // wizard's Next button — trusts that claim without re-checking it, so an
        // unexercised branch here is a repo that is silently never indexed (or
        // silently claimed and never built) with nothing anywhere to say so.
        // `indexImage.ts` sits with them because the image reference IS the
        // deliverable a container boots on: MOTIR-1980 shipped a fleet whose
        // every predicate answered "configured" and which could not pull a
        // single image.
        'lib/services/codeGraphIndexDispatchService.ts',
        'lib/services/codeGraphIndexAdmissionService.ts',
        'lib/jobs/indexFleetSteps.ts',
        'lib/jobs/definitions/codeGraphIndex.ts',
        'lib/ciFleet/config.ts',
        'lib/ciFleet/limits.ts',
        'lib/ciFleet/workloads.ts',
        'lib/ciFleet/bootDispatch.ts',
        'lib/github/runnerJitConfig.ts',
        'lib/services/ciRunnerProvisioningService.ts',
        'lib/services/ciRunnerBootService.ts',
        'lib/services/ciRunnerAdmissionService.ts',
        'lib/services/fleetCeilingService.ts',
        'lib/repositories/ciRunnerProvisioningIntentRepository.ts',
        'lib/repositories/ciFleetAdmissionLockRepository.ts',
        'lib/repositories/fleetInFlightSlotRepository.ts',
        'lib/jobs/definitions/ciRunnerFleet.ts',
        // Story MOTIR-1775 · MOTIR-1782 — the establish STEP at plan approval.
        // Gated for a different reason than the primitive above: the whole card
        // is a claim about what must NOT be on screen (no repository name, count,
        // role or GitHub error on the default path — the `notes.html` #151 rule),
        // and a claim like that only holds while the branches that could leak it
        // are exercised. The routes are the wire contract behind it, including the
        // one state a client may never write.
        'lib/services/projectRepoEstablishService.ts',
        'lib/projectRepos/errorResponse.ts',
        'lib/planning/repositorySetClient.ts',
        'components/planning/repositories/RepositorySetStep.tsx',
        'components/planning/repositories/RepositoryRow.tsx',
        'app/api/projects/[key]/repositories/route.ts',
        'app/api/projects/[key]/repositories/[rowId]/route.ts',
        'app/api/projects/[key]/repositories/[rowId]/state/route.ts',
        'app/api/projects/[key]/repositories/[rowId]/move/route.ts',
        'app/api/projects/[key]/repositories/establish/route.ts',
        // Story MOTIR-1775 · MOTIR-1945 — the TEAM code-access surface. Gated on
        // the same reasoning: the card's load-bearing claims are about who may
        // ACT (a connect prompt on your own row and nobody else's, no control at
        // all where the action was never yours, a refusal that never fails the
        // repository), and a claim like that holds only while the branches that
        // could break it are exercised. The view model carries the roll-up those
        // claims are made of.
        'lib/projectRepos/teamAccessView.ts',
        'app/**/settings/project/code-access/_components/CodeAccessSettings.tsx',
        // Story MOTIR-1775 · MOTIR-1939 — the TAKE-IT-OVER surface. Gated because
        // the card is a set of claims about STATE that only hold while the
        // branches expressing them are exercised: that a waiting state is a
        // durable place and never a spinner, that the already-yours row offers
        // nothing, that one row moving leaves its siblings working, and that the
        // picker still works when the org lookup fails. Every one of those is a
        // branch, and an untested branch here silently wedges a repository the
        // user was promised was theirs.
        'lib/github/userOrgs.ts',
        'lib/services/projectRepoRoomService.ts',
        'app/api/github/organizations/route.ts',
        'app/**/settings/project/repositories/_components/TakeoverRow.tsx',
        'app/**/settings/project/repositories/_components/TakeoverModal.tsx',
        'app/**/settings/project/repositories/_components/RepositoriesRoom.tsx',
        // MOTIR-3126 — the room's SECOND registry. Same argument as the block
        // above, one registry over: the surface's claims are that a
        // workspace-connected repository is NAMED, SOURCED and carries no action,
        // and that the empty state belongs to a project with neither registry.
        // Every one of those is a branch, and the defect being fixed here is
        // precisely a branch nobody could take. The reader and the section split
        // are gated for the same reason — they are now the ONE definition the
        // resolver and every surface share, so an unexercised branch in them is a
        // disagreement waiting to happen.
        'app/**/settings/project/repositories/_components/ConnectedRepositories.tsx',
        'lib/projectRepos/effectiveDomain.ts',
        'lib/projectRepos/roomSections.ts',
        // Story MOTIR-1755 · MOTIR-1758 → gated by MOTIR-1760. The provenance
        // BACKFILL's decision table. It shipped ungated, and it is the one file
        // in that subtask whose branches ARE the safety argument: each branch is
        // a claim about what may be stamped truthfully on ~1 700 already-shipped
        // items, and the two most important ones ABSTAIN (a done coding-agent
        // card with no PR, a cancelled card). An untested abstention is
        // indistinguishable from a missing rule, and the damage it does —
        // inventing attribution on real history — is silent and hard to undo.
        // The service + repository halves are already gated above.
        'lib/workItems/provenanceBackfill.ts',
        // MOTIR-1965 — the historical-PR mirror backfill, gated for the same
        // reason its provenance sibling above is: this is operator tooling whose
        // writes land on real, already-shipped history, and the branches ARE the
        // safety argument. The merged-only filter, the manual-link stickiness,
        // and the already-current comparison each prevent a specific wrong claim
        // (a `byok` stamp from an abandoned PR, a hand-made link overwritten, a
        // whole mirror's `updated_at` churned by a re-run), and an untested one
        // is indistinguishable from a missing one.
        'lib/github/historicalPullRequests.ts',
        'lib/services/historicalPullRequestBackfillService.ts',
        // MOTIR-3034 — the `base_ref` repair and the event-free re-evaluation of
        // the repository-set completion gate, gated for the SAME reason its
        // MOTIR-1965 neighbours above are, one turn sharper: this tooling does not
        // merely write to shipped history, it can move a card to DONE with no
        // human and no merge behind it. Every guard that keeps it honest is a
        // branch — the empty repository set that must ABSTAIN, the open change
        // request that must HOLD, the provider answer that must be left NULL
        // rather than guessed, the already-filled row that must not be rewritten —
        // and each one prevents a specific false claim. An untested guard here is
        // indistinguishable from a missing one, and what it would silently do is
        // complete work items nobody shipped.
        'lib/github/restRetry.ts',
        'lib/github/pullRequestBase.ts',
        'lib/services/pullRequestBaseRefBackfillService.ts',
        'lib/services/repoSetCompletionService.ts',
        // Story 7.24 · MOTIR-1812 → gated by MOTIR-1813. The "M" universal AI
        // callout: its action REGISTRY plus the two components that consume it.
        // The registry is the extension point MOTIR-1343 / MOTIR-1344 each land a
        // single entry in, so what the gate protects is not today's one row — it
        // is that the next row arrives with its branches exercised, in a surface
        // that is the front door to every AI capability Motir offers. The
        // launcher it derives its href from is already gated above.
        'lib/planning/aiCallout.ts',
        'components/planning/AiCalloutMenu.tsx',
        // MOTIR-3208, corrected by MOTIR-3214 — the orb's drag + throw.
        // `orbPhysics.ts` is pure and is GATED below (measured at 100 statements /
        // branches / functions / lines on this branch, against a 90 floor).
        // `useDraggableOrb.ts` is REPORT-ONLY, and the reason is the one this block
        // prescribes rather than a shortfall being hidden: it is at 100% LINES and
        // 82% branches, and what remains are DOM-capability guards
        // (`el.setPointerCapture?.()`, `pos.current ?? …`, the null arm of a
        // callback ref) that a single test environment cannot drive both ways —
        // happy-dom either has the method or does not. Pinning 90 would invite
        // mocking the DOM into having and not having a capability, which tests the
        // mock.
        'lib/planning/orbPhysics.ts',
        'lib/hooks/useDraggableOrb.ts',
        'components/planning/PlanWithAIFab.tsx',
        // MOTIR-1970 — the schedule-health detection seam. Gated because this is
        // the code that has to work on the day everything else has already
        // failed: production ran for a month with five jobs silently consuming
        // nothing, and no signal existed anywhere. Each branch here IS a way the
        // alarm can fail to sound — a cron term the evaluator does not
        // understand, a "never ran" that reads as healthy, a job judged against
        // the wrong tick. An untested branch in a detector is indistinguishable
        // from no detector, and its failure mode is the same silence it was
        // built to break.
        'lib/jobs/cron.ts',
        'lib/jobs/schedules.ts',
        'lib/services/jobScheduleHealthService.ts',
        'lib/jobs/definitions/dailyHealthCheck.ts',
        // Story 11.1 (the public `/api/v1` foundation) · Subtask 11.1.5 — the
        // whole v1 envelope gates from day one. Every branch here is a way the
        // PUBLIC contract can be wrong for a third party: an auth gate that
        // admits, a cursor that skips a row, a limiter that leaks, an error
        // path that leaks a stack. Stories 11.2 / 11.3 add endpoints ON TOP of
        // these files, so the gate must already be load-bearing when they land.
        'lib/api/v1/route.ts',
        'lib/api/v1/contractVersion.ts',
        'lib/api/v1/errors.ts',
        'lib/api/v1/bearer.ts',
        'lib/api/v1/pagination.ts',
        'lib/api/v1/rateLimit.ts',
        // Story 8.5 · Subtask 8.5.9 (MOTIR-1165) — the SHARED rate limiter and
        // its Postgres store. This is a security control on the pre-auth surfaces
        // (sign-in, sign-up, password reset, public writes) and a cost control on
        // the AI ones, so it belongs under the gate rather than beside it. Every
        // file is MEASURED at 100% before being pinned below — the honest sequence
        // the permission-model note above asks for.
        'lib/rateLimit/**',
        'lib/services/rateLimitService.ts',
        'lib/repositories/rateLimitCounterRepository.ts',
        'lib/ai/jobAuthResponse.ts',
        'app/api/v1/me/route.ts',
        'app/api/v1/workspaces/route.ts',
        // Story 11.3 (the planning resources) · Subtask 11.3.10 — MOTIR-2067.
        // The story's own gate measures its merged surface; these are the files
        // it added, each gated independently so a regression in one fails the
        // run rather than being averaged away by the others.
        'lib/api/v1/projects/schema.ts',
        // Story MOTIR-3584 · Subtask MOTIR-3590 — the project's repository SET on
        // `/api/v1`, the read `motir link` materializes from. MEASURED FIRST, then
        // pinned below, per this block's own rule.
        'lib/api/v1/projects/repositories.ts',
        'app/api/v1/projects/[projectKey]/repositories/route.ts',
        'lib/api/v1/sprints/schema.ts',
        'lib/api/v1/sprints/membership.ts',
        'lib/api/v1/ready/schema.ts',
        'lib/api/v1/rankedCollections.ts',
        // Story 11.4 · Subtask 11.4.3 — the SHARED wire-schema layer.
        'lib/api/v1/openapi/statuses.ts',
        'lib/api/v1/openapi/errorResponse.ts',
        'lib/api/v1/openapi/envelopes.ts',
        'lib/api/v1/openapi/headers.ts',
        'lib/api/v1/openapi/security.ts',
        // Story 11.4 · Subtask 11.4.4 — the registry, the emitter and the route.
        'lib/api/v1/openapi/operation.ts',
        'lib/api/v1/openapi/registry.ts',
        'lib/api/v1/openapi/emit.ts',
        'lib/api/v1/workItems/operations.ts',
        'app/api/openapi/v1.json/route.ts',
        // Story MOTIR-3876 · Subtasks MOTIR-3945 + MOTIR-3946 — the PUBLIC read
        // contract: its own version, its own registry, its own document, served
        // beside v1's. A SECOND contract, not a second copy — see
        // `docs/decisions/public-surface-hosts.md` AMENDMENT 1 for the three
        // grounds. MEASURED FIRST at 100/100/100 each, then pinned at the 90
        // floor below, per this block's own rule.
        // Story MOTIR-3876 · Subtask MOTIR-3885 — the ORIGIN SEAM this story
        // widened: `publicSiteOrigin()` and the description the public metadata
        // and the JSON-LD are both built from. `urls.ts` shipped at 45%
        // statements / 25% branches with `derivePublicDescription` untested at
        // all; MEASURED at 100/100/100 after 3885's cases, then pinned at the
        // floor below.
        // (`app/sitemap.ts` was pinned here too, for the sitemap 3885 re-based
        // on the application origin. It is DELETED — MOTIR-4583: an empty
        // `<urlset>` is schema-invalid, so this host serves no sitemap at all.
        // A path listed here that does not exist is a threshold nothing meets.)
        'lib/publicProjects/urls.ts',
        // Story MOTIR-3876 · Subtask MOTIR-3726 — `/robots.txt` and the policy
        // behind it. MEASURED at 100/100/100 on `tests/seo/robots.test.ts`;
        // the DERIVED half of that guard walks the signed-in route groups and
        // therefore runs in the structural-guard lane, which carries no
        // coverage — so the numbers here come from the policy tests alone,
        // which is where the calls are.
        'lib/robotsPolicy.ts',
        'app/robots.ts',
        'lib/api/public/contractVersion.ts',
        'lib/api/public/openapi/operation.ts',
        'lib/api/public/openapi/schemas.ts',
        'lib/api/public/openapi/operations.ts',
        'lib/api/public/openapi/emit.ts',
        'app/api/openapi/public.json/route.ts',
        'app/api/public/p/[identifier]/route.ts',
        // Story MOTIR-3932 · Subtask MOTIR-4194 — the PUBLISHED MCP tool
        // catalogue, the anonymous document `motir.co/docs/mcp/tools` renders
        // (`public-surface-hosts.md` AMENDMENT 5). `lib/apiDocs/mcp.ts` regained
        // a runtime reader with it; the route is a one-line serialization and
        // the shape lives in the module. MEASURED FIRST at 100/100/100 on
        // `tests/api/docs/mcp-tools-route.test.ts`, then pinned at the floor.
        'app/api/docs/mcp-tools.json/route.ts',
        // Story MOTIR-3877 · Subtask MOTIR-4120 — the reads and the act path
        // this story added, joining the subject route above under the same rule.
        //
        // ⚠️ THEY WERE OUTSIDE THIS REPORT UNTIL THIS CARD MEASURED IT, and that
        // is the finding rather than the fix: the entry above is a LITERAL path,
        // so `…/p/[identifier]/route.ts` gates one file and its five new
        // siblings inherited nothing. Every one of them shipped with route tests
        // and none of them was under the 90 floor, which is exactly the state
        // `tests/coverage-gate-globs.test.ts` exists to make visible — a gate
        // that passes because it is measuring nothing.
        //
        // MEASURED FIRST, per this block's own rule, then pinned at the floor
        // below.
        'app/api/public/p/[identifier]/board/route.ts',
        'app/api/public/p/[identifier]/roadmap/route.ts',
        'app/api/public/p/[identifier]/items/[key]/route.ts',
        'app/api/public/p/[identifier]/requests/[requestKey]/route.ts',
        'app/api/public/p/[identifier]/changelog.xml/route.ts',
        'app/api/public/projects/route.ts',
        'app/api/projects/[key]/public-overview/route.ts',
        'app/act/route.ts',
        // The two modules the act path added. `returnTarget.ts` is the one that
        // turns a value from another origin into a redirect, so it is the file
        // on this list where a missed branch is a security branch.
        'lib/publicProjects/returnTarget.ts',
        'lib/publicProjects/cors.ts',
        // Story MOTIR-3908 · Subtask MOTIR-4037 — the PUBLIC-PROJECTS CAPABILITY
        // GATE. `isCloud()` is the cloud-vs-self-host predicate (MOTIR-4033) and
        // `publicSurfaceUnavailable()` is the one refusal every gated route
        // answers with (MOTIR-4034); together they decide whether a build serves
        // a reading surface to strangers at all, which makes them about as
        // load-bearing as two small functions get. MEASURED at 100/100/100 on
        // `tests/api/public/cloud-gate.test.ts` + `tests/hosting/cloudBuildFlag.test.ts`
        // + `tests/integration/publicSurfaceCloudGate.test.ts`, then pinned at
        // the 90 floor below, per this block's own rule.
        //
        // ⚠️ `availability.ts` joins with it deliberately. The two predicates
        // read one variable and answer different questions, and the failure this
        // story is guarding against is exactly a branch of one of them going
        // unexercised — a `MOTIR_CLOUD=1` typo that silently reads as cloud, say.
        // Both arms of both functions are asserted; the gate keeps them that way.
        'lib/billing/availability.ts',
        'lib/publicProjects/cloudGate.ts',
        // Story 11.4 · Subtask 11.4.5 — the remaining operation declarations.
        'lib/api/v1/identity/schema.ts',
        'lib/api/v1/planning/operations.ts',
        // Story 11.7 (the work-loop operations) · Subtask 11.7.8 — MOTIR-2242.
        'lib/api/v1/workLoop/schema.ts',
        'lib/api/v1/workLoop/operations.ts',
        'lib/api/v1/workLoop/planScope.ts',
        'lib/api/v1/workItems/childEdges.ts',
        'lib/api/v1/workItems/schema.ts',
        'lib/api/v1/workItems/resolveKey.ts',
        // Story MOTIR-3000: the general attachment door — the v1 route and the
        // MCP tool in front of it. Both are thin adapters over one service
        // path, which is exactly why they are gated: a gate re-implemented in
        // either would show up here as an uncovered branch.
        'app/api/v1/work-items/[key]/attachments/route.ts',
        'lib/mcp/tools/attachFile.ts',
        'app/api/v1/work-items/[key]/dispatch-prompt/route.ts',
        // MOTIR-2961 — the KEYED CLAIM. Gated for the same reason the
        // attachment door above is: it is a thin adapter over one service
        // method that owns a LOCK, and a gate or a decision re-implemented in
        // the route would appear here as an uncovered branch.
        'app/api/v1/work-items/[key]/claim/route.ts',
        // Story MOTIR-3017: the bounded public entrance to plan approval. Gated
        // for the same reason — it is a thin adapter over one service path, so a
        // bound re-implemented in the route rather than enforced in the service
        // would show up here as an uncovered branch.
        'app/api/v1/work-items/[key]/plan-approval/route.ts',
        // MOTIR-3049 — the SCOPE CLAIM, for exactly the same reason one line up.
        // Its two arms differ only in which identifier they resolve; the claim
        // itself is one service method.
        'app/api/v1/scope-claims/route.ts',
        'app/api/v1/work-items/[key]/integration/route.ts',
        'app/api/v1/work-items/[key]/expansions/route.ts',
        'app/api/v1/work-items/[key]/activity/route.ts',
        'app/api/v1/sessions/complete/route.ts',
        'app/api/v1/plans/[planId]/route.ts',
        'app/api/v1/plans/[planId]/status/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/turns/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/submissions/route.ts',
        // The API-doc rendering modules moved to motir-marketing in MOTIR-3951.
        // The in-app door remains here and keeps its own coverage gate below.
        'app/**/settings/account/_components/ApiDocsLinkPanel.tsx',
        'app/api/v1/projects/route.ts',
        'app/api/v1/projects/[projectKey]/route.ts',
        'app/api/v1/projects/[projectKey]/sprints/route.ts',
        'app/api/v1/projects/[projectKey]/backlog/route.ts',
        'app/api/v1/projects/[projectKey]/backlog/work-items/route.ts',
        'app/api/v1/projects/[projectKey]/ready/route.ts',
        'app/api/v1/sprints/[sprintId]/route.ts',
        'app/api/v1/sprints/[sprintId]/start/route.ts',
        'app/api/v1/sprints/[sprintId]/complete/route.ts',
        'app/api/v1/sprints/[sprintId]/work-items/route.ts',
        // Story MOTIR-2192 · Subtask MOTIR-2166 — the code-graph OFFBOARDING
        // QUEUE (`docs/decisions/code-graph-index-fleet.md` §14). Gated because
        // the value it protects is a promise the product states in its own copy:
        // a 30-day retention window on customer-derived data. An untested branch
        // here is a graph retained past a window the dialogs claim, or one
        // removed inside a grace period the user thought they had.
        // Subtask MOTIR-2207 — the /code-health audit tab going MULTI-REPO. Both
        // files are new with the card, so they join the gate at birth rather
        // than waiting for a later coverage story. The row model is what decides
        // WHICH repo's report a reader sees (worst-first order also picks the
        // repo the re-audit poll watches), and the list is the only affordance
        // saying the other repos exist at all — an untested branch in either is
        // a project silently showing one repo's grade as if it were its own.
        'lib/codeHealth/repoAuditRows.ts',
        'app/**/code-health/_components/AuditRepoList.tsx',
        // Story MOTIR-2244 · Subtask MOTIR-2247 — the repo-SCOPED audit trigger.
        // The scope decides how many derivations a click PAYS for, so an
        // untested branch here is either a fan-out that spends N times what was
        // asked for, or a body parse that silently downgrades a client bug into
        // a whole-set run. The typed rejections gate the same money.
        'lib/codeHealth/errors.ts',
        'app/api/ai/coding-convention/_shared.ts',
        'app/api/ai/coding-convention/refresh/route.ts',
        // Subtask MOTIR-2248 — the audit-COVERAGE read. Its whole contract is
        // what it does when a repo's read FAILS: an untested branch is a nudge
        // that counts an unreadable repo as un-audited and cries wolf.
        'lib/services/auditCoverageService.ts',
        'app/api/ai/coding-convention/audit-coverage/route.ts',
        // Subtask MOTIR-2266 — the AUTO-FIRE trigger on a first successful index
        // (`docs/decisions/audit-on-first-index.md`). Every branch of it either
        // SPENDS two LLM calls or declines to: the idempotency gate, the per-repo
        // scope, and the swallow that keeps a derivation blip from failing — and
        // Inngest from retrying — an index that already succeeded.
        'lib/services/firstAuditTriggerService.ts',
        // Subtask MOTIR-2249 — the scoped run's record merge (pure).
        'lib/codeHealth/reauditRun.ts',
        // Subtask MOTIR-2250 — the audit-coverage banner.
        'components/planning/AuditCoverageBanner.tsx',
        'lib/codeGraph/offboarding.ts',
        'lib/repositories/codeGraphOffboardingRepository.ts',
        'lib/services/codeGraphOffboardingService.ts',
        // Subtask MOTIR-2168 — the SWEEP that drains the queue through motir-ai.
        // The smallest of the three cards and the one that decides whether §14 is
        // real: an endpoint nobody calls and a queue nobody reads are both green.
        'lib/services/codeGraphOffboardSweepService.ts',
        'lib/jobs/definitions/codeGraphOffboardSweep.ts',
        // Subtask MOTIR-2197 — the LIVE-PROJECT read seam the offboarding backstop
        // subtracts from. Gated because a wrong answer here is not a bug report,
        // it is a deleted customer code index: the consumer removes what this
        // says is absent. (The route itself stays out, like every other
        // `app/api/internal/*` transport — the logic is what is gated.)
        'lib/codeGraph/liveProjects.ts',
        'lib/services/liveProjectsService.ts',
        'lib/internalApi/serviceAuth.ts',
        // Subtask MOTIR-2388 — the app-URL contract. Nine lines that decide what
        // origin every emailed link, OAuth callback and canonical URL carries,
        // and whose failure mode is a link to nowhere rather than an exception.
        // It had no coverage entry while the same policy was written out at five
        // call sites; now that they all route through it, it is worth gating.
        'lib/baseUrl.ts',

        // Subtask MOTIR-1163 — the product-analytics seam. Two accessors and a
        // three-line component, and the whole point of both is a decision that
        // is invisible when it goes wrong: unset environment must render NO tag
        // (the self-hoster's guarantee), and a blank secret must not render
        // `<script src="">`. Neither failure throws. Gated below.
        'lib/analytics.ts',
        'components/analytics/AnalyticsScript.tsx',

        // Story MOTIR-2384 · Subtask MOTIR-2394 (the story gate) — the OBJECT
        // STORE half of the hosting move. `lib/baseUrl.ts` above was the app-URL
        // half and joined the gate with its own card; these three are the seam
        // MOTIR-2389 rewrote and MOTIR-2404 widened, and until this card none of
        // them was in the report at all — so the ≥90% per-file gate did not apply
        // to the file every attachment, avatar and acceptance artifact in the
        // product is stored through. All three are GATED below, MEASURED first.
        //
        // ⚠️ `lib/blob/errors.ts` and `lib/blob/uploadClient.ts` are their
        // neighbours and are deliberately NOT listed — `lib/blob/**` would have
        // been one character shorter and wrong. Neither is code this Story wrote:
        // the first sits at 50% branches and the second at 0% (a browser-side
        // module no Node suite loads), and pinning either would gate work no card
        // here did. That is the same line `lib/services/projectAccessService.ts`
        // and `lib/repositories/projectMembershipRepository.ts` are held on above.
        'lib/blob/uploader.ts',
        'lib/blob/s3.ts',
        'lib/blob/referencedUrls.ts',

        // Story MOTIR-2588 · Subtask MOTIR-2681 — the project's MARK, end to end.
        // Four files the story wrote, none of which entered the report when their
        // own cards shipped, so the >=90% floor did not apply to any of them:
        // the policy pair the route and the field both read, the upload route,
        // the settings row, and the renderer. All four are GATED below, MEASURED
        // first (this card's whole first job).
        //
        // The two `app/**/...` forms are the route-group workaround the block
        // comment at the top of `coverage` explains — a literal `app/(authed)/...`
        // key matches no reported file and would gate nothing.
        'lib/projects/imageUpload.ts',
        'app/api/upload/project-image/route.ts',
        'app/**/_components/ProjectLogoField.tsx',
        'app/**/_components/ProjectMark.tsx',

        // MOTIR-2527 — the membership READER every access gate now routes
        // through. Small, and gated precisely because it is small: its whole job
        // is choosing a BINDING, and a branch of it going untested is a gate
        // silently reading with the wrong GUCs, which is the failure this file
        // was written to remove. MEASURED first — 8/8 statements, 4/4 functions,
        // 4/4 branches on this branch, from `tests/permissions/membershipGate.test.ts`.
        //
        // ⚠️ `lib/workspaces/**` would have been shorter and wrong, the same line
        // `lib/blob/**` is held on above: `middleware.ts` sits at ~5% and
        // `errors.ts` at ~21%, neither of them this card's code.
        'lib/workspaces/membershipGate.ts',

        // Bug MOTIR-2643 — the acceptance lane's VERDICT. It is a pure module
        // under `tests/`, which enters the report perfectly well (vitest 4's
        // default `coverage.exclude` is empty), and it had never been in it: the
        // instrument that decides which of four causes a red acceptance run had
        // was the one shipped surface with no floor under it. That is exactly
        // backwards for a module whose whole job is to be believed. GATED below,
        // MEASURED first — 100 / 90.9 / 100 / 100 (stmts / branches / funcs /
        // lines) on this branch; the two uncovered branches are the pre-existing
        // `?? ''` fallbacks behind a length check.
        //
        // MOTIR-2646 added the CONTENTION half to the same module — the shaping
        // helpers behind `contention.json`, which the lane now writes on every
        // run rather than only on a red one. Re-measured with the same suite:
        // 100 / 92.1 / 100 / 100. The one further uncovered branch is the
        // clamped index's `?? 0` in `percentileMs`, which
        // `noUncheckedIndexedAccess` requires and the clamp makes unreachable.
        'tests/e2e/_helpers/acceptance-diagnostics.ts',

        // Story MOTIR-2664 · Subtask MOTIR-2671 — the design-result surface. The
        // four feature cards each shipped their own unit tests, but NONE of them
        // touched this file, so not one of the story's new modules had ever
        // entered the coverage report and the ≥90% per-file gate had never
        // applied to any of it. That is this card's first job: put the surface
        // under the floor, MEASURE it, then pin the numbers in `thresholds`.
        //
        // ⚠️ The two app paths are written `app/**/…` deliberately. The files
        // live under the `(authed)` route group, and a literal `(authed)` in a
        // glob is parsed as an extglob alternation, so the pattern silently
        // matches NOTHING — an include that quietly covers zero files, plus a
        // threshold that quietly gates zero files.
        //
        // `lib/dto/designEvidence.ts` is deliberately ABSENT: it declares types
        // only (no runtime export), so it emits no statements to cover and a
        // floor on it would be a floor on nothing.
        'lib/services/designEvidenceService.ts',
        'lib/repositories/designEvidenceRepository.ts',
        'lib/mappers/designEvidenceMappers.ts',
        'lib/designEvidence/errors.ts',
        'lib/designEvidence/publishAuth.ts',
        'lib/publishAuth/ciPublishAuth.ts',
        'lib/acceptanceEvidence/publishAuth.ts',
        'lib/blob/allowlist.ts',
        'app/api/work-items/**/design-evidence/route.ts',
        'app/api/work-items/**/design-evidence/upload-token/route.ts',
        'app/**/_components/DesignResultPanel.tsx',
        // Story MOTIR-2649 · Subtask MOTIR-2655 — every executable file the Home
        // story adds, named so the ≥90% per-file gate applies to code that is
        // brand new rather than only to code that was already reported.
        // `lib/dto/home.ts` is types only and emits no statements, so it is
        // deliberately absent: a threshold on a file with nothing to cover
        // passes vacuously, which is the failure MOTIR-2655 exists to prevent.
        'lib/home/**',
        'lib/services/homeService.ts',
        'lib/mappers/homeMappers.ts',
        // MOTIR-2653's page. `app/**/home/**`, not `app/(authed)/home/**` — a
        // literal route-group path matches no reported file (the note above),
        // so the threshold would pass vacuously.
        'app/**/home/_components/**',
        // Story MOTIR-2694 · Subtask MOTIR-2696 — the plan-tree embedding write
        // path. Every one of these is new code this card wrote and tested, so
        // all four are GATED in `thresholds` below rather than report-only;
        // measured at 100 lines / 100 functions / 100 branches on this branch
        // before being pinned, per the note above.
        'lib/workItems/embeddingDocument.ts',
        'lib/repositories/workItemEmbeddingRepository.ts',
        'lib/services/workItemEmbeddingsService.ts',
        'lib/jobs/definitions/workItemEmbedding.ts',

        // Story MOTIR-2694 · Subtask MOTIR-2697 — the semantic candidate-finder
        // ROUTE. The whole file is new code this card wrote, so it is GATED
        // rather than report-only. It is worth gating for a reason beyond the
        // floor: nearly all of it is REFUSAL — the wrong-length vector, the
        // caller-supplied project, the clamp — and an unexercised refusal branch
        // is exactly the kind of code that quietly stops refusing.
        'app/api/internal/ai/similar-work-items/route.ts',

        // Story MOTIR-4053 · Subtask MOTIR-4076 — the PLANNER's `log_bug` sink:
        // the job-token create route and the service that enforces the bound
        // (`planner-files-tenant-bug.md` §3) under the plan's row lock. GATED,
        // for the reason `similar-work-items` is: nearly all of it is REFUSAL —
        // the token's project and only the token's, the volume cap, the parent
        // outside the project — and the tenant-isolation case is part of the
        // gated number rather than a test beside it. The service file also
        // holds the system-principal `fileBug` (MOTIR-1450), covered by
        // `tests/ai/work-items-route.test.ts`; both suites feed one number.
        'app/api/internal/ai/log-bug/route.ts',
        'lib/services/aiWorkItemsService.ts',

        // Story MOTIR-2694 · Subtask MOTIR-2698 — the two files the story CHANGED
        // rather than wrote, which its other subtasks therefore left out of the
        // report entirely. They are added on DIFFERENT terms, and the difference
        // is the point:
        //
        // `aiBoundaryMappers.ts` is GATED (thresholds below). It holds
        // `toSimilarWorkItemRows`, which the ADR
        // (`docs/decisions/plan-tree-embeddings.md` §2) names as the ENFORCEMENT
        // POINT of the keys-not-prose invariant — it constructs its three fields
        // by name so a column added to the ranking query cannot follow the row
        // onto the wire. A guard that load-bearing belongs behind the gate, and
        // MOTIR-2698 covered the module's remaining fallback arms
        // (`tests/ai/aiBoundaryMappers.test.ts`) to put it there rather than pin
        // a number the file could not meet. Measured 100 lines / 100 functions /
        // 92 branches on a SUBSET of the suite before pinning.
        'lib/mappers/aiBoundaryMappers.ts',
        // `aiBoundaryService.ts` is REPORT-ONLY, deliberately — the honest
        // sequence this block already prescribes elsewhere: measure first, pin
        // second. This story added ONE method to it (`findSimilarWorkItems`,
        // fully exercised), while the two arms that hold the file under the floor
        // are Story 7.5's defensive `ProjectNotFoundError` throws in
        // `readPlanTree` / `getSubtree`, which this card does not own. Gating the
        // whole file here would gate THIS story on ANOTHER story's debt, and the
        // way that ends is with someone loosening a threshold to make a build
        // pass. Read the number off CI and pin it when the 7.5 arms are covered.
        'lib/services/aiBoundaryService.ts',
        // Story MOTIR-2982 · Subtask MOTIR-2992 — the agent-authored plan surface.
        // Every file this story added or changed that carries decision logic; the
        // pure type/DTO modules it also touched carry none and are left out.
        //
        // ⚠️ The row's builder and component are written `app/**/plans/…`, NOT
        // `app/(authed)/plans/…`, for the reason the block comment at the top of
        // this section gives — a literal route-group path matches no reported
        // file and gates nothing.
        'lib/mcp/tools/authorPlan.ts',
        'app/**/plans/planRowView.ts',
        'app/**/plans/_components/PlanRow.tsx',

        // Story MOTIR-3232 · Subtask MOTIR-3242 — the Plans surface, refined. Every
        // file the story ADDED that carries decision logic; the two it changed
        // that were already gated (`planRowView.ts`, `PlanRow.tsx`) are directly
        // above and stay there.
        //
        // ⚠️ Written `app/**/plans/…` for the reason this section's header gives:
        // a literal `app/(authed)/plans/…` matches no reported file and would
        // gate nothing.
        //
        // What is deliberately NOT here: `PlanDetail.tsx`, `PlanReviewRail.tsx`,
        // `PlanReviewCanvas.tsx` and `ProjectRoadmapCanvas.tsx`. This story
        // CHANGED all four, and each carries far more logic than the story owns —
        // gating them here would gate THIS story on OTHER stories' coverage, which
        // is the trade the block above already refuses once.
        'lib/planning/planShape.ts',
        'lib/planning/planView.ts',
        // MOTIR-3243 — the tab's URL vocabulary, moved OUT of the `'use client'`
        // component it was declared in (a Server Component cannot call an export
        // it reached through a client boundary; `/plans` 500'd). It is covered by
        // the same `tests/components/PlanStatusTabs` suite, which now imports it
        // from here.
        'lib/planning/planStatusFilter.ts',
        'components/planning/PlanProposalList.tsx',
        'app/**/plans/_components/PlanStatusTabs.tsx',
        'app/**/plans/_components/PlansList.tsx',

        // Story MOTIR-2999 · Subtask MOTIR-3008 — the `implemented` lifecycle.
        // The story's decision code, in one place: what a pull request delivers
        // (`changeRequestWorkItems`), what a green build promotes (`ciPromotion`),
        // the workflow the whole thing is expressed in (`defaultWorkflow`, and the
        // token map that paints it), and the one chip that tells Implemented apart
        // from the three statuses it shares a category with (`StatusPill`).
        // All five are new or newly-decisive in this story and all five are GATED
        // in `thresholds` below, measured first (the sequence this block
        // prescribes throughout).
        //
        // ⚠️ The story ALSO changed `changeRequestStatusSync`, `changeRequestCiFeedback`
        // and `githubWebhookService`, which are NOT listed here. Those are large
        // pre-existing files this story widened, and `workItemsService.ts` — the
        // one it changed that IS gated — is already in `include` above. Adding the
        // other three would gate this story on code no card here wrote, which is
        // the trap the `aiBoundaryService.ts` note names: it ends with someone
        // loosening a threshold to make a build pass.
        'lib/services/ciPromotion.ts',
        'lib/services/changeRequestWorkItems.ts',
        'lib/workflows/defaultWorkflow.ts',
        'lib/workflows/statusColor.ts',
        'components/issues/StatusPill.tsx',
        // Bug MOTIR-3209 — the ONE place that decides which of a commit's
        // workflow runs still gets a vote. It is the whole of that card's
        // decision and it is read by BOTH derivations, so an untested branch
        // here is a wrong CI verdict on a card, silently.
        //
        // ⚠️ `changeRequestCiFeedback.ts`, `prCiState.ts` and the two providers
        // the card also touched are deliberately NOT added: they are pre-existing
        // files this fix widened, and gating them here would gate the fix on code
        // no card wrote — the trap the `aiBoundaryService.ts` note above names.
        'lib/github/checkSuites.ts',
        // Story 8.12 · Subtask MOTIR-3612 — the passkeys card, its state owner,
        // and the one rule about `'passkey'` in a status DTO. MEASURED before
        // being pinned, per the note at the top of this list.
        //
        // ⚠️ `TwoFactorManager.tsx` is deliberately NOT here. This card widened
        // it (a controlled status, a slot, a read-only method row) but did not
        // write it, and gating 800 lines of pre-existing enrolment flow on a
        // change to three of them is the trap the `changeRequestCiFeedback.ts`
        // note above names. `security/page.tsx` is out because nobody has
        // measured it — not because a route component cannot be measured. (The
        // "standing reason" this note used to cite, *no `app/**/page.tsx` is in
        // this report*, was false when written: see the correction in the
        // MOTIR-3449 block at the top of this list.)
        'app/**/settings/account/_components/PasskeyManager.tsx',
        'app/**/settings/account/_components/AccountSecurityPanes.tsx',
        'app/**/settings/account/_components/twoFactorMethods.ts',
        // Story 8.12 · Subtask MOTIR-3613 — the sign-in card's passwordless
        // route. `SignInCard.tsx` itself is NOT added: this card put one control
        // in it and did not write the 400-line two-step state machine around it.
        'app/**/_components/PasskeySignInButton.tsx',
        // Story 8.12 · Subtask MOTIR-3614 — the story's server-side ADDITIONS.
        //
        // ⚠️ THE FILES THIS STORY WIDENED ARE NOT HERE, and that is the same
        // call the `changeRequestCiFeedback.ts` note above makes:
        // `lib/auth/index.ts`, `lib/auth/client.ts`, `lib/dto/twoFactor.ts`,
        // `lib/mappers/twoFactorMappers.ts` and `lib/services/twoFactorService.ts`
        // are pre-existing files this story added to, and gating them here would
        // gate the addition on code no card in this story wrote.
        // `lib/dto/passkey.ts` is types only — it emits nothing to instrument.
        'lib/auth/passkeyConfig.ts',
        'lib/repositories/passkeyRepository.ts',
        'lib/mappers/passkeyMappers.ts',
        'lib/services/passkeyService.ts',

        // ── Task MOTIR-3568 — THE FIRST AUTHED ROUTE COMPONENTS IN THIS REPORT ──
        //
        // One page from each of MOTIR-3440's five families, rendered by
        // `tests/helpers/serverPageHarness.tsx` in `tests/navigation/render/`.
        // The decision that put them here — and why the alternative, declaring
        // route components permanently out of scope, was weighed and rejected —
        // is `docs/decisions/rsc-render-harness.md`.
        //
        // ⚠️ REPORT-ONLY, and deliberately: NOT ONE of these has a `thresholds`
        // entry. That is this list's own sequence — measure, then pin — and it is
        // the sequence the notes above keep citing while the number stays
        // unmeasured. CI publishes a per-file figure for these five on the first
        // run that carries this diff; pinning happens in a follow-up card, off
        // that figure, and NEVER at a value chosen to make a build pass. A number
        // below the floor is a finding to state, not a bar to lower — and TWO of
        // these five are below it on the diff-scoped measurement recorded in the
        // ADR (`code-health` at 81.66/63.33/72.72/81.48, `automation` at
        // 94.44/70/75/93.75), which is exactly why none of them is pinned here.
        //
        // ⚠️ A DYNAMIC SEGMENT IS ESCAPED — `\\[id\\]`, not `[id]`. Unescaped,
        // `[id]` is a character CLASS to picomatch (one char, `i` or `d`), and
        // that it happens to match the literal directory today is a coincidence
        // to rely on exactly as much as the `app/(authed)/…` form the note at the
        // top of this block warns about. `tests/coverage-gate-globs.test.ts`
        // fails the build on either mistake.
        'app/**/settings/project/automation/page.tsx',
        'app/**/plans/\\[id\\]/page.tsx',
        'app/**/items/\\[key\\]/edit/page.tsx',
        'app/**/code-health/page.tsx',
        'app/**/invite/accept/page.tsx',
        // Story MOTIR-4237 · Subtask MOTIR-4240 — THE HELP MENU, and the context
        // the story widened to give it a door. Both were built by MOTIR-4239 and
        // neither was in this report, so the per-file floor did not reach the
        // one surface this story actually adds.
        //
        // MEASURED FIRST, on this branch, before either was pinned — this list's
        // own sequence. `pnpm vitest run --coverage` over the fifteen component
        // specs that reach them:
        //
        //   HelpMenu.tsx               100 stmts · 100 branch · 100 fn · 100 lines
        //   CommandPaletteProvider.tsx 100 stmts · 100 branch · 100 fn · 100 lines
        //
        // Both GATED in `thresholds` below, at the 90 floor rather than at the
        // measured 100, so a later refactor has room without anyone loosening a
        // gate to make a build pass.
        'app/**/_components/HelpMenu.tsx',
        'app/**/_components/CommandPaletteProvider.tsx',
        // `SidebarNav.tsx` — GATED on all four axes since MOTIR-4368. It was
        // three-plus-a-finding for the length of one card, and the two halves of
        // that story are kept together below because the DISTINCTION is the
        // point: MOTIR-4324 deleted a branch no fixture could honestly reach,
        // MOTIR-4368 wrote the specs for three arms a person can reach in the
        // running app. Two coverage shortfalls on one file, identical in a
        // report and opposite in kind.
        //
        // ⚠️ WHAT THIS COMMENT SAID UNTIL MOTIR-4324, kept because the number it
        // quotes is the before half of this card's evidence: the file was
        // report-only at 97.22 stmts · 84 branch · 88.88 fn · 97.22 lines (292
        // component specs, 3 405 tests), and the ONE uncovered function was
        // `SoonChip` — a badge that rendered only for a settings-nav entry
        // carrying a reserved-slot flag no registry set any more. Covering it
        // meant fabricating a registry entry no shipped surface has, so the
        // number stood as a finding rather than a bar to lower.
        //
        // MOTIR-4324 retired that branch instead of covering it: `SoonChip`, the
        // reserved-slot flag on both nav registries, the filters it fed and its
        // two `Soon` catalog strings are gone. MEASURED AFTER, over the fourteen
        // specs that reach this file — a LOWER BOUND on the full-suite number,
        // since coverage over more specs can only rise:
        //
        //   vitest run --coverage \
        //     --coverage.include='app/**/_components/SidebarNav.tsx' \
        //     <the 14 specs naming SidebarNav / the authed layout>
        //   SidebarNav.tsx  100 stmts · 86.95 branch · 100 fn · 100 lines
        //
        // Statements, functions and lines were at 100 and GATED at the 90 floor.
        // BRANCHES was not, and the remaining cause was a different one from the
        // one MOTIR-4324 closed: the three uncovered arms were the DRAWER
        // variant of the account-settings and project-settings rails
        // (`collapsed={isDrawer ? false : undefined}` at both settings returns)
        // plus the five-clause `active:` predicate on the workspace-settings
        // row. Reachable, real, and untested — a coverage gap, not dead code —
        // so neither that card's to write nor a bar to lower. Filed as
        // MOTIR-4368, which is what closed it.
        //
        // MOTIR-4368 — the same fourteen specs, RE-MEASURED first (the before
        // half above reproduced exactly on `origin/main` @ `da4c4078b`, at
        // 40/46 branches, uncovered 236,261,463) and then again after the specs
        // it added:
        //
        //   SidebarNav.tsx  100 stmts · 100 branch · 100 fn · 100 lines
        //   Branches: 100% ( 46/46 ) — was 86.95% ( 40/46 )
        //
        // The six arms: the drawer arm of each settings return
        // (`sidebar-nav-rail-head.test.tsx`, which asserts BOTH directions — the
        // drawer ignores a collapsed store, the rail follows it) and the four
        // negations of the workspace-settings predicate, each driven at its own
        // sub-route (`SidebarNav-settings-door.test.tsx`). `branches` is pinned
        // at the 90 floor in `thresholds` below, beside its three siblings.
        'app/**/_components/SidebarNav.tsx',
        // MOTIR-4518 — the preflight that asks whether the address an index
        // container is GIVEN can work where the container runs. It is gated on
        // its own rather than blended into a service's number because it is a
        // GUARD: the fault it exists to catch produced no failing signal
        // anywhere for two weeks, so a regression in it would restore exactly
        // that silence. MEASURED FIRST, over the one spec that reaches it — a
        // LOWER BOUND on the full-suite number, since coverage over more specs
        // can only rise:
        //
        //   vitest run --coverage \
        //     --coverage.include='lib/ai/containerAiAddress.ts' \
        //     tests/ciFleet/containerAiAddress.test.ts
        //   Statements 100% (34/34) · Branches 100% (24/24)
        //   Functions  100% (5/5)   · Lines    100% (31/31)
        //
        // GATED at the 90 floor rather than at the measured 100, so a later
        // refactor has room without anyone loosening a gate to make a build pass.
        'lib/ai/containerAiAddress.ts',
        // ── Story MOTIR-4337 (an INTERNAL org bills like a customer) · the
        //    story's Vitest gate, MOTIR-4573. Every file below was MEASURED on
        //    this branch before being pinned, with:
        //
        //      pnpm vitest run --coverage tests/internalBillingStoryGate.test.tsx \
        //        tests/platform/ tests/ai/tenantOrg.test.ts \
        //        tests/components/classification-bar.test.tsx \
        //        tests/components/searchFigures.test.ts \
        //        tests/components/org-usage-search-spend.test.tsx \
        //        tests/components/org-usage-internal-billing.test.tsx
        //
        //    Statements 99.31 · Branches 96.10 · Functions 100 · Lines 100
        //    across the ten, with every file at 100 on all four axes except
        //    `ClassificationBar.tsx` (95.83 / 85.71 / 100 / 100) and
        //    `searchUsage.ts` (100 / 93.75 / 100 / 100).
        //
        // ⚠️ THE STORY'S TWO `page.tsx` FILES ARE NOT HERE, and that is the same
        //    stated gap the MOTIR-3449 note above records rather than a new one:
        //    `admin/tenants/page.tsx` and `admin/tenants/[orgId]/page.tsx` are
        //    async Server Components, and covering one means awaiting it through
        //    `serverPageHarness`. They are asserted structurally by the gate's
        //    own guards and end to end by `tests/e2e/admin-org-lookup.spec.ts`.
        //    They stay out until somebody measures them, which is this list's
        //    own rule.
        'lib/repositories/platformOrganizationRepository.ts',
        'lib/services/platformBillingClassificationService.ts',
        'lib/mappers/platformMappers.ts',
        'lib/platform/auditActions.ts',
        'lib/platform/errors.ts',
        'lib/ai/tenantOrg.ts',
        'app/**/admin/tenants/[orgId]/actions.ts',
        'app/**/admin/tenants/[orgId]/_components/ClassificationBar.tsx',
        'app/**/organization/usage/_components/searchUsage.ts',
        'app/**/organization/billing/_components/searchFigures.ts',

        // ── Story MOTIR-4725 · the planning workspace as an OVERLAY ──────────
        // Its story gate (MOTIR-4733). Every file here was MEASURED on this
        // branch before being pinned below, over `tests/planning/`,
        // `tests/integration/planning/`, `tests/api/planning-anchor-route.test.ts`
        // and the four component suites the story ships.
        //
        // ⚠️ `lib/planning/launcher.ts` is NOT repeated — it has been gated since
        // MOTIR-1299 and its entry is above.
        'lib/planning/planPending.ts',
        'lib/planning/planningAnchorClient.ts',
        'lib/hooks/useOpenPlanningWorkspace.ts',
        'components/planning/PlanningWorkspaceOverlay.tsx',
        'components/planning/PlanCloseGuard.tsx',
        'components/planning/PlanningWorkspaceHost.tsx',
        'app/api/work-items/planning-anchor/route.ts',
        // The `/planning` FORWARD. A route-group path is entered as `app/**/…`
        // (the note above) — `app/(authed)/planning/page.tsx` resolves to nothing.
        'app/**/planning/page.tsx',
      ],
      reporter: ['text', 'text-summary'],
      // Per-file thresholds keyed by glob: each of the six modules gates
      // independently, so a regression in any one fails the run (rather than a
      // blended average hiding a weak module).
      //
      // ⚠️ A key here gates ONLY a file `include` above also resolves to, and it
      // fails SILENTLY when it matches nothing — see the route-group note on
      // `include`. Write a route-group path as `app/**/…`.
      thresholds: {
        // ── Story MOTIR-4725 · the planning workspace as an OVERLAY ──────────
        // Pinned at the project floor after measuring each on this branch
        // (MOTIR-4733). Statements/lines/functions came out at 100 across the
        // set; branches at 92.85–100 except the one file noted below.
        'lib/planning/planPending.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/planning/planningAnchorClient.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/hooks/useOpenPlanningWorkspace.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/PlanningWorkspaceOverlay.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/PlanCloseGuard.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/PlanningWorkspaceHost.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/planning/page.tsx': { lines: 90, functions: 90, branches: 90, statements: 90 },
        // ⚠️ BRANCHES PINNED AT 83, WITH A REASON, AND THE OTHER THREE AT 100.
        // The anchor route's two remaining branches are the SAME unreachable
        // case counted twice: `ProjectNotFoundError` cannot arrive here (the
        // service rejects a foreign tenant with `WorkItemNotFoundError` before
        // the access read that raises it), and the re-throw behind it is
        // therefore unreachable too. Both carry a `v8 ignore` naming the test
        // that asserts the ordering they rest on — but v8 counts an implicit
        // `else` on the LINE OF THE `if`, which no comment on the branch below
        // can suppress. Reaching either would mean mocking `workItemsService`,
        // which is exactly what stops proving this route's 404 contract. So the
        // number is pinned at what is real, with the reason, rather than the
        // guard being weakened for the file as a whole: statements, lines and
        // functions all gate at 100 here.
        // MEASURED: 100 statements / 83.33 branches / 100 functions / 100 lines.
        'app/api/work-items/planning-anchor/route.ts': {
          lines: 100,
          functions: 100,
          branches: 83,
          statements: 100,
        },
        // Story MOTIR-3440 · Subtask MOTIR-3449 — the two arrival primitives,
        // MEASURED at 100/100/100/100 each before being pinned (see `include`).
        'components/ui/PageSkeleton.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-4669 · MOTIR-4684 — the repository-tenancy surface ────
        // Pinned at the project floor after MEASURING each on this branch. The
        // branch axis is 75 on the two services rather than 90, and that is a
        // DISPOSITION rather than a discount — every arm below the line is
        // DEFENSIVE, and each was read off its PRODUCER:
        //
        //   organizationRepoService 125/129 — `translateLinkViolation`'s
        //     non-array `meta.target` and its non-P2002 rethrow. The producer is
        //     Prisma: `target` is an array for a composite index (which both of
        //     this file's unique indexes are), and the rethrow is reached only by
        //     an error class the `catch` does not claim. Its P2002 arms ARE
        //     covered, by two real concurrency races in
        //     `tests/projectRepos/organizationRepoService.test.ts`.
        //   organizationRepoService 563 — the same helper's second call site, on
        //     the CONNECT path. Reaching it needs a name collision created
        //     between that path's pre-check and its insert, by a caller that has
        //     just performed a provider install. A fixture for it would be a
        //     fixture nobody can build.
        //   organizationAccessService 88 — the `?? null` on a membership row that
        //     is `undefined` rather than absent. The producer is
        //     `findByOrgAndUserInTx`, which returns `null`, so the branch is
        //     unreachable through it and exists to keep the coalesce total.
        //   organizationSettingsNav 234 — `if (!entry.href) return false`. Every
        //     entry in the registry has an href BY CONSTRUCTION, and the
        //     route↔registry totality test is what holds that: an entry without
        //     one would fail there before it could reach this line.
        //
        // ⚠️ NONE of these is rule-bearing, and none is silenced with an ignore
        // directive: a defensive arm that is genuinely unreachable is better left
        // measurable than annotated, so a future change that MAKES it reachable
        // shows up as a coverage move rather than passing under a comment.
        'lib/services/organizationRepoService.ts': {
          lines: 90,
          functions: 90,
          branches: 75,
          statements: 90,
        },
        'lib/services/organizationAccessService.ts': {
          lines: 90,
          functions: 90,
          branches: 75,
          statements: 90,
        },
        'lib/settings/organizationSettingsNav.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/organizationRepoMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-1215 · Subtask MOTIR-3646 — both measured at 100 on all
        // four axes on this branch before pinning.
        // Story MOTIR-3808 · MOTIR-3816 — pinned at the project floor after
        // measuring each on this branch (see the `include` note above).
        'lib/repositories/workItemTodoRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/workItemTodosService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/dto/workItemTodos.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/workItemTodoMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItemTodos/limits.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItemTodos/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/items/[key]/todoActions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/items/[key]/_components/TodoListSection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/RequireTwoFactorCard.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/organization/security/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/workspace/security/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/WorkspaceFoldInSection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/auth/twoFactorGate.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/auth/requireCompliantSession.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/two-factor-required/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/two-factor-required/_components/SignOutLink.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/two-factor-required/_components/HeldEnrolment.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/settings/SettingsPaneFrame.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.9 · Subtask 8.9.8 — the six logic files this story adds, each
        // MEASURED on this branch before being pinned (see the `include` note).
        // The floor is the repo's usual 90; the measured values sit above it.
        'lib/publicProjects/followTokens.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/publicProjects/changelogCursor.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/publicProjects/atomFeed.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/publicFollowRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/publicFollowService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.4 · Subtask MOTIR-1135 — all five measured at 100 on every
        // axis (see the `include` block's note). 90 is the standard floor, so
        // there are ten points of headroom before the gate bites; it is a
        // ratchet against a regression, not a target to hit.
        'lib/legal/consent.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/legal/documents.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/legal/links.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/legal/reconsentGate.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/legalAcceptanceRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/legalAcceptanceService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.4 · Subtask MOTIR-3698 — all three measured at 100 on every
        // axis (see the `include` block's note). 90 is the standard floor, so
        // there is headroom before the gate bites; it is a ratchet against a
        // regression, not a target to hit.
        'lib/users/dataSubjectRequests.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/accountDeletionRequestRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/dataExportRequestRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.4 · Subtask MOTIR-3700 — both measured at 100 on every axis
        // (see the `include` block's note). 90 is the standard floor.
        'lib/services/accountDeletionService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.4 · Subtask MOTIR-3702 — all three measured at 100 on every
        // axis (see the `include` block's note). 90 is the standard floor.
        'lib/users/accountErasure.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/accountErasureSweepService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/accountErasureSweep.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ⚠️ This one's BRANCH floor is 78, not 90, and the reason is stated
        // rather than rounded away. Its two uncovered arms are in
        // `resolveRecipient`: the `!follow.userId` return and the `user?.email`
        // null arm. Both are UNREACHABLE — the `public_follow_identity_exactly_one`
        // CHECK guarantees one identity is set, the `user_id` FK guarantees the
        // row exists, and `user.email` is non-null. Reaching them in a test would
        // mean writing a row the database refuses.
        //
        // The alternative was deleting the defensive arms to buy the number,
        // which trades real safety for a metric. 78 is a RATCHET pinned just
        // under the measured 78.78: it still fails on a regression, and it does
        // not lower the bar for the three axes that do hold at 100.
        'lib/services/publicFollowDigestService.ts': {
          lines: 90,
          functions: 90,
          branches: 78,
          statements: 90,
        },
        // Story MOTIR-2282 · Subtask MOTIR-2264 — every file this story added,
        // named explicitly and MEASURED before being pinned (all six are at 100%
        // lines / branches / functions on this branch). The glob form matters for
        // the same reason as in `include` above: a literal `app/(authed)/…` key
        // matches no reported file, so the threshold would pass vacuously.
        // MOTIR-2527 — the membership reader, measured at 100/100/100 on this
        // branch before being pinned (see the `include` note above).
        // Story MOTIR-3414 · Subtask MOTIR-3426 — the Postgres job engine.
        // MEASURED on this branch before being pinned (see the `include` note):
        // cutover / dispatcher / registry / runner 100 across the board; ledger
        // 100/95/100/100; notify 97.9/94.1/100/100; step 98.5/92.5/100/100;
        // worker 98.3/95.9/96.2/99.0; all three repositories 100.
        //
        // ⚠️ A GLOB, not a per-file list, deliberately: the next story in this
        // epic ADDS files here (the scheduler, the supervisor collapse), and a
        // hand-maintained list is one a new file forgets to join — which is the
        // same failure this gate's own guard exists to catch, one level up.
        'lib/jobs/engine/**': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3472 — measured at 100/100/100 before pinning; see the `include`
        // note for why its sibling `defineJob.ts` is report-only instead.
        'lib/jobs/catchUp.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/jobQueueRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/jobStepRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/jobEventRepository.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3766 — measured at 100 / 95.45 / 100 / 100; see the `include` note.
        'lib/services/platformHealthService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workspaces/membershipGate.ts': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-2643 — MEASURED before being pinned, on this branch, with
        // `tests/acceptance-video-diagnostics.test.ts`: 90.9 branches / 100
        // functions / 100 lines. See the `include` note above for why this file
        // is worth a floor at all.
        'tests/e2e/_helpers/acceptance-diagnostics.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/permissionMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/settings/projectSettingsNav.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3878 · Subtask MOTIR-4223 — MEASURED on this branch over
        // tests/publicAddresses + tests/settings + tests/api/public + tests/rls
        // + tests/jobs, then pinned. These EIGHT clear the floor on all three
        // metrics:
        //
        //   publicAddressCertificateRefresh  100 / 100 / 100
        //   allowedOrigins                   100 /  95 / 100
        //   certificateProvider              100 / 100 / 100
        //   dnsResolver                      100 / 100 / 100
        //   errorResponse                    100 / 100 / 100
        //   reservedNames                    100 / 100 / 100
        //   tenantDomain                     100 / 100 / 100
        //   publicSubdomainService          98.1 / 90.9 / 100
        //
        // ⚠️ THE REST OF THE STORY'S SURFACE IS IN `include` AND DELIBERATELY
        // NOT HERE, which is this file's own established pattern ("so CI
        // publishes a number without gating on one") — and MOTIR-4223 records
        // the shortfall rather than hiding it. What is missing is BRANCH
        // coverage, on files whose LINES are already 85–100: the four lifecycle
        // routes sit at 66.7% branches because each has three arms and the
        // rethrow is exercised on one route rather than four, and the
        // repository at 33.3% has an `InTx`/non-`InTx` pair per method. Both are
        // real gaps and neither is a hole in the SHIPPED behaviour — every route
        // now has a test where none had one before this card.
        'lib/jobs/definitions/publicAddressCertificateRefresh.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/publicAddresses/allowedOrigins.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/certificateProvider.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/dnsResolver.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/errorResponse.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/reservedNames.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/tenantDomain.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/publicSubdomainService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2258 · Subtask MOTIR-2476 — both MEASURED before being
        // pinned, on this branch, with the story's own suites: the nav map at
        // 100/100/100 and the provider at 100/100/100.
        'lib/settings/projectNavAccess.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2554 · Subtask MOTIR-2558 — MEASURED before being pinned,
        // on this branch, with the story's own suites: all three at 100/100/100
        // (branches / functions / lines). Pinned at 90 rather than 100 so a
        // future branch of the ladder can land with its test in the same PR
        // without the gate turning into a ratchet nobody can move.
        'app/**/_components/ShellTierNav.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/ProjectTier.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/TopNav.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/ProjectAccessProvider.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/project/roles/_components/*.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2257 · Subtask MOTIR-2486 — the story gate PINS what the
        // story added, because an unnamed new file is an ungated one and this is
        // the card that owns "every file this story changed meets the gate".
        //
        // MEASURED FIRST, then pinned — the order this file's header argues for,
        // and the follow-up the `lib/permissions/**` note above asked for by
        // name. On this branch, over `tests/permissions` + `tests/settings` +
        // the members suites: every `lib/permissions/*` file is at 100% on all
        // three metrics; the service is 100 / 97.95 / 100; the repository and
        // both route handlers are at 100%.
        //
        // ⚠️ `lib/permissions/**` IS PINNED AS A GLOB, WHICH AGGREGATES the six
        // files into one summary rather than gating each. That is the honest
        // shape here: `catalog.ts` and `builtinRoles.ts` predate this story and
        // pinning them individually would gate code no card here wrote. The four
        // files the epic added or rewrote carry the aggregate on their own.
        'lib/permissions/**': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectRoleDefinitionService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/projectRoleDefinitionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/**/roles/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/projects/**/roles/**/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.1 · Subtask 11.1.5 — the public `/api/v1` envelope.
        'lib/api/v1/route.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-2275 — the ONE definition of the contract version, read by both
        // the emitted document and the header the wrapper stamps.
        'lib/api/v1/contractVersion.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-2388 — the ONE definition of the app's own origin.
        'lib/baseUrl.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1163 — the ONE definition of whether analytics is on, and the
        // only surface that renders it. MEASURED on this branch over
        // `tests/analytics.test.tsx`: both files 100 / 100 / 100. Pinned at the
        // project's 90 rather than at the measurement.
        'lib/analytics.ts': { branches: 90, functions: 90, lines: 90 },
        'components/analytics/AnalyticsScript.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2384 · Subtask MOTIR-2394 — the object-store seam.
        //
        // MEASURED FIRST, then pinned, on this branch over `tests/attachments`,
        // `tests/hosting`, `tests/baseUrl` and `tests/mappers/avatar-projection`:
        // `uploader.ts` and `s3.ts` at 100 / 100 / 100, `referencedUrls.ts` at
        // 94.11 statements / 91.66 branches / 100 functions / 96.42 lines. The
        // uploader reached that number in this card — it entered at 76.19%
        // branches, with `withRandomSuffix`'s extension-less arm, two of
        // `toBuffer`'s three input shapes and both of `headPrivateBlob`'s
        // metadata defaults unexercised. Those are exactly the behaviours
        // MOTIR-2389 had to REIMPLEMENT because the old provider did them
        // server-side, which is what made them the wrong branches to leave
        // unmeasured.
        'lib/blob/uploader.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/blob/s3.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/blob/referencedUrls.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2588 · Subtask MOTIR-2681 — the project's MARK.
        //
        // MEASURED FIRST, then pinned, on this branch over
        // `tests/integration/projectImageUploadRoute`, `tests/components/
        // project-{logo-field,mark}`, `tests/project-details-service` and
        // `tests/attachments/referenced-urls`:
        //   imageUpload.ts             100 / 100 / 100
        //   ProjectMark.tsx            100 / 100 / 100
        //   ProjectLogoField.tsx       100 lines / 95.83 branches / 100 functions
        //   project-image/route.ts      90 lines /  91.66 branches / 100 functions
        //
        // Two of them ENTERED this card below the floor and were brought to it by
        // real tests, which is what the measurement was for: `ProjectLogoField`
        // sat at 86.53 / 79.16 / 75 with every FAILURE arm unexercised (a refused
        // upload, a thrown request, a failed remove, the in-flight dismissal
        // guard) and `ProjectMark` had no test at all, because the file it
        // replaced took its test with it.
        'lib/projects/imageUpload.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/ProjectLogoField.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/ProjectMark.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/api/upload/project-image/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3584 · Subtask MOTIR-3590 — the project's repository SET on
        // `/api/v1`. MEASURED FIRST, then pinned, on this branch over
        // `tests/api/v1/project-repositories-route` and
        // `tests/integration/linkClonesCheckoutsStoryGate`:
        //   lib/api/v1/projects/repositories.ts     100 / 100 / 100 / 100
        //   app/api/v1/…/repositories/route.ts      100 / 100 / 100 / 100
        //
        // The route ENTERED this card at 50% branches: the `position` tie-break
        // was unexercised, because no service API produces two rows sharing a
        // fractional key on demand. It is a RULE-BEARING arm, not a defensive one
        // — `moveRow` computes `position` from a read that guards a write, so two
        // concurrent moves really can land the same value, and a cursor cannot
        // page soundly over an order that shuffles. The test forces the tie
        // through the admin client rather than ignoring the arm.
        'lib/api/v1/projects/repositories.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/[projectKey]/repositories/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/api/v1/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/bearer.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/pagination.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/rateLimit.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 8.5 · Subtask 8.5.9 — MOTIR-1165. Named file by file rather than
        // by glob: an unnamed new file is an ungated one.
        'lib/rateLimit/store.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/postgresStore.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/limiter.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/guard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/keys.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/budgets.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/authGuard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/publicWriteGuard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/aiGuard.ts': { branches: 90, functions: 90, lines: 90 },
        // The MCP transport's guard (MOTIR-2610). Listed for the same reason as
        // its nine siblings above: `include` is the `lib/rateLimit/**` glob, so a
        // new file lands in the REPORT automatically but is gated by nothing
        // until it has a key here — and a limiter nobody measures is exactly the
        // shape of the gap this card exists to close.
        'lib/rateLimit/mcpGuard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/fixedWindow.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/rateLimitService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/rateLimitCounterRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/ai/jobAuthResponse.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/me/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/workspaces/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.7 · Subtask 11.7.8 — MOTIR-2242. Every file the story added
        // or widened, named explicitly: an unnamed new file is an ungated one.
        'lib/api/v1/workLoop/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workLoop/operations.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workLoop/planScope.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/childEdges.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/resolveKey.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/work-items/[key]/attachments/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/dispatch-prompt/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/claim/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/plan-approval/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/scope-claims/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/integration/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/expansions/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/activity/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/sessions/complete/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/plans/[planId]/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/plans/[planId]/status/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/[projectKey]/plan-session/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/plan-session/turns/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/plan-session/submissions/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2192 · Subtask MOTIR-2166 — the code-graph offboarding queue.
        // Story MOTIR-1755 · Subtask MOTIR-2207 — the multi-repo audit tab.
        'lib/codeHealth/repoAuditRows.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/code-health/_components/AuditRepoList.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2244 · Subtask MOTIR-2247 — the repo-scoped audit trigger.
        'lib/codeHealth/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/coding-convention/_shared.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/coding-convention/refresh/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Subtask MOTIR-2248 — the audit-coverage read.
        'lib/services/auditCoverageService.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-2266 — the first-audit trigger.
        'lib/services/firstAuditTriggerService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/codeHealth/reauditRun.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/AuditCoverageBanner.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/coding-convention/audit-coverage/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/codeGraph/offboarding.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/codeGraphOffboardingRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/codeGraphOffboardingService.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-2168 — the sweep.
        'lib/services/codeGraphOffboardSweepService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/jobs/definitions/codeGraphOffboardSweep.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Subtask MOTIR-2197 — the live-project read seam.
        'lib/codeGraph/liveProjects.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/liveProjectsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/internalApi/serviceAuth.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.3 · Subtask 11.3.10 — the planning resources.
        'lib/api/v1/projects/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/sprints/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/sprints/membership.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/ready/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/rankedCollections.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.3 — the SHARED wire-schema layer.
        'lib/api/v1/openapi/statuses.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/errorResponse.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/envelopes.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/headers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/security.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.4 — the registry, the emitter and the route.
        'lib/api/v1/openapi/operation.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/registry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/emit.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/operations.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/openapi/v1.json/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3876 · Subtasks MOTIR-3945 + MOTIR-3946 — the public read
        // contract (see the `include` note above; each measured at 100/100/100).
        // Story MOTIR-3876 · Subtask MOTIR-3885 — the origin seam (measured
        // 100/100/100 each; see the `include` note above).
        // (`app/sitemap.ts` sat here and is DELETED — MOTIR-4583.)
        'lib/publicProjects/urls.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3876 · Subtask MOTIR-3726 — robots (measured 100/100/100).
        'lib/robotsPolicy.ts': { branches: 90, functions: 90, lines: 90 },
        'app/robots.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/contractVersion.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/openapi/operation.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/openapi/schemas.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/openapi/operations.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/openapi/emit.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/openapi/public.json/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/public/p/[identifier]/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3932 · Subtask MOTIR-4194 — the published tool catalogue.
        'app/api/docs/mcp-tools.json/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3877 · Subtask MOTIR-4120 — the reads and the act path
        // (the include block above carries the finding: they were outside this
        // report entirely, because the sibling entry is a LITERAL path).
        // MEASURED on this branch at 100/100/100 each, except `/act` (92.3
        // branches) and the overview write (92.85), whose remaining arms are the
        // capability gate's `false` side — driven in `cloud-gate.test.ts`, which
        // is in a different run. Pinned at the floor, not at the measurement.
        'app/api/public/p/[identifier]/board/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/p/[identifier]/roadmap/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/p/[identifier]/items/[key]/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/p/[identifier]/requests/[requestKey]/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/p/[identifier]/changelog.xml/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/projects/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/projects/[key]/public-overview/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/act/route.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicProjects/returnTarget.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicProjects/cors.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3908 · Subtask MOTIR-4037 — the capability gate (above).
        'lib/billing/availability.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicProjects/cloudGate.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.5 — the remaining operation declarations.
        'lib/api/v1/identity/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/planning/operations.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 8.12 · Subtask MOTIR-3612 — MEASURED on this branch, in these
        // numbers, before being pinned:
        //   PasskeyManager.tsx        97.56 / 92.10 / 100 / 100
        //   AccountSecurityPanes.tsx    100 /    100 / 100 / 100
        //   twoFactorMethods.ts         100 /    100 / 100 / 100
        // (statements / branches / functions / lines).
        'app/**/settings/account/_components/PasskeyManager.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/AccountSecurityPanes.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/twoFactorMethods.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.12 · Subtask MOTIR-3613 — MEASURED at
        // 95.83 / 90.47 / 100 / 100 (statements / branches / functions / lines).
        // Story 8.12 · Subtask MOTIR-3614 — MEASURED at 100 / 100 / 100 / 100
        // (statements / branches / functions / lines) for all four.
        'lib/auth/passkeyConfig.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/passkeyRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/passkeyMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/passkeyService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/PasskeySignInButton.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/ApiDocsLinkPanel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/[projectKey]/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/[projectKey]/sprints/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/backlog/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/backlog/work-items/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/ready/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/sprints/[sprintId]/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/sprints/[sprintId]/start/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/sprints/[sprintId]/complete/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/sprints/[sprintId]/work-items/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1775 · MOTIR-1896 — the CI-minutes meter.
        'lib/ciMetering/runnerRates.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciMetering/normalize.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciMetering/period.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciMetering/config.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciMinutesMeterService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciMinutesReconciliationService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/ciWorkflowRunUsageRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/ciPeriodUsageRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/ciMinutesReconcile.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1916 · MOTIR-1924 — the fleet COST meter.
        'lib/services/ciFleetCostMeterService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/ciContainerUsageRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/ciContainerPeriodCostRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1916 · MOTIR-1927 — the rest of the fleet (see the
        // include list for why the port ships gated alongside the services).
        'lib/orchestrator/index.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1981 · MOTIR-1992 — the index fleet (see the include list).
        'lib/services/codeGraphIndexDispatchService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/codeGraphIndexAdmissionService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/jobs/indexFleetSteps.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/codeGraphIndex.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/config.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/limits.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/workloads.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/bootDispatch.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/runnerJitConfig.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciRunnerProvisioningService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/ciRunnerBootService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciRunnerAdmissionService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/fleetCeilingService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/ciRunnerProvisioningIntentRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/ciFleetAdmissionLockRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/fleetInFlightSlotRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/jobs/definitions/ciRunnerFleet.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1775 · MOTIR-1901 — the CI-minutes entitlement.
        'lib/ciMetering/allowance.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciAllowanceService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/ciPeriodChargeRepository.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.7 · Subtask 5.7.6 — notification-preference channel gate.
        'lib/services/notificationPreferencesService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/notificationPreferenceRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/notificationPreferenceMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/notifications/preferences.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.7 · Subtask 5.7.7 — the in-app model + fan-in + read/mark API gate.
        'lib/repositories/notificationRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/notificationsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/notificationFanInService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/notificationFanIn.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/notifications/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/workItemsService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1789 (Agent runs) · MOTIR-1798 — the dispatch-run seam,
        // measured before it was pinned (see the `include` note above). Pinned at
        // the project's 90, NOT at the measured number: a threshold set to
        // today's figure turns every honest refactor into a red build, and the
        // floor is what the project actually asks of a file.
        'lib/services/dispatchRunService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/dispatchRunRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/dispatchRunCardRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/dispatchRunEventRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/dispatchRunMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-3050 (see the `include` note above).
        'lib/workItems/blockerReadiness.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workItems/readyFilter.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2694 · Subtask MOTIR-2696 (see the `include` note above).
        'lib/workItems/embeddingDocument.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemEmbeddingRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/workItemEmbeddingsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/workItemEmbedding.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2694 · Subtask MOTIR-2697 (see the `include` note above).
        'app/api/internal/ai/similar-work-items/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-4053 · Subtask MOTIR-4076 (see the `include` note above).
        'app/api/internal/ai/log-bug/route.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/aiWorkItemsService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2694 · Subtask MOTIR-2698 — the keys-not-prose enforcement
        // point (see the `include` note above; `aiBoundaryService.ts` is
        // deliberately NOT here, and that note says why).
        'lib/mappers/aiBoundaryMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // The prose-vs-graph advisory (MOTIR-1969) — an ADDITION beside the
        // finishability rules, gated on its own so a regression in it can't hide
        // inside workItemsService's blended number.
        'lib/workItems/proseVsGraph.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/proseGraphAdvisoryService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workItems/repoDelivery.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemRepoRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ai/projectRepoContext.ts': { branches: 90, functions: 90, lines: 90 },
        'components/workItems/RepositorySetField.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/services/backlogService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemLinkRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemRevisionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/workflowsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workflowsRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/reportsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/reportsMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/sprintRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/scale.ts': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/LineChart.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/BarChart.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/ChartFrame.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/ChartLegend.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/ChartDataTable.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/billing/aiEntitlement.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.1 (comments): the repo leaves land gated from day one
        // (Subtask 5.1.1); commentsService joins the list with 5.1.2.
        'lib/repositories/commentRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/commentMentionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/commentsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/commentMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mentions/parse.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.4 (labels/components/watchers): the repo leaves land gated
        // from day one (Subtask 5.4.1); the 5.4.2–5.4.4 services join next.
        'lib/repositories/labelRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemLabelRepository.ts': { branches: 90, functions: 90, lines: 90 },
        // 5.4.2 — the folksonomy service layer gates with its tests.
        'lib/services/labelsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/labelMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/componentRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemComponentRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/watcherRepository.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.5 (activity feed): the read service + the TOTAL renderer
        // registry (Subtask 5.5.1) gate from day one — the registry's
        // fallback/suppression branches are the mistake-#29 guarantee.
        'lib/services/activityService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/activity/renderers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/activityMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.3 (custom fields): the repo leaves land gated from day one
        // (Subtask 5.3.1); customFieldsService + mappers joined with 5.3.2
        // (the 5.3.3 values half extends the same files under this gate).
        'lib/repositories/customFieldDefinitionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/customFieldsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/customFieldMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/customFieldOptionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/customFieldValueRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story 5.2 (attachments): upload (2.3.7) + the 5.2.7 orphan-GC sweep
        // + the 5.2.2 management surface (repo leaf + panel mapper).
        'lib/services/attachmentsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/attachmentRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/attachmentMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 6.2 (saved filters): the 6.2.1 persistence + permission layer.
        'lib/services/savedFiltersService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/savedFilterRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/savedFilterStarRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/savedFilterMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/savedFilters/access.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/savedFilters/builtins.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 6.3 (dashboards) — the 6.3.1 substrate.
        'lib/services/dashboardsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/dashboardRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/dashboardWidgetRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/dashboardMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/dashboards/widgetRegistry.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 6.3 (dashboards & reports): the 6.3.2 read substrate.
        'lib/reports/statisticTypes.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/reports/buckets.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/reports/params.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 6.6 (automation rules): the 6.6.1 backend.
        'lib/automation/registry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/automation/fields.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/automation/constants.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/automationRulesService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/automationRuleRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/automationRuleMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // 6.6.2 — the execution engine + audit-row leaf.
        'lib/services/automationEngineService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/automationRuleExecutionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story 7.2 · Subtask 7.2.11 (locked by 7.2.12) — org cost read service.
        'lib/services/aiUsageService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 7.8 · Subtask 7.8.1 — the PAT auth substrate.
        'lib/services/apiTokensService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/apiTokenRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/apiTokenMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/apiTokens/token.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/apiTokens/errors.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2572 · Subtask MOTIR-2585 — the permission GRANT and the
        // surfaces that offer it. Measured on this branch before pinning.
        'lib/tokens/grant.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/toolPermissions.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/permissionGate.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/scopes.ts': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-3342 — the unknown-argument gate (see the `include` note).
        'lib/mcp/strictInput.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/account/_components/permissionMeta.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/account/_components/CreateTokenModal.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/account/_components/apiTokensClient.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story 7.7 · Subtask 7.7.12 — the MCP registry + every tool module.
        'lib/mcp/registry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/getWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/listReady.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/createWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/addComment.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/attachFile.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/searchWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/listSprints.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1879 — the project-enumeration read (tests/mcp/list-projects.test.ts
        // walks both the populated and empty-list arms plus the thrown-error path).
        'lib/mcp/tools/listProjects.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/validateSprint.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3095 — measured at 100/100/100 before being pinned (see the
        // `include` note above); at 90 rather than 100 so a later branch can
        // land with its test in the same PR without the gate becoming a ratchet.
        'lib/mcp/tools/validatePlan.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/planRef.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-3097 — the story gate PINS what the story added, because
        // an unnamed new file is an ungated one. MEASURED FIRST, on this branch,
        // over `tests/mcp/plan-projection-gate` + `projected-reads` +
        // `validate-plan` + `tests/integration/plans/planValidityService` +
        // `tests/integration/ai/validatePlanRoutes`: 100 lines / 90.9 branches /
        // 100 functions. Pinned at 90, the floor it clears, rather than at the
        // measured number — a threshold nobody can land a new branch under is a
        // ratchet, and this file is the one both halves of the story read.
        'lib/services/planProjectionService.ts': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-3123 — the finishability engine, MEASURED FIRST on this
        // branch over its FULL consumer set (`tests/integration/plans/
        // planValidityService` + `tests/integration/ai/validatePlanRoutes` +
        // `tests/mcp/validate-plan` + `tests/mcp/plan-projection-gate` +
        // `tests/mcp/projected-reads` + `tests/rls/shared-read-seams` +
        // `tests/app-role-bound-context-reads`): 75.96 branches / 94.73
        // functions / 93.93 lines BEFORE this bug's cases, 92.85 / 100 / 100
        // after. A local subset can only UNDER-report against CI's full run, so
        // the floor below is cleared with room. Pinned at 90 rather than at the
        // measured number for the same reason as the line above — a threshold
        // nobody can land a new branch under is a ratchet.
        'lib/services/planValidityService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/createSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/updateSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/deleteSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/moveToSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/moveToBacklog.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/startSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/completeSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/markIntegrated.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/linkWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3526 — MEASURED before being pinned (100 statements / 100
        // branches / 100 functions / 100 lines over the two new suites), then
        // pinned at the project's 90 rather than at the measurement, so ordinary
        // churn does not fail the build while a real regression does.
        'lib/mcp/tools/linkPullRequest.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/updateWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/archiveWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/deleteWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/expandItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/dependencyEdges.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3098's two discovery reads (MOTIR-3102).
        'lib/mcp/tools/skeleton.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/searchWorkItemsSemantic.ts': { branches: 90, functions: 90, lines: 90 },
        // These four gate on functions + lines only: each carries DEFENSIVE
        // branches unreachable under shipped invariants, so a 90% BRANCH bar
        // would fail on un-coverable code.
        //   • whoami: the `user.name || user.email` fallback — `User.name` is
        //     non-nullable, so the email arm never runs.
        //   • transition_status: the illegal-transition enricher's open-policy
        //     arm (no IllegalTransitionError is thrown under `open`), its
        //     status-not-in-workflow guard (the item's status is always a real
        //     workflow status), and its terminal-status arm (no status in the
        //     default restricted workflow has zero outgoing transitions).
        //   • next_ready: the `contextRefs.length > 0` summary arm —
        //     `contextRefs` is not yet a persisted field, so it is always empty.
        //   • complete_session: the `reason ?? 'failed'` fallback — a `failed`
        //     outcome always carries the typed error's message.
        'lib/mcp/tools/whoami.ts': { functions: 90, lines: 90 },
        'lib/mcp/tools/transitionStatus.ts': { functions: 90, lines: 90 },
        'lib/mcp/tools/nextReady.ts': { functions: 90, lines: 90 },
        'lib/mcp/tools/completeSession.ts': { functions: 90, lines: 90 },
        // Story 7.10 · Subtask 7.10.8 (MOTIR-896) — the GitHub integration gate:
        // no untested branch in the webhook state machine or the feed dispatch.
        'lib/services/githubWebhookService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/githubInstallationService.ts': { branches: 90, functions: 90, lines: 90 },
        // codeGraphIndexService gates on functions + lines only: its
        // `workspace_missing` arm is DEFENSIVE and unreachable under shipped
        // invariants (GithubInstallation.workspace cascades on delete, so an
        // installation row can never outlive its workspace).
        'lib/services/codeGraphIndexService.ts': { functions: 90, lines: 90 },
        'lib/github/indexEnqueue.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/webhookSignature.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1775 · MOTIR-1781 — the repo-creation primitive (see the
        // `include` note): every branch of it either makes a repository exist or
        // decides whose an existing one is, and neither is undoable.
        'lib/github/repoProvisioning.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectRepoProvisioningService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1916 · MOTIR-1972 — the per-project runner group (see the
        // `include` note): every branch decides which tenant's repositories a
        // fleet runner may serve.
        'lib/github/runnerGroups.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectRunnerGroupService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1775 · MOTIR-1782 — the establish step + its wire contract.
        'lib/services/projectRepoEstablishService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/projectRepos/errorResponse.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1775 · MOTIR-1945 — the team code-access surface.
        'lib/projectRepos/teamAccessView.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/project/code-access/_components/CodeAccessSettings.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1775 · MOTIR-1939 — the take-it-over room (see the
        // `include` note).
        'lib/github/userOrgs.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectRepoRoomService.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/github/organizations/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/project/repositories/_components/TakeoverRow.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/project/repositories/_components/TakeoverModal.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/project/repositories/_components/RepositoriesRoom.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/project/repositories/_components/ConnectedRepositories.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/projectRepos/effectiveDomain.ts': { branches: 90, functions: 90, lines: 90 },
        // ⚠️ `statements` added by MOTIR-4681, which gave this module
        // `splitSetRowsByOrigin`. The module was ALREADY pinned here, so the
        // story strengthens the existing row rather than adding a second one —
        // two entries for one path is a duplicate key, and the later wins
        // silently.
        'lib/projectRepos/roomSections.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'lib/planning/repositorySetClient.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/repositories/RepositorySetStep.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/planning/repositories/RepositoryRow.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/[rowId]/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/[rowId]/state/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/[rowId]/move/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/establish/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/ai/codeContext.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 7.30 · Subtask MOTIR-1732 — the plan-change conversation, the
        // planning-workspace host contract, and the rail's client state machine.
        // Story MOTIR-1343 · MOTIR-1819 — measured on this branch before pinning
        // (see the `include` note above for the numbers and for why the three
        // route files are report-only).
        'lib/services/aiAskService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/askResult.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1822 — the three ask ROUTES, pinned once the story gate made
        // their rethrow arms reachable (see the `include` note above for the
        // measured numbers). ⚠️ The stream route's key must use `**`, never a
        // literal `[jobId]`: in a glob that is a CHARACTER CLASS, so the literal
        // path names a directory that does not exist and the entry would gate
        // nothing while looking like it gated something.
        'app/api/ai/ask/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/ask/settle/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/ask/**/stream/route.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/planChangeSessionsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/planChangeSessionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/planChangeTurnRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/planChangeMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planChange/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/launcher.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/workspaceHost.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/planChangeDiff.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/planChangeClient.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/hooks/usePlanChangeConversation.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.12.3 (MOTIR-909) — the contextual-planning scope + orchestration.
        'lib/planChange/scope.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/contextualPlanningService.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-2787 — the planning-target lock, its lease module, its data leaf
        // and its recovery sweep.
        'lib/services/planTargetLockService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/planTargetLockRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/planChange/targetLock.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/planTargetLockSweep.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3064 — the abandoned-plan reconciler and its sweep job.
        'lib/services/abandonedPlanService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/abandonedPlanSweep.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.12.5 (MOTIR-911) — the persist-time confirmation gate.
        'lib/plans/validateProposals.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.12.6 (MOTIR-912) — the shared review/confirm seam.
        'lib/planning/planReview.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/planReviewClient.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.13.3 (MOTIR-916) — the unattended auto-plan cadence trigger.
        'lib/services/autoPlanCadenceService.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.13.7 (MOTIR-920) — the rest of the Story 7.13 surface at the
        // same floor. `limits.ts` / `plannerModels.ts` are the dependency-free
        // modules the settings PANEL imports directly, so a regression in them
        // reaches the browser with no service test in the way.
        'lib/services/aiSprintPlanningService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectAiSettingsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ai/sprintAssignment.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/projectAiSettingsMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/projectAiSettings/limits.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/projectAiSettings/plannerModels.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/autoPlanCadenceTick.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-1808 — the roadmap auto-drill surface at the same floor.
        // Story MOTIR-3833 · MOTIR-3840. Measured on the story's branch:
        // canvasGeometry L100 B92.42 F100 · RoadmapView L100 B97.29 F100 ·
        // useDependencyLegendCollapsed 100/100/100.
        'lib/planning/canvasGeometry.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/RoadmapView.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/hooks/useDependencyLegendCollapsed.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/ProjectRoadmapCanvas.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/planning/WorkItemRoadmap.tsx': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-2205 — the planning phase card's drill surface, same floor.
        'components/planning/preplanStationLevel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/planning/PlanningOriginCluster.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/planning/workItemLevel.tsx': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-1870 — the `motir login` surface at the same floor.
        'lib/repositories/deviceCodeRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/cliDeviceMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/cliDevice/constants.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/cliDevice/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/cliDevice/userCode.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/cli/device/approve/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/cli/device/grant/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/account/_components/ConnectCliPanel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // These four gate on FUNCTIONS + LINES only — the same carve-out this
        // config already makes for `whoami` and friends, and the CLI lane makes
        // for `mcpClient` / `help`. Each is at 100% functions and ≥95% lines; what
        // the 90% BRANCH bar would fail on is un-coverable code, named here so a
        // future reader can tell a carve-out from a gap:
        //   • cliDeviceService — three `throw err` rethrows that re-raise anything
        //     the shipped invariants say cannot arrive: a non-`NotAMemberError`
        //     failure out of the mint, and the two `translate*Error` fall-throughs
        //     for a plugin error that is not an `APIError`. Reaching them means
        //     stubbing Better-Auth, which would test the stub.
        //     ⚠️ The LINE figure here is deliberately pinned by deterministic tests
        //     (Bug MOTIR-1955). Until then `translateApproveError` was executed only
        //     when the two-simultaneous-approvals race happened to make the loser
        //     fail at the plugin instead of at the pre-checks — an outcome the test
        //     asserts either way. When a CI run landed on the other side the file
        //     read 87.8% instead of 96.34% and this threshold failed a PR whose diff
        //     was one unrelated test file. The fix was to cover those branches
        //     deterministically, NOT to lower the number: a threshold that a race
        //     can cross is the defect, and lowering it would only widen the window.
        //   • start/route + token/route — a `body ?? {}` arm that cannot be null
        //     (the parse always assigns) and the poll's final rethrow for an error
        //     that is not a `DeviceGrantError`.
        //   • DeviceApproval — JSX presence conditionals (avatar, single- vs
        //     multi-workspace, the token-label chip) whose absent arms are already
        //     asserted through the rendered output rather than through a distinct
        //     branch, plus `readErrorCode`'s unparseable-body catch.
        'lib/services/cliDeviceService.ts': { functions: 90, lines: 90 },
        'app/api/cli/device/start/route.ts': { functions: 90, lines: 90 },
        'app/api/cli/device/token/route.ts': { functions: 90, lines: 90 },
        'app/**/device/_components/DeviceApproval.tsx': { functions: 90, lines: 90 },
        // Story MOTIR-1755 · MOTIR-1758 → gated by MOTIR-1760. The provenance
        // backfill's decision table (see the `include` note). It measures at
        // 100/100/100 today, so this pins what MOTIR-1758 already earned rather
        // than asking for new tests: the point of the gate is that the next edit
        // to a rule cannot quietly ship an unexercised branch.
        'lib/workItems/provenanceBackfill.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1965 — the historical-PR mirror backfill (see the `include`
        // note). Measured at 98/97/95/100 over its own two suites, so this pins
        // what the subtask earned rather than asking for catch-up tests; what
        // stays uncovered is the truncation flag (500 pages to reach) and one
        // non-Error fallback.
        'lib/github/historicalPullRequests.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/historicalPullRequestBackfillService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // MOTIR-3034 (see the `include` note). MEASURED over `tests/github/` +
        // `tests/integration/github/`, then pinned — not guessed:
        //   restRetry.ts                      100 / 100  / 100
        //   pullRequestBase.ts                100 /  96  / 100
        //   pullRequestBaseRefBackfillService 100 /  95  / 100
        //   repoSetCompletionService.ts        93 /  86  / 100   (lines/branches/functions)
        'lib/github/restRetry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/pullRequestBase.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/pullRequestBaseRefBackfillService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // ⚠️ `branches: 85` on this ONE file, and the reason is named rather than
        // left as a softer number somebody later reads as slippage. What stands
        // uncovered is a single arm: `updateStatus` throwing
        // `ProjectAccessDeniedError` / `ProjectNotFoundError`. The move is
        // attributed to the WORKSPACE OWNER (there is no change-request author on
        // this path), and a workspace owner passes `canEdit` on every
        // `accessLevel` — `private` included, where `lib/projects/access.ts`
        // admits them explicitly — so NO VALID FIXTURE produces that error. The
        // arm is still correct to keep: `reevaluateItems` loops, and an uncaught
        // throw there would abort a whole sweep's remaining repairs. Lines and
        // functions are pinned at 90 like every sibling; only the arm that cannot
        // be reached from a legitimate tenant is priced in.
        'lib/services/repoSetCompletionService.ts': {
          branches: 85,
          functions: 90,
          lines: 90,
        },
        // Story 7.24 · MOTIR-1812 → gated by MOTIR-1813 (see the `include` note).
        // Measured over the merged surface, all three files sit at 100/100/100
        // from the shell's own units, so this pins what MOTIR-1812 already earned
        // rather than asking for catch-up tests — the point of the gate is that
        // the NEXT action entry cannot quietly ship an unexercised row.
        'lib/planning/aiCallout.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/AiCalloutMenu.tsx': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3208 — measured at 100/100/100/100 on this branch before pinning.
        'lib/planning/orbPhysics.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/PlanWithAIFab.tsx': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1970 — the schedule-health detection seam (see the `include` note).
        'lib/jobs/cron.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/schedules.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/jobScheduleHealthService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/dailyHealthCheck.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.6 · Subtask 11.6.2 (MOTIR-2228) — the payload seam. Explicit
        // per-file entries because an unnamed new file is an UNGATED one, and a
        // seam whose whole job is that nothing opts out silently must not.
        'lib/mcp/payloads/brand.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/define.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/exemptions.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/sharedResources.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/workItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/planning.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/workLoop.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/driftGuard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/registry.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2284 · Subtask MOTIR-2289.
        'app/**/items/[key]/_components/ChildPanel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/[key]/_components/ChildList.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2560 · Subtask MOTIR-2567 — the editable quick-view rail's
        // story gate. MEASURED FIRST, then pinned (the order this file's header
        // argues for), over the story's own suites plus the three detail-rail
        // suites that drive the shared hooks:
        //
        //   IssueQuickViewPanel.tsx        100.0 L   96.8 B  100.0 F
        //   QuickViewRailEdit.tsx          100.0 L  100.0 B   94.1 F
        //   customFieldEditing.tsx         100.0 L   92.5 B  100.0 F
        //   fieldChipEditing.ts            100.0 L  100.0 B  100.0 F
        //   IssueQuickViewController.tsx    93.3 L   90.9 B  100.0 F
        //
        // Keyed `app/**/…`, never the literal `app/(authed)/…`: picomatch reads
        // the parentheses as a group, so the literal form matches NO file and
        // the threshold would pass vacuously (MOTIR-2449).
        'app/**/items/_components/QuickViewRailEdit.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/fieldChipEditing.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/customFieldEditing.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/IssueQuickViewPanel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/IssueQuickViewController.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },

        // Story MOTIR-2664 · Subtask MOTIR-2671 — the design-result surface,
        // MEASURED on this branch before being pinned (263 tests across the 22
        // suites that touch these modules). Every file clears 90 on every axis;
        // the two tightest are `designEvidenceService.ts` and
        // `DesignResultPanel.tsx`, both at 90.9% branches, so the floor is real
        // rather than decorative — a couple of uncovered branches would breach
        // it. See the matching block in `include` above for why the two `app/**`
        // keys must not be written with a literal `(authed)`.
        'lib/services/designEvidenceService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/designEvidenceRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/designEvidenceMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/designEvidence/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/designEvidence/publishAuth.ts': { branches: 90, functions: 90, lines: 90 },
        // The shared CI-publisher gate MOTIR-2667 extracted, plus the acceptance
        // caller it was extracted FROM. Pinning both is the point: the extraction
        // is only safe for as long as the older caller keeps exercising it.
        'lib/publishAuth/ciPublishAuth.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/acceptanceEvidence/publishAuth.ts': { branches: 90, functions: 90, lines: 90 },
        // The allowlist is the file the one-directional `text/html` policy lives
        // in; a floor here is what keeps a future edit from widening the generic
        // list without a test noticing.
        'lib/blob/allowlist.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/work-items/**/design-evidence/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/work-items/**/design-evidence/upload-token/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/_components/DesignResultPanel.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2649 · Subtask MOTIR-2655 — MEASURED before being pinned,
        // on this branch, with `tests/integration/home/`: 100 branches / 100
        // functions / 100 lines on the service and the mapper, and 100 / 100 /
        // 92.3 on the cursor. Pinned at the repo's 90 floor rather than at the
        // measured number, so a later refactor has room without the gate being
        // loosened to make a build pass.
        'lib/home/cursor.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/home/tab.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/homeService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/homeMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-2653 — the page's own modules, MEASURED before being
        // pinned with `tests/components/home-list.test.tsx`.
        'app/**/home/_components/HomeList.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/home/_components/HomeTabs.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/home/_components/homeRows.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2982 · Subtask MOTIR-2992 — the agent-authored plan
        // surface, MEASURED on this branch before being pinned (the sequence
        // this block prescribes throughout), with `tests/mcp/author-plan.test.ts`,
        // `tests/components/PlanRow.test.tsx` and `tests/integration/plans/`:
        //
        //   lib/mcp/tools/authorPlan.ts        100 stmts · 97.05 branch · 100 fn · 100 lines
        //   app/**/plans/planRowView.ts        100 stmts · 95.65 branch · 100 fn · 100 lines
        //   app/**/plans/_components/PlanRow.tsx  100 stmts · 97.91 branch · 100 fn · 100 lines
        //
        // Pinned at the 90 floor rather than at the measured number, so a later
        // refactor has room without anyone loosening a gate to make a build pass.
        'lib/mcp/tools/authorPlan.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/plans/planRowView.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/plans/_components/PlanRow.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3232 · Subtask MOTIR-3242 — the Plans surface, refined.
        // MEASURED on this branch before pinning (the sequence this block
        // prescribes throughout), with `tests/planning/planShape`,
        // `tests/planning/planView`, `tests/components/PlanProposalList`,
        // `tests/components/PlanStatusTabs` and
        // `tests/components/PlansList-streaming`:
        //
        //   lib/planning/planShape.ts                    100 stmts · 95.2 branch · 100 fn · 100 lines
        //   lib/planning/planView.ts                     100 stmts ·  100 branch · 100 fn · 100 lines
        //   components/planning/PlanProposalList.tsx    97.4 stmts · 97.9 branch · 100 fn · 100 lines
        //   app/**/plans/_components/PlanStatusTabs.tsx  100 stmts ·  100 branch · 100 fn · 100 lines
        //   app/**/plans/_components/PlansList.tsx       100 stmts ·  100 branch · 100 fn · 100 lines
        //
        // Pinned at the 90 floor rather than at the measured number, so a later
        // refactor has room without anyone loosening a gate to make a build pass.
        'lib/planning/planShape.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/planView.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3243's extraction, measured the same way after the move:
        //   lib/planning/planStatusFilter.ts             100 stmts ·  100 branch · 100 fn · 100 lines
        'lib/planning/planStatusFilter.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/PlanProposalList.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/plans/_components/PlanStatusTabs.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/plans/_components/PlansList.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2999 · Subtask MOTIR-3008 — the `implemented` lifecycle
        // (see the `include` note above for why these five and not the three
        // pre-existing files the story also widened). MEASURED on this branch
        // first, with `tests/workflows/`, `tests/github/ciGreenPromotion`,
        // `tests/github/ciExpectedCheckSet`,
        // `tests/github/changeRequestSessionCloseOut`,
        // `tests/components/status-pill` and
        // `tests/integration/implemented-lifecycle`:
        //
        //   lib/services/ciPromotion.ts            97.5 stmts · 94.44 branch · 100 fn · 100 lines
        //   lib/services/changeRequestWorkItems.ts  100 · 100 · 100 · 100
        //   lib/workflows/defaultWorkflow.ts        100 · 100 · 100 · 100
        //   lib/workflows/statusColor.ts            100 · 100 · 100 · 100
        //   components/issues/StatusPill.tsx        100 · 100 · 100 · 100
        //
        // ⚠️ RE-MEASURED (MOTIR-4199): `ciPromotion.ts` is now
        // **97.7 stmts · 93.1 branch · 100 fn · 100 lines**, with
        // `tests/github/ciExpectedCheckSet` added to the list above. The
        // sentence that stood here said it had **one** uncovered branch; it has
        // two, and the count is stated rather than left to be re-derived:
        //
        //   * the rethrow of an error that is NOT one of the refusals a per-card
        //     skip tolerates — the original, unchanged, reachable only by
        //     injecting a fault into the shipped service, which would assert the
        //     mock rather than the code;
        //   * `if (!subject) continue` in the check-set reconcile — a pull
        //     request row that vanishes between being listed and being read,
        //     inside ONE transaction. Kept because the read is nullable and the
        //     compiler says so; not reachable from a test that does not fabricate
        //     the race.
        //
        // Pinned at the 90 floor rather than at the measured number, so a later
        // refactor has room without anyone loosening a gate to make a build pass
        // — which is what that headroom just paid for.
        'lib/services/ciPromotion.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/changeRequestWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workflows/defaultWorkflow.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workflows/statusColor.ts': { branches: 90, functions: 90, lines: 90 },
        'components/issues/StatusPill.tsx': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-3209 — supersede by RUN, not by name. MEASURED on this
        // branch first, with `tests/github/prCiState` and
        // `tests/github/cancelledSuiteSupersession`:
        //
        //   lib/github/checkSuites.ts   97.56 stmts · 92.85 branch · 100 fn · 100 lines
        //
        // The two uncovered branches are the non-numeric suite-id tier — a
        // deterministic fallback for an id shape neither host mints today, kept
        // so the ordering stays total rather than because anything reaches it.
        // Pinned at the 90 floor rather than at the measured number, so a later
        // refactor has room without anyone loosening a gate to make a build pass.
        'lib/github/checkSuites.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-4237 · Subtask MOTIR-4240 — the Help menu and the context
        // widened to give it a door, both MEASURED at 100 on all four axes
        // before being pinned (see the `include` block). Pinned at the 90 floor
        // rather than at the measured 100, so a later refactor has room without
        // anyone loosening a gate to make a build pass.
        //
        // ⚠️ `SidebarNav.tsx` is on ALL FOUR axes since MOTIR-4368. It arrived
        // here with THREE (MOTIR-4324, statements / functions / lines at 100
        // after the dead "Soon" badge was retired) and `branches` deliberately
        // absent: at 86.95 it was under the floor, and an axis is left OFF
        // rather than pinned below 90, which would be lowering a bar to make a
        // build pass. MOTIR-4368 closed the gap by writing the missing specs —
        // the drawer arm of both settings rails and the workspace-settings row's
        // five-clause `active:` predicate — and the axis is pinned at the same
        // 90 floor as its three siblings, on a measured 100. Its `include` entry
        // carries the before/after numbers.
        'app/**/_components/SidebarNav.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/HelpMenu.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/CommandPaletteProvider.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // MOTIR-4518 — the index container's motir-ai address preflight, on all
        // four axes, MEASURED at 100 on each before being pinned (the numbers
        // and the command are in its `include` entry above). Pinned at the 90
        // floor rather than at the measured 100, so a later refactor has room
        // without anyone loosening a gate to make a build pass.
        'lib/ai/containerAiAddress.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-4337 · MOTIR-4573. Measured first (see `include`), then
        //    pinned at the 90 floor rather than at the measured number, so a
        //    later refactor has room without anyone loosening a gate.
        'lib/repositories/platformOrganizationRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/platformBillingClassificationService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/platformMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/platform/auditActions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/platform/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ai/tenantOrg.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/tenants/[orgId]/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ⚠️ THIS ONE'S BRANCH FLOOR IS 85, NOT 90, and the reason is stated
        // rather than rounded away — the same shape as
        // `publicFollowDigestService` above. Its two uncovered arms are
        // DEFENSIVE and unreachable through the component's own surface:
        //
        //   · `submit()`'s `if (!trimmed) return` — the primary is `disabled`
        //     until a non-blank reason is typed, so a blank one cannot reach the
        //     handler. It is the belt to that button's braces, and the file's
        //     own header says why a client-side check is never the enforcement.
        //   · `onOpenChange`'s `next === true` arm — `open` is driven by this
        //     component's own Button, not by a `Dialog.Trigger`, so Radix never
        //     asks it to OPEN.
        //
        // The alternative was deleting the arms to buy the number, which trades
        // real safety for a metric. 85 is a RATCHET just under the measured
        // 85.71: it still fails on a regression, and it lowers nothing on the
        // three axes that hold at 95.83 / 100 / 100.
        'app/**/admin/tenants/[orgId]/_components/ClassificationBar.tsx': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'app/**/organization/usage/_components/searchUsage.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/organization/billing/_components/searchFigures.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(fileURLToPath(new URL('.', import.meta.url))),
      // `import 'server-only'` is a Next build-time marker with no plain-node
      // resolution; alias it to an empty stub so server-only modules (e.g.
      // lib/ai/motirAiClient) import cleanly under Vitest. The Next build still
      // enforces the real boundary.
      'server-only': resolve(
        fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
      ),
    },
  },
});
