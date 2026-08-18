import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { TEST_DB_WORKERS } from './tests/helpers/parallelDb';

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
    setupFiles: [
      './tests/helpers/perWorkerDb.ts',
      './tests/helpers/inngestSetup.ts',
      './tests/helpers/actEnvironment.ts',
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
        // The PROSE-vs-GRAPH advisory beside those rules (MOTIR-1969) — the pure
        // reference/severity extractor and the service that resolves + gates it.
        'lib/workItems/proseVsGraph.ts',
        'lib/services/proseGraphAdvisoryService.ts',
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
        'lib/mcp/tools/updateWorkItem.ts',
        'lib/mcp/tools/archiveWorkItem.ts',
        'lib/mcp/tools/deleteWorkItem.ts',
        // Story 7.9 · MOTIR-1825 — the AI plan-expansion tool + its outcome read
        // join the same gate (`tests/mcp/expand-item` drives both).
        'lib/mcp/tools/expandItem.ts',
        // Story 7.9 · MOTIR-1837 — the plan CONTENT read (the proposals behind
        // that outcome's count); `tests/mcp/get-plan` drives it.
        'lib/mcp/tools/getPlan.ts',
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
        // The PORT is included alongside the services on purpose: §4 calls the
        // swappable interface "the single most load-bearing output: it is what
        // makes this decision reversible", and an adapter half of which is
        // unexercised is an interface with one caller rather than a port.
        'lib/orchestrator/types.ts',
        'lib/orchestrator/index.ts',
        'lib/orchestrator/errors.ts',
        'lib/orchestrator/rates.ts',
        'lib/orchestrator/usage.ts',
        'lib/orchestrator/usageSink.ts',
        'lib/orchestrator/adapters/fake/index.ts',
        'lib/orchestrator/adapters/fly/index.ts',
        'lib/orchestrator/adapters/fly/flyMachines.ts',
        // Story MOTIR-1916 · MOTIR-2006 — THE BOOT PREFLIGHT, joining the same
        // surface for the same reason, stated at its sharpest by the fault it
        // exists to catch: MOTIR-1980's fleet shipped code-complete and unable to
        // pull a single image, and every predicate in the tree answered
        // "configured". The preflight is the one thing that would have said
        // otherwise, so an unexercised branch in it is the guarantee going
        // missing exactly where it went missing before.
        'lib/orchestrator/imagePull.ts',
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
        'lib/orchestrator/adapters/fly/indexImage.ts',
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
        // Story 7.24 · MOTIR-1812 → gated by MOTIR-1813. The "M" universal AI
        // callout: its action REGISTRY plus the two components that consume it.
        // The registry is the extension point MOTIR-1343 / MOTIR-1344 each land a
        // single entry in, so what the gate protects is not today's one row — it
        // is that the next row arrives with its branches exercised, in a surface
        // that is the front door to every AI capability Motir offers. The
        // launcher it derives its href from is already gated above.
        'lib/planning/aiCallout.ts',
        'components/planning/AiCalloutMenu.tsx',
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
        'app/api/v1/work-items/[key]/dispatch-prompt/route.ts',
        'app/api/v1/work-items/[key]/integration/route.ts',
        'app/api/v1/work-items/[key]/expansions/route.ts',
        'app/api/v1/work-items/[key]/activity/route.ts',
        'app/api/v1/sessions/complete/route.ts',
        'app/api/v1/plans/[planId]/route.ts',
        'app/api/v1/plans/[planId]/status/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/turns/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/submissions/route.ts',
        // Story 11.4 · Subtask 11.4.7 — the published reference + both doors.
        'lib/apiDocs/reference.ts',
        // Story 11.4 · Subtask 11.4.8 — the guide + the published policy.
        'lib/apiDocs/guide.ts',
        // Story 11.4 · Subtask 11.4.9 (MOTIR-2190) — the story gate. The docs
        // SURFACE joins the map, not only the modules behind it: this is the
        // page a third party reads to decide whether Motir is integrable, and
        // its branches are the ones that decide what they see when something is
        // wrong — a spec that would not build, a footer read that failed, a
        // filter that matches nothing. Each is a way the published reference can
        // be silently useless while every module beneath it is green.
        'app/**/docs/layout.tsx',
        'app/**/docs/api/page.tsx',
        'app/**/docs/api/getting-started/page.tsx',
        'app/**/docs/api/stability/page.tsx',
        'app/**/docs/_components/CatalogueNav.tsx',
        'app/**/docs/_components/CodeBlock.tsx',
        'app/**/docs/_components/DocBlocks.tsx',
        'app/**/docs/_components/MethodPill.tsx',
        'app/**/docs/_components/OperationSection.tsx',
        'app/**/docs/sandbox/page.tsx',
        'lib/apiDocs/sandbox.ts',
        // Story MOTIR-2315 · Subtask MOTIR-2524 — the `/docs` INDEX and the
        // shared surface list behind it. The index is the area's front door, so
        // its branches decide what a first-time reader sees; `surfaces.ts` is
        // read by BOTH renderers, so a defect there is wrong in two places at
        // once. `pageMetadata.ts` is what stops a page inheriting another
        // page's title — the defect MOTIR-2526 fixed, now under the gate.
        'app/**/docs/page.tsx',
        'lib/apiDocs/surfaces.ts',
        'lib/apiDocs/pageMetadata.ts',
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
        // Story MOTIR-2282 · Subtask MOTIR-2264 — every file this story added,
        // named explicitly and MEASURED before being pinned (all six are at 100%
        // lines / branches / functions on this branch). The glob form matters for
        // the same reason as in `include` above: a literal `app/(authed)/…` key
        // matches no reported file, so the threshold would pass vacuously.
        // MOTIR-2527 — the membership reader, measured at 100/100/100 on this
        // branch before being pinned (see the `include` note above).
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
        'app/api/v1/work-items/[key]/dispatch-prompt/route.ts': {
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
        // Story 11.4 · Subtask 11.4.5 — the remaining operation declarations.
        'lib/api/v1/identity/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/planning/operations.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.7 — the published reference + both doors.
        'lib/apiDocs/reference.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.8 — the guide + the published policy.
        'lib/apiDocs/guide.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.9 (MOTIR-2190) — the docs surface.
        'app/**/docs/layout.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/docs/api/page.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/docs/api/getting-started/page.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/docs/api/stability/page.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2315 · Subtask MOTIR-2524 — the index and its shared list.
        'app/**/docs/page.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/apiDocs/surfaces.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/apiDocs/pageMetadata.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/docs/_components/CatalogueNav.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/docs/_components/CodeBlock.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/docs/_components/DocBlocks.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/docs/_components/MethodPill.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/docs/sandbox/page.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/apiDocs/sandbox.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/docs/_components/OperationSection.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
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
        'lib/orchestrator/types.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/orchestrator/index.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/orchestrator/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/orchestrator/rates.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/orchestrator/usage.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/orchestrator/usageSink.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/orchestrator/adapters/fake/index.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/orchestrator/adapters/fly/index.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/orchestrator/adapters/fly/flyMachines.ts': { branches: 90, functions: 90, lines: 90 },
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
        'lib/orchestrator/adapters/fly/indexImage.ts': { branches: 90, functions: 90, lines: 90 },
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
        // Story MOTIR-2694 · Subtask MOTIR-2698 — the keys-not-prose enforcement
        // point (see the `include` note above; `aiBoundaryService.ts` is
        // deliberately NOT here, and that note says why).
        'lib/mappers/aiBoundaryMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // The prose-vs-graph advisory (MOTIR-1969) — an ADDITION beside the
        // finishability rules, gated on its own so a regression in it can't hide
        // inside workItemsService's blended number.
        'lib/workItems/proseVsGraph.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/proseGraphAdvisoryService.ts': { branches: 90, functions: 90, lines: 90 },
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
        'lib/mcp/tools/searchWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/listSprints.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1879 — the project-enumeration read (tests/mcp/list-projects.test.ts
        // walks both the populated and empty-list arms plus the thrown-error path).
        'lib/mcp/tools/listProjects.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/validateSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/createSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/updateSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/deleteSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/moveToSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/moveToBacklog.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/startSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/completeSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/markIntegrated.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/linkWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/updateWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/archiveWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/deleteWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/expandItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/dependencyEdges.ts': { branches: 90, functions: 90, lines: 90 },
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
        // Story 7.24 · MOTIR-1812 → gated by MOTIR-1813 (see the `include` note).
        // Measured over the merged surface, all three files sit at 100/100/100
        // from the shell's own units, so this pins what MOTIR-1812 already earned
        // rather than asking for catch-up tests — the point of the gate is that
        // the NEXT action entry cannot quietly ship an unexercised row.
        'lib/planning/aiCallout.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/AiCalloutMenu.tsx': { branches: 90, functions: 90, lines: 90 },
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
