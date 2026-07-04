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
    setupFiles: ['./tests/helpers/perWorkerDb.ts', './tests/helpers/inngestSetup.ts'],
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
    coverage: {
      provider: 'v8',
      include: [
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
        'lib/mcp/registry.ts',
        'lib/mcp/tools/getWorkItem.ts',
        'lib/mcp/tools/listReady.ts',
        'lib/mcp/tools/nextReady.ts',
        'lib/mcp/tools/createWorkItem.ts',
        'lib/mcp/tools/transitionStatus.ts',
        'lib/mcp/tools/addComment.ts',
        'lib/mcp/tools/searchWorkItems.ts',
        'lib/mcp/tools/whoami.ts',
        'lib/mcp/tools/listSprints.ts',
        'lib/mcp/tools/validateSprint.ts',
        // Work-item finishability — the tool, plus the shared loose/tight
        // predicate both validators use (Subtask 7.8.23).
        'lib/mcp/tools/validateWorkItem.ts',
        'lib/workItems/validity.ts',
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
        // Story 7.10 · Subtask 7.10.8 (MOTIR-896) — the GitHub integration's
        // webhook state machine + installation grant mirror + code-graph feed
        // dispatch + the planning-envelope repo-set producer join the gate.
        'lib/services/githubWebhookService.ts',
        'lib/services/githubInstallationService.ts',
        'lib/services/codeGraphIndexService.ts',
        'lib/github/indexEnqueue.ts',
        'lib/github/webhookSignature.ts',
        'lib/ai/codeContext.ts',
      ],
      reporter: ['text', 'text-summary'],
      // Per-file thresholds keyed by glob: each of the six modules gates
      // independently, so a regression in any one fails the run (rather than a
      // blended average hiding a weak module).
      thresholds: {
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
        // Story 7.7 · Subtask 7.7.12 — the MCP registry + every tool module.
        'lib/mcp/registry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/getWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/listReady.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/createWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/addComment.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/searchWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/listSprints.ts': { branches: 90, functions: 90, lines: 90 },
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
        'lib/ai/codeContext.ts': { branches: 90, functions: 90, lines: 90 },
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
