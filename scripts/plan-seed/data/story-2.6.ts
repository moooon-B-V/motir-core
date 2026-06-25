import type { SeedStory } from '../types';

/**
 * Story 2.6 — Epic 2 test consolidation, coverage hardening & acceptance journeys.
 *
 * The CLOSING story of Epic 2 (Issue tracking core). It is the epic-level
 * analogue of Subtask 1.4.7 (the Story-1.4 work-item-model test closer): its
 * job is to AUDIT the coverage that Stories 2.1–2.5 already shipped, FILL the
 * genuine gaps no single feature story owned, EXTEND coverage gating to the
 * Epic-2 modules that aren't gated yet, and record a coverage matrix — NOT to
 * re-duplicate inherited assertions.
 *
 * Why the stub's naive scope is wrong (decision-ladder rung 2 — the
 * already-shipped code outranks the card). The stub read: "Vitest over the
 * service/repository layer: CRUD, illegal-transition rejection, type-parent
 * constraint violations, key uniqueness. Playwright over the create → detail →
 * status-change flow." Almost all of that ALREADY EXISTS, because every Epic-2
 * feature story shipped its own scoped tests (the canonical depth-13 principle):
 *   - kind-parent matrix, ALL 30 cells, service-driven →
 *     tests/integration/work-items/kind-parent-matrix.test.ts (2.1.2 / 1.4.7)
 *   - depth limit (4-deep + 5th rejected) + cycle (2-deep + 3-hop) →
 *     tests/integration/work-items/repository.test.ts (1.4.2 / 1.4.7)
 *   - key uniqueness + 20-wide concurrent gap-free allocation →
 *     tests/integration/work-items/service.test.ts + tests/project-counter.test.ts
 *   - transition validation (legal / illegal / unknown / no-op / open-mode /
 *     atomicity / tenant-gate) → tests/workflows/transition-validation.test.ts (2.2.4)
 *   - workflow CRUD / management / delete-reassign / restore-defaults / readiness →
 *     tests/workflows/{management,delete-reassign,restore-defaults,readiness}.test.ts
 *   - CRUD + edge cases + moves + links + revisions → service.test.ts +
 *     service-edge-cases.test.ts + revisions.test.ts
 *   - RLS (work-item + workflow + project + workspace) → tests/work-item-rls.test.ts,
 *     tests/workflows/rls.test.ts, tests/project-rls.test.ts, tests/workspace-rls.test.ts
 *   - E2E create→edit→status, detail, workflow transitions, workflow settings,
 *     delete-reassign → tests/e2e/{issue-create-edit-flow,issue-detail-flow,
 *     workflow-flow,workflow-settings,workflow-delete-reassign}.spec.ts
 * Re-writing those would be the duplication the no-shortcuts / completeness rule
 * forbids in the other direction. So 2.6 does what 1.4.7 did one Story up: audit,
 * fill the REAL gaps, gate, and document.
 *
 * The real remaining gaps this Story closes (each verified absent above):
 *   1. No EPIC-LEVEL coverage matrix (1.4.7 wrote one for Story 1.4's model only).
 *   2. No GRAPH-COMPLETE default-workflow conformance test — transition-validation
 *      only SAMPLES a few edges; a constant-derived sweep of all 15 edges + every
 *      non-edge is missing, so a future edit to defaultWorkflow.ts goes uncaught.
 *   3. No SINGLE cross-story lifecycle scenario threading the whole epic
 *      (create tree → assign → multi-hop status walk → archive → list/tree/readiness).
 *   4. Coverage GATING does not extend to Epic-2's workflow modules:
 *      vitest.config.ts `coverage.include` is ONLY the four Story-1.4 work-item
 *      files (from 1.4.7); workflowsService / workflowsRepository (Story 2.2) are
 *      ungated, and workItemsService GREW across 2.3–2.5 (detail / tree / list)
 *      after the 1.4.7 numbers were taken.
 *   5. No consolidated E2E ACCEPTANCE JOURNEY proving the type-parent rule + the
 *      full status lifecycle + list/tree reflection as one user-visible flow
 *      (the existing e2e specs are per-feature smoke tests).
 *
 * No design subtask: this Story builds NO UI — the E2E subtask (2.6.5) drives the
 * UI Stories 2.3–2.5 already shipped — so the design gate does not fire (no
 * UI-touching code, by design, not omission). No manual/human subtask: the
 * real-Postgres test harness (tests/helpers/db.ts + the local PG at :5433) and
 * the CI `test` + `e2e` jobs already exist (Story 1.0 / 1.4.7), so there is no
 * SaaS / secret / dashboard prerequisite to provision.
 *
 * Expanded from its stubs.ts entry per `motir plan 2.6`. Matches the canonical
 * depth + string-literal style of the Epic-2 modules (2.2 / 2.5) and the 1.4.7
 * coverage-matrix convention.
 */
