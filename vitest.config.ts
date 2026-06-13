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
      ],
      reporter: ['text', 'text-summary'],
      // Per-file thresholds keyed by glob: each of the six modules gates
      // independently, so a regression in any one fails the run (rather than a
      // blended average hiding a weak module).
      thresholds: {
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
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(fileURLToPath(new URL('.', import.meta.url))),
    },
  },
});