export const story_2_6: SeedStory = {
  id: '2.6',
  title: 'Tests — Epic 2 consolidation, coverage hardening & acceptance journeys',
  status: 'done',
  descriptionMd:
    'The closing story of Epic 2 (Issue tracking core): the epic-level test **closer**, modeled on ' +
    'Subtask 1.4.7 (the Story-1.4 work-item-model closer). Its job is to **audit** the coverage ' +
    'Stories 2.1–2.5 already shipped, **fill** the genuine gaps no single feature story owned, ' +
    '**extend** coverage gating to the Epic-2 modules that are not gated yet, and **record** an ' +
    'epic-level coverage matrix — NOT to re-duplicate the per-story tests that already ship with ' +
    'each feature.\n\n' +
    '**Why this is an audit-and-fill story, not a write-the-tests story (decision-ladder rung 2 — ' +
    'the already-shipped code outranks the card).** The stub described Vitest over CRUD / ' +
    'illegal-transition / type-parent / key-uniqueness plus a Playwright create→detail→status flow. ' +
    'Almost all of that already exists, because each Epic-2 feature story shipped its own scoped ' +
    'tests (the design-before-code, tests-with-the-feature canonical depth): the full 30-cell ' +
    'kind-parent matrix (`kind-parent-matrix.test.ts`), depth + cycle triggers ' +
    '(`repository.test.ts`), 20-wide gap-free concurrent key allocation (`service.test.ts` + ' +
    '`project-counter.test.ts`), transition validation incl. illegal / unknown / no-op / open-mode ' +
    '/ atomicity (`transition-validation.test.ts`), workflow management / delete-reassign / ' +
    'restore-defaults / readiness (`tests/workflows/*`), CRUD + edges + moves + links + revisions, ' +
    'RLS across work-item / workflow / project / workspace, and five E2E specs. Re-writing those ' +
    'would be duplication. So 2.6 does at the EPIC scale exactly what 1.4.7 did at the Story scale.\n\n' +
    '**The real gaps this Story closes** (each verified absent in the current tree): (1) there is no ' +
    'epic-level coverage matrix — 1.4.7 wrote one only for Story 1.4’s model; (2) the ' +
    'default-workflow transition tests only SAMPLE edges, so there is no graph-complete conformance ' +
    'guard over all 15 default transitions + every non-edge; (3) no single cross-story scenario ' +
    'threads the whole epic lifecycle (create tree → assign → multi-hop status walk → archive → ' +
    'list/tree/readiness) end to end; (4) coverage GATING (`vitest.config.ts` `coverage.include` + ' +
    'per-file ≥90% thresholds) covers ONLY the four Story-1.4 work-item files from 1.4.7 — ' +
    '`workflowsService` / `workflowsRepository` are ungated and `workItemsService` grew across ' +
    '2.3–2.5 after the 1.4.7 numbers were taken; (5) there is no consolidated E2E acceptance ' +
    'journey proving the type-parent rule + the full status lifecycle + list/tree reflection as one ' +
    'user-visible flow.\n\n' +
    '**No design subtask, no manual subtask — by design, not omission.** This Story builds no UI ' +
    '(the E2E subtask drives the UI Stories 2.3–2.5 already shipped), so the design gate does not ' +
    'fire; and the real-Postgres test harness (`tests/helpers/db.ts` + the local PG, finding/Story ' +
    '1.0 + 1.4.7) and the CI `test` + `e2e` jobs already exist, so there is no SaaS / secret / ' +
    'dashboard prerequisite to provision. All five subtasks are `type: test`, `executor: ' +
    'coding_agent`. Tests use real Postgres (never mocks; the only allowed `vi.mock` is ' +
    '`getSession()`), per `motir-core/CLAUDE.md`.',
  verificationRecipeMd:
    '- Pull the Story branch(es), `pnpm install && pnpm prisma generate && pnpm prisma migrate dev` against a fresh local DB (PG at :5433).\n' +
    '- **Coverage matrix exists:** open `tests/EPIC2_COVERAGE.md` — every scope bullet from the 2.6 card (issue CRUD, type-parent rules, workflow transitions, key uniqueness, issue list/tree reads, assignees, RLS) maps to a covering test (file → `describe`), tagged inherited / filled / added, mirroring `tests/integration/work-items/TEST_COVERAGE.md` (1.4.7).\n' +
    '- `pnpm test` — green. The graph-conformance suite (`tests/workflows/transition-conformance.test.ts`) and the full-lifecycle scenario (`tests/integration/work-items/epic2-lifecycle.test.ts`) both pass against real Postgres.\n' +
    '- **Graph conformance is constant-derived:** edit `lib/workflows/defaultWorkflow.ts` to drop one transition edge locally → the conformance suite FAILS (proving it sweeps the real edge set, not a hardcoded copy). Revert.\n' +
    '- `pnpm test:coverage` — green, with the per-file ≥90% (branches/functions/lines) thresholds now ALSO enforced on `lib/services/workflowsService.ts` + `lib/repositories/workflowsRepository.ts`, and still passing on the four Story-1.4 work-item modules after Epic-2 growth. The coverage-numbers table in `tests/EPIC2_COVERAGE.md` matches the latest run.\n' +
    '- `pnpm test:e2e --grep epic2-acceptance` — the consolidated acceptance journey drives the real shell: create an issue via the modal (the parent picker offers only legal parents for the chosen kind), open its detail page, walk it through a multi-step status lifecycle via the status picker (illegal target unavailable), and see it reflected in both the issue List and the Tree.\n' +
    '- **CI proof:** the GitHub `test` job runs `pnpm test:coverage` (so the new thresholds gate every PR) and the `e2e` job runs Playwright (the acceptance journey runs on a `subtask/*` branch — E2E is NOT skipped, unlike `seed/*` / `design/*`).',
  items: [
    {
      id: '2.6.1',
      title: 'Epic-2 coverage audit + `tests/EPIC2_COVERAGE.md` matrix',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['2.1', '2.2', '2.3', '2.4', '2.5'],
      descriptionMd:
        'Audit the test coverage Stories 2.1–2.5 shipped and record it as an **epic-level coverage ' +
        'matrix** at `tests/EPIC2_COVERAGE.md`, mirroring the 1.4.7 convention ' +
        '(`tests/integration/work-items/TEST_COVERAGE.md`). This subtask is the audit deliverable: ' +
        'its output is the matrix + an explicit gap list that 2.6.2 / 2.6.3 / 2.6.4 / 2.6.5 consume, ' +
        'so the fill subtasks add net-new coverage instead of duplicating inherited assertions.\n\n' +
        'For every invariant in the 2.6 card scope — **issue CRUD** (create / update / assign / ' +
        'archive / move), **type-parent rules** (the kind-parent matrix + depth + cycle), **workflow ' +
        'transitions** (legal / illegal / unknown / no-op / open-mode / atomicity), **key ' +
        'uniqueness** (per-project sequence + concurrent allocation), **issue list & tree reads** ' +
        '(filter / sort / pagination / lazy-load), **assignees** (membership gates), and **RLS / ' +
        'tenancy** — name the covering test as `file → describe`, and tag it `inherited` (shipped by ' +
        'a feature story, kept as-is) / `filled` (was partial, 2.6 adds the missing case) / `added` ' +
        '(net-new in 2.6). Run `pnpm test:coverage` to capture the CURRENT baseline numbers for the ' +
        'work-item modules and (newly) the workflow modules, and record them in the doc’s numbers ' +
        'table. The doc MUST end with a short "Gaps 2.6 fills" section enumerating exactly the five ' +
        'gaps the Story description lists, each pointing at the subtask that closes it.\n\n' +
        'This subtask writes NO test code — it is documentation + a coverage run. Depends on the ' +
        'whole Epic-2 feature surface being done (Stories 2.1–2.5), since it audits their tests.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `tests/EPIC2_COVERAGE.md` exists, structured like `TEST_COVERAGE.md`: a header explaining ' +
        'audit-not-duplicate, a files-referenced legend, the invariant→test matrix with ' +
        'inherited/filled/added tags, and a coverage-numbers table.\n' +
        '- Every scope bullet above appears as at least one matrix row citing a REAL existing test ' +
        'file + `describe` (verified to exist — no invented paths).\n' +
        '- A closing "Gaps 2.6 fills" section enumerates the five gaps, each mapped to its closing ' +
        'subtask (2.6.2 graph conformance, 2.6.3 lifecycle, 2.6.4 gating, 2.6.5 E2E; this doc itself ' +
        'closes the "no epic matrix" gap).\n' +
        '- `pnpm test:coverage` runs clean and its reported numbers for `workItemsService` + the ' +
        'three repos AND `workflowsService` / `workflowsRepository` are transcribed into the table.\n' +
        '- No app code or test code changes in this subtask (doc-only + the coverage run).\n\n' +
        '## Context refs\n\n' +
        '- `tests/integration/work-items/TEST_COVERAGE.md` — the 1.4.7 matrix this mirrors\n' +
        '- `tests/integration/work-items/*.test.ts`, `tests/workflows/*.test.ts`, `tests/issues/*.test.ts`, `tests/work-item-rls.test.ts`, `tests/project-counter.test.ts`, `tests/e2e/{issue-create-edit-flow,issue-detail-flow,workflow-flow,workflow-settings,workflow-delete-reassign}.spec.ts` — the surface being audited\n' +
        '- `vitest.config.ts` (`coverage` block) — the existing gate 2.6.4 extends\n' +
        '- `motir-core/CLAUDE.md` — real-Postgres test rule (no mocks beyond `getSession`)',
    },
    {
      id: '2.6.2',
      title: 'Default-workflow graph-conformance suite (vitest, constant-derived)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['2.6.1'],
      descriptionMd:
        'Add `tests/workflows/transition-conformance.test.ts` — a **graph-complete** conformance ' +
        'guard over the default workflow, consolidating what `transition-validation.test.ts` only ' +
        'SAMPLES. The suite derives the edge set from the `defaultWorkflow.ts` constant (NOT a ' +
        'hardcoded copy), so any future edit that adds/drops a status or transition is caught.\n\n' +
        'Drive everything through the shipped path — `workItemsService.updateStatus` validated by ' +
        '`workflowsService.canTransition`, against a `createTestProject` project (which auto-seeds the ' +
        'six default statuses + fifteen transitions). Assertions:\n\n' +
        '- **Restricted mode (the default):** for EVERY one of the 15 default transition edges, a ' +
        'work item sitting in the `from` status transitions to the `to` status successfully (and ' +
        'records exactly one `updated` revision). For EVERY non-edge in the 6×6 grid that is neither ' +
        'a default edge nor a self-loop, `updateStatus` is rejected with `IllegalTransitionError`. ' +
        'Both loops are generated from the constant — the test body enumerates statuses × statuses ' +
        'and partitions by membership in the default edge set.\n' +
        '- **No-op self-transitions** (status → same status) succeed WITHOUT writing a revision, for ' +
        'all six statuses.\n' +
        '- **Open mode:** after flipping the project policy to `open` (via `workflowsService` / the ' +
        '2.2 management path), the full cartesian product of (real status → real status) is accepted ' +
        '— proving open mode bypasses the edge set — while an unknown target key still raises ' +
        '`UnknownStatusError`.\n' +
        '- **Terminal-set conformance:** the statuses with `category: done` exactly match ' +
        '`{ done, cancelled }` (the readiness predicate’s terminal set, finding #21), derived from ' +
        'the seeded statuses, not hardcoded.\n\n' +
        'Keep it complementary to `transition-validation.test.ts` (which keeps its hand-picked ' +
        'cases + the atomicity/tenant-gate cases) — this file owns the exhaustive graph sweep. Do not ' +
        'duplicate the atomicity / cross-workspace cases.\n\n' +
        '## Acceptance criteria\n\n' +
        '- New file `tests/workflows/transition-conformance.test.ts`; passes under `pnpm test` on real Postgres.\n' +
        '- The legal-edge and illegal-non-edge sets are computed FROM the default workflow constant; locally deleting one edge from `defaultWorkflow.ts` makes the suite fail (manually verified, noted in the PR).\n' +
        '- All 15 default edges are each exercised through `updateStatus`; every non-edge non-self pair is asserted to raise `IllegalTransitionError`.\n' +
        '- Self-transitions write no revision; open-mode accepts the full real×real product; unknown key → `UnknownStatusError`.\n' +
        '- Terminal `category: done` set asserted to equal `{ done, cancelled }`.\n' +
        '- Each test `describe` names the invariant it protects (per the project test convention).\n\n' +
        '## Context refs\n\n' +
        '- `lib/workflows/defaultWorkflow.ts` — the 6 statuses + 15 transitions the suite derives from\n' +
        '- `lib/services/workflowsService.ts` (`canTransition`, policy-mode toggle), `lib/services/workItemsService.ts` (`updateStatus`)\n' +
        '- `lib/workItems/errors.ts` (`IllegalTransitionError`, `UnknownStatusError`)\n' +
        '- `tests/workflows/transition-validation.test.ts` (2.2.4) + `tests/workflows/default-workflow.test.ts` — the sampled coverage this completes\n' +
        '- `tests/fixtures/projectFixtures.ts` (`createTestProject`), `tests/helpers/db.ts`',
    },
    {
      id: '2.6.3',
      title: 'Full Epic-2 lifecycle integration scenario (vitest)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['2.6.1'],
      descriptionMd:
        'Add `tests/integration/work-items/epic2-lifecycle.test.ts` — a single cross-story scenario ' +
        'that threads the whole Epic-2 lifecycle end to end, the integration journey no individual ' +
        '2.x test owns (each owns a slice). All through `workItemsService` against real Postgres.\n\n' +
        'The scenario:\n\n' +
        '1. **Build a full tree** honoring the kind-parent matrix: create an `epic`, a `story` under ' +
        'it, a `task` under the story, a `bug` under the task, and a `subtask` under the bug ' +
        '(exercising the legal parent chain to the 4-level depth cap; assert each lands with the ' +
        'right `parentId`, a gap-free per-project `key`, and a derived `PROD-<n>` identifier).\n' +
        '2. **Assign** items to a workspace member (and confirm a non-member assignee is rejected ' +
        'with `AssigneeNotInWorkspaceError` — the assignee gate in a lifecycle context).\n' +
        '3. **Walk a representative item through a multi-hop status lifecycle** under restricted ' +
        'policy: `todo → in_progress → in_review → done`, then a block/unblock detour ' +
        '(`in_progress ↔ blocked`), then a reopen (`done → in_progress`). Assert each hop validates ' +
        'and records an `updated` revision, and that an illegal jump mid-walk (e.g. `todo → done`) ' +
        'raises `IllegalTransitionError` without mutating status.\n' +
        '4. **Archive** a leaf and assert the soft-delete leaves children intact (Linear shape — no ' +
        'cascade) and that the archived item drops out of the default list/tree reads.\n' +
        '5. **Assert the read surfaces reflect the final state**: `getProjectTree` returns the ' +
        'nested forest with correct depths and the archived item excluded; `getProjectIssuesList` ' +
        '(paginated/filtered) returns the live items with the right statuses + assignees; `isReady` ' +
        'is correct for an item with/without open blockers.\n\n' +
        'This is an INTEGRATION scenario, not unit re-coverage — it asserts the pieces compose. ' +
        'Reuse the shared fixtures (do not re-inline helpers).\n\n' +
        '## Acceptance criteria\n\n' +
        '- New file `tests/integration/work-items/epic2-lifecycle.test.ts`; passes under `pnpm test` on real Postgres.\n' +
        '- The full epic→story→task→bug→subtask chain is created through the service and asserted (parentage, gap-free keys, derived identifiers, depth).\n' +
        '- The multi-hop status walk covers forward + block/unblock + reopen, each writing a revision; a mid-walk illegal transition is rejected without mutation.\n' +
        '- Assignee gate exercised (member assigns; non-member rejected with `AssigneeNotInWorkspaceError`).\n' +
        '- Archive leaves children intact and the item is excluded from `getProjectTree` + `getProjectIssuesList` defaults.\n' +
        '- Final `getProjectTree`, `getProjectIssuesList`, and `isReady` reads assert the end state.\n' +
        '- Uses `tests/fixtures/*` (no re-inlined setup); each `describe`/`it` names the behavior.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workItemsService.ts` — `createWorkItem`, `assignWorkItem`, `updateStatus`, `archiveWorkItem`, `getProjectTree`, `getProjectIssuesList`, `isReady`\n' +
        '- `lib/workItems/errors.ts` — `AssigneeNotInWorkspaceError`, `IllegalTransitionError`, `IllegalParentTypeError`\n' +
        '- `tests/integration/work-items/{service,project-tree,issue-list-view}.test.ts` — the sliced coverage this composes (do not duplicate)\n' +
        '- `tests/fixtures/{workItemFixtures,projectFixtures,workspaceFixtures,userFixtures}.ts`, `tests/helpers/db.ts`\n' +
        '- `prisma/sql/work_item_triggers.sql` — kind-parent / depth rules the create chain rides',
    },
    {
      id: '2.6.4',
      title: 'Extend coverage gating to the Epic-2 workflow modules + re-verify thresholds',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['2.6.2', '2.6.3'],
      descriptionMd:
        'Close the coverage-gating gap (gap #4). The `coverage.include` in `vitest.config.ts` ' +
        'currently lists ONLY the four Story-1.4 work-item-model files (added by 1.4.7); Epic-2’s ' +
        'workflow layer is ungated, and `workItemsService` grew across Stories 2.3–2.5 (detail / ' +
        'tree / list / pagination) after the 1.4.7 numbers were measured. This subtask brings the ' +
        'Epic-2 modules under the same per-file ≥90% gate and re-verifies the existing ones still ' +
        'hold.\n\n' +
        'Steps:\n\n' +
        '- Add `lib/services/workflowsService.ts` and `lib/repositories/workflowsRepository.ts` to ' +
        '`coverage.include`, and add per-file `thresholds` entries for each at ' +
        '`{ branches: 90, functions: 90, lines: 90 }` — matching the existing gate shape (each file ' +
        'gates independently so a regression in one fails the run, not a blended average).\n' +
        '- Run `pnpm test:coverage` and FILL any shortfall the new conformance/lifecycle suites ' +
        'leave on those two modules with targeted, non-duplicative tests (prefer extending the ' +
        'existing `tests/workflows/*` files; mark genuinely-unreachable defensive branches with an ' +
        'inline `/* istanbul ignore … -- <reason> */`, the same way 1.4.7 handled the SQLSTATE ' +
        'parser fallbacks — do not lower the threshold).\n' +
        '- Re-verify the four work-item modules still pass ≥90% after Epic-2 growth; if 2.3–2.5 added ' +
        'an under-covered branch to `workItemsService`, add the missing case (in the appropriate ' +
        'existing test file).\n' +
        '- Update the coverage-numbers table in `tests/EPIC2_COVERAGE.md` (2.6.1) with the final ' +
        'figures for all six gated modules.\n\n' +
        'CI already runs `pnpm test:coverage` in the `test` job (1.4.7), so the new thresholds gate ' +
        'every future PR automatically — no workflow-file change needed. Depends on 2.6.2 + 2.6.3 so ' +
        'their new tests count toward coverage before the gate tightens.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `vitest.config.ts` `coverage.include` includes the two workflow modules; `coverage.thresholds` has per-file ≥90% (branches/functions/lines) entries for both.\n' +
        '- `pnpm test:coverage` passes with all SIX modules (4 work-item + 2 workflow) at ≥90% on every metric.\n' +
        '- Any unreachable defensive branch excluded via an inline `istanbul ignore` with a stated reason — the threshold is NOT lowered.\n' +
        '- The four pre-existing work-item modules still meet the gate after Epic-2 growth (any newly-uncovered branch from 2.3–2.5 is filled).\n' +
        '- `tests/EPIC2_COVERAGE.md` numbers table updated to the final run.\n\n' +
        '## Context refs\n\n' +
        '- `vitest.config.ts` — the `coverage` block (provider v8, include, per-file thresholds) to extend\n' +
        '- `lib/services/workflowsService.ts`, `lib/repositories/workflowsRepository.ts` — the newly-gated modules\n' +
        '- `tests/workflows/*.test.ts` — where to add fill cases\n' +
        '- `tests/integration/work-items/TEST_COVERAGE.md` — the 1.4.7 precedent (istanbul-ignore convention + numbers table)\n' +
        '- `.github/workflows/ci.yml` — the `test` job already runs `test:coverage` (gates automatically)',
    },
    {
      id: '2.6.5',
      title:
        'E2E — Epic-2 acceptance journey (Playwright): create → detail → lifecycle → list/tree',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['2.6.1'],
      descriptionMd:
        'Add `tests/e2e/epic2-acceptance.spec.ts` — the card’s "Playwright over the create → detail ' +
        '→ status-change flow" as ONE consolidated, user-visible epic-acceptance journey through the ' +
        'real shell, where the existing e2e specs are per-feature smoke tests. It proves the ' +
        'type-parent rule + the full status lifecycle + list/tree reflection compose for a real ' +
        'user.\n\n' +
        'The journey (one signed-in session, against the seeded shell):\n\n' +
        '1. Open a project and **create an issue via the create modal** — pick a `kind`, then ' +
        'confirm the **parent picker offers only LEGAL parents for that kind** (e.g. a `subtask` ' +
        'requires a story/task/bug parent and is never offered an epic; the type-parent rule surfaced ' +
        'in the UI), select a legal parent, submit.\n' +
        '2. **Open its detail page** and confirm it rendered (identifier, title, kind, status, ' +
        'assignee, parent breadcrumb).\n' +
        '3. **Walk it through a multi-step status lifecycle via the status picker** ' +
        '(`todo → in_progress → in_review → done`), confirming at each step that **illegal targets ' +
        'are not offered / are blocked** under the restricted default policy (e.g. no direct ' +
        '`todo → done`).\n' +
        '4. **Verify reflection in both read surfaces**: the issue **List** view shows the item with ' +
        'its updated status, and the **Tree** view shows it nested under its parent — closing the ' +
        'loop on Stories 2.4 (tree) + 2.5 (list).\n\n' +
        'Reuse the existing e2e patterns and selector conventions; this file owns the cross-feature ' +
        'journey, the per-feature specs keep their focused smoke coverage (do not duplicate them). ' +
        'Heed the known E2E selector gotchas: a Combobox option’s accessible name is label + ' +
        'secondary text (match the substring, not an exact name), and the `/issues` empty state has ' +
        'an `h1 Issues` + an `h2 "No issues yet"` (use exact/level on heading selectors). Branch is ' +
        '`subtask/PROD-2.6.5-*` (a `subtask/*` branch → CI runs Playwright; E2E is NOT skipped, ' +
        'unlike `seed/*` / `design/*`).\n\n' +
        '## Acceptance criteria\n\n' +
        '- New file `tests/e2e/epic2-acceptance.spec.ts`, grep-taggable as `epic2-acceptance`; passes under `pnpm test:e2e`.\n' +
        '- The create step asserts the parent picker offers only legal parents for the chosen kind (an illegal parent is absent), exercising the type-parent rule through the UI.\n' +
        '- The status walk drives a multi-step lifecycle via the status picker and asserts an illegal direct transition is unavailable/blocked under restricted policy.\n' +
        '- After the walk, BOTH the List and the Tree views are asserted to reflect the item’s final status + parentage.\n' +
        '- Reuses existing fixtures/helpers + selector conventions; no duplication of the focused per-feature specs.\n' +
        '- Runs in the CI `e2e` job (subtask/* branch — Playwright not skipped).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/{issue-create-edit-flow,issue-detail-flow,workflow-flow}.spec.ts` — the per-feature specs this journey composes (patterns to reuse, not duplicate)\n' +
        '- `tests/e2e/work-items-isolation.spec.ts`, `playwright.config.ts`, the e2e auth/sign-in helper\n' +
        '- The issue create modal + detail page + List/Tree view components (Stories 2.3 / 2.4 / 2.5)\n' +
        '- Memory: prodect-e2e-selector-gotchas (Combobox option name = label + secondary; `/issues` empty-state headings)\n' +
        '- `motir-core/CLAUDE.md` — manual merge mode; real-stack E2E',
    },
  ],
};
