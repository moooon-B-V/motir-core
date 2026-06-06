import type { PlanStory } from '../types';

/**
 * Story 2.2 — Status workflows (per-project, customizable).
 * Faithful transcription of prodect_plan/story-2.2-status-workflows.html (frozen archive).
 */
export const story_2_2: PlanStory = {
  id: '2.2',
  title: 'Status workflows (per-project, customizable)',
  status: 'done',
  descriptionMd:
    'Ships the durable workflow primitive every later issue surface reads from: each project owns an ' +
    'ordered set of **statuses**, each status carries a **category** ' +
    '(`todo` / `in_progress` / `done`) — the Jira-style three-bucket ' +
    'taxonomy — and a per-project set of legal **transitions** between them. New projects ' +
    'auto-seed the default workflow (*To Do → In Progress → In Review → Done*). After this Story, ' +
    "every `work_item` row's `status` string is resolvable to a typed status row, " +
    "and Epic 3's boards (columns), Epic 6's reports (filters/groupings), and Story 1.4's " +
    '`isReady` predicate (finding #21 — "terminal" generalizes from hardcoded `\'done\'` ' +
    "to `category = 'done'`) all read this single source of truth.\n\n" +
    '**Prerequisites:** Story 1.3 ships the `project` table and the ' +
    '`projectsService.createProject` transaction that seeds per-project state (the key ' +
    'counter). Story 1.4 ships `work_item.status` as a `String` column with ' +
    "`'todo'` default; this Story does NOT change its type (kept as a string for portability) " +
    'but adds the typed-status integrity layer via service-layer validation + an RLS-scoped lookup ' +
    "table. Story 2.1 ships the `issuesService` that this Story's transition validation " +
    "hangs off. All work follows `prodect-core/CLAUDE.md`'s 4-layer architecture " +
    '(Route → Service → Repository → Prisma). Per finding #26, every new route in this Story carries ' +
    'an explicit `workspaceId` gate at the application layer — RLS is the backstop, not the ' +
    'sole gate, because the dev/CI superuser bypasses RLS.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install && pnpm prisma generate && pnpm prisma migrate dev` against a fresh local DB.\n' +
    '- `pnpm test` — vitest covers schema RLS, default seed, service read API, transition validation, the management writes (including atomic initial-status flip + delete protections), and the finding-#21 generalization.\n' +
    '- `pnpm test:e2e --grep workflow-flow` — the closing Playwright suite runs against the real stack.\n' +
    '- **Manual UX check:** create a workspace + project, visit `/settings/project/[key]/workflow`: verify all six default statuses (To Do / Blocked / In Progress / In Review / Done / Cancelled) and the fifteen transitions, rename one, add a custom status, add/remove a transition, flip policy mode, attempt a restricted-mode illegal status change on a real issue → typed-error toast.\n' +
    '- **Cross-project blocker check (finding #21 resolution):** create two projects; create an issue in A blocked by an issue in B; mark the blocker "Cancelled" in B (legal per the default seed — no admin customization needed); A\'s issue\'s readiness flips to ready — proving the readiness predicate honors both `done` AND `cancelled` terminal categories.\n' +
    "- **Block-as-status vs. block-as-link parity check:** on one issue, set `status: 'blocked'` (the status flag); on another, leave status `todo` but add a `work_item_link.is_blocked_by` edge to an open blocker. Both should show up in a \"what's blocked?\" filter / view (when those surfaces ship in Epic 2.5 / Epic 6); for this Story, just confirm both signals coexist without conflict — `isReady` returns false for the link-blocked one, and the status-blocked one is filterable by status.\n" +
    "- **RLS proof:** open a psql session as `prodect_app`, `SET app.workspace_id = '<workspace-A>'`, query `workflow_status` + `workflow_transition` — see only workspace A's rows.",
  items: [
    {
      id: '2.2.1',
      title: 'Schema — `workflow_status` + `workflow_transition` + RLS',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['1.3.1', '1.4.2'],
      descriptionMd:
        'Add the two workflow tables to `prisma/schema.prisma` and ship one Prisma ' +
        'migration that creates both plus their RLS policies, using the same workspace-scoped ' +
        '`app.workspace_id` GUC pattern Story 1.6.4 established for `job_run` ' +
        '(see finding #33). Both tables carry an explicit `workspaceId` column + ' +
        '`projectId` FK + the Story-1.2 RLS gate, so the typed-status data inherits ' +
        'tenant isolation by structure, not by joins.\n\n' +
        '**Tables and key constraints:**\n\n' +
        '- `workflow_status`: `(id, workspaceId, projectId, key, label, category, color, position, isInitial, createdAt, updatedAt)`. ' +
        '`category` is a Prisma enum `StatusCategory { todo, in_progress, done }` — the durable Jira-style three-bucket taxonomy. ' +
        "`key` is the machine-stable identifier `work_item.status` stores (e.g. `'todo'`, `'in_review'`); unique per project (`@@unique([projectId, key])`). " +
        "`position` is a `Decimal(20,10)` matching Story 1.4's column-shape rule (finding #18) — same fractional-indexing path the work-item ordering uses. " +
        '`isInitial` is a boolean; partial unique index `@@unique([projectId, isInitial]) where isInitial = true` enforces exactly one initial status per project.\n' +
        '- `workflow_transition`: `(id, workspaceId, projectId, fromStatusId, toStatusId, createdAt)`. ' +
        '`@@unique([projectId, fromStatusId, toStatusId])` prevents duplicate transitions. ' +
        'The "any → any" project-policy is NOT stored as N² rows; it\'s a project-level ' +
        '`workflow_policy_mode` column on `project` (added in this same ' +
        'migration) with values `restricted` / `open`. `open` ' +
        'means transitions are unconstrained (the explicit transition rows are ignored at ' +
        'validation time); `restricted` consults the transition rows. Default ' +
        '`restricted`. This is the durable shape — Jira and Linear both have an ' +
        '"anything goes" project mode and a "guarded transitions" mode; storing the policy as a ' +
        'project column rather than a flag inside `workflow_transition` keeps the ' +
        'shape O(transitions) in storage and O(1) to check the policy.\n\n' +
        '**RLS:** both tables enable RLS + `FORCE ROW LEVEL SECURITY` ' +
        "(so even the table owner is gated, per Story 1.4.5's pattern). The policy mirrors " +
        "`work_item`'s: `USING (workspace_id = current_setting('app.workspace_id')::uuid)` " +
        "+ the system-admin escape hatch `OR current_setting('app.system_admin', true) = 'true'` " +
        '(see finding #33). No `FOR SELECT/INSERT/UPDATE/DELETE` split — one policy per ' +
        'table covering all four, matching Story 1.6.4.\n\n' +
        "**What this does NOT do:** seed default rows (that's 2.2.2's job — done in " +
        'application code, not a SQL `INSERT` in the migration, so the seed runs under ' +
        'the prodect_app role and gets the workspace_id GUC set correctly). Also does not change ' +
        "`work_item.status`'s column type — it stays `String` for v1 " +
        'portability, with integrity enforced by the service layer (see 2.2.4).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `workflow_status` + `workflow_transition` + `project.workflow_policy_mode` added in one Prisma migration; `prisma migrate dev` applies cleanly against a fresh DB.\n' +
        '- RLS policies created and FORCED on both tables; the `app.workspace_id` + `app.system_admin` GUC pattern mirrors `job_run` (finding #33).\n' +
        '- Partial unique index enforces exactly-one-initial-status-per-project; attempting a second initial-status insert fails with a constraint violation.\n' +
        '- `@@unique([projectId, key])` enforces stable per-project status keys.\n' +
        "- An RLS proof test (mirroring `tests/jobs/rls.test.ts`) under `SET LOCAL ROLE prodect_app` demonstrates: workspace A's session sees only its own statuses; cross-workspace SELECT returns 0 rows; INSERT with a foreign `workspaceId` in the same row is rejected.\n" +
        '- No `SQL INSERT` in the migration for default rows (seeding is application-layer work in 2.2.2).\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — Story 1.3 `project`, Story 1.4 `work_item`\n' +
        "- Story 1.6.4's migration `add_job_run_dlq_and_rls` — the canonical RLS + `app.system_admin` escape-hatch shape\n" +
        "- Story 1.4.5's `FORCE ROW LEVEL SECURITY` migration on `work_item`\n" +
        '- `tests/jobs/rls.test.ts` — the role-switch RLS-proof harness this Subtask mirrors\n' +
        '- `prodect-core/CLAUDE.md` — 4-layer rule, repo-write contract\n' +
        '- Finding #18 — `Decimal(20,10)` position-column shape; finding #33 — GUC namespace',
    },
    {
      id: '2.2.2',
      title: 'Default-workflow seed wired into `createProject`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['2.2.1'],
      descriptionMd:
        'Add `lib/workflows/defaultWorkflow.ts` — a typed constant defining the ' +
        'v1 default per-project workflow: **six statuses** covering the full lifecycle ' +
        'including a non-terminal `blocked` state and a terminal `cancelled` ' +
        'state (the two most common admin-added statuses in real Jira/Linear installs, baked into ' +
        'the default so every project validates the multi-terminal-status + non-linear-graph paths ' +
        'from day one).\n\n' +
        '**The six statuses** (`key`, label, category, isInitial):\n\n' +
        '- `todo` · "To Do" · `todo` · **initial**\n' +
        '- `blocked` · "Blocked" · `todo` · — (non-terminal "can\'t proceed" state; complements 1.4.3\'s `work_item_link.is_blocked_by` relation — the link expresses a specific blocking issue, the status expresses "blocked, full stop" including external blockers)\n' +
        '- `in_progress` · "In Progress" · `in_progress` · —\n' +
        '- `in_review` · "In Review" · `in_progress` · —\n' +
        '- `done` · "Done" · `done` · —\n' +
        '- `cancelled` · "Cancelled" · `done` · — (terminal — "won\'t do / duplicate / out-of-scope"; covered by finding #21\'s readiness predicate via `category = \'done\'`)\n\n' +
        '**The transition graph** (12 transitions, restricted-mode default):\n\n' +
        '- **Forward main path:** `todo→in_progress`, `in_progress→in_review`, `in_review→done`\n' +
        '- **Block / unblock:** `todo→blocked`, `in_progress→blocked`, `blocked→todo`, `blocked→in_progress` (block from either active state; unblock returns to either)\n' +
        '- **Backward / rework:** `in_review→in_progress`, `in_progress→todo`\n' +
        '- **Reopen:** `done→in_progress`, `cancelled→todo` (cancellation is reversible; the most common ask after "won\'t do" turns out to be a real fix)\n' +
        "- **Cancellation:** `todo→cancelled`, `in_progress→cancelled`, `in_review→cancelled`, `blocked→cancelled` (any non-terminal state can cancel) — that's 4 more, bringing the total to **15 transitions**\n\n" +
        'Then extend `projectsService.createProject` to call ' +
        '`workflowsService.seedDefaultWorkflow(projectId, tx)` **inside the same ' +
        "transaction** as the project insert, so a project either has its workflow or doesn't " +
        'exist.\n\n' +
        '**Why a typed constant + service-layer seed, not a SQL migration `INSERT`:** ' +
        "the migration can't set `app.workspace_id` for an arbitrary project; the seed " +
        'must run under the request context where the GUC is already bound. The service-layer seed ' +
        'also keeps the default editable post-creation (users can rename "In Review", reorder, ' +
        "delete the back-transition, etc.) without forcing a migration. Same pattern as Story 1.2's " +
        'owner-membership row written by `insertWorkspaceWithOwner` — application code ' +
        'writes the relational shape; the migration only creates the empty tables.\n\n' +
        "**Workflow policy:** default seed sets `project.workflow_policy_mode = 'restricted'` " +
        'and writes the six transition rows above. A project starts guarded; an admin can flip to ' +
        "`'open'` via 2.2.5's settings UI without deleting the transition rows (they're " +
        "kept so a flip back to `'restricted'` restores the curated graph).\n\n" +
        '## Acceptance criteria\n\n' +
        '- `lib/workflows/defaultWorkflow.ts` exports the typed default (6 statuses, 15 transitions, the initial-status flag on `todo`, position values via the fractional-indexing helpers from Story 1.4).\n' +
        '- `workflowsService.seedDefaultWorkflow(projectId, tx)` inserts the six `workflow_status` rows + fifteen `workflow_transition` rows inside the supplied transaction client; never opens its own transaction.\n' +
        '- `projectsService.createProject` calls `seedDefaultWorkflow` after the project insert, in the same `$transaction`; rolling back the project insert also rolls back the workflow seed.\n' +
        '- Vitest (real Postgres) proving: a fresh `createProject` ends with 6 statuses + 15 transitions; the `todo` row has `isInitial = true`; any other call to set a second initial-status fails with the partial-unique violation from 2.2.1.\n' +
        '- An end-to-end "create project → list workflow → see 6 statuses in display order" service test, verified through the workspace context.\n' +
        "- `getTerminalStatusKeys` on a default-seeded project returns `new Set(['done', 'cancelled'])` — the two terminal statuses out of the box (proves the multi-terminal path is exercised on day one, not only after admin customization).\n" +
        '- No schema change in this Subtask (2.2.1 owns the schema). Existing project rows from older tests/migrations get a separate one-off `backfillDefaultWorkflow(projectId)` service method (called only by an admin/CLI path in this Story; production has no projects pre-existing this Story yet).\n\n' +
        '## Context refs\n\n' +
        "- `lib/services/projectsService.ts` + `lib/repositories/projectsRepository.ts` — Story 1.3's createProject\n" +
        '- `lib/workspaces/insertWorkspaceWithOwner.ts` — the existing service-seed pattern this mirrors\n' +
        "- Story 1.4's fractional-indexing helpers (`lib/workItems/positioning.ts` or equivalent) — for `workflow_status.position`\n" +
        '- `prodect-core/CLAUDE.md` — transaction-client passing rule (write repos require `tx`)\n' +
        "- Finding #21 — terminal status generalizes from `'done'` to `category = 'done'`",
    },
    {
      id: '2.2.3',
      title: '`workflowsService` read API + repository',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.2.1'],
      descriptionMd:
        'Add `lib/services/workflowsService.ts` + `lib/repositories/workflowsRepository.ts` ' +
        'shipping the read surface every later consumer needs. The service is the only doorway — ' +
        'repositories are single-Prisma-op leaves per CLAUDE.md, services own DTO shaping + ' +
        'tenant-context.\n\n' +
        '**Read methods on the service (all gated by an explicit `workspaceId` per finding #26):**\n\n' +
        "- `getWorkflow(projectId, workspaceId)`: returns `{ statuses: WorkflowStatus[], transitions: WorkflowTransition[], policyMode: 'restricted' | 'open' }`, statuses ordered by `position`.\n" +
        '- `listStatusesByProject(projectId, workspaceId)`: convenience for board columns + pickers.\n' +
        '- `getStatusByKey(projectId, key, workspaceId)`: returns `WorkflowStatus | null` — the lookup `work_item.status` resolves through.\n' +
        "- `getTerminalStatusKeys(projectId, workspaceId): Set<string>`: returns every status key whose category is `done`. This is the surface that resolves finding #21 — `workItemsService.isReady` and `workItemLinkRepository.countOpenBlockers` swap their `'done'` literal for this set in 2.2.6.\n" +
        "- `canTransition(projectId, fromKey, toKey, workspaceId): Promise<boolean>`: returns true if `policyMode === 'open'` OR a `workflow_transition` row exists for (from, to); also true if `fromKey === toKey` (no-op moves are always legal). Reads the curated transition set via the repository.\n\n" +
        '**Per finding #26:** every public service method takes `workspaceId` ' +
        'explicitly and the repository methods filter `WHERE workspaceId = $ws` rather ' +
        'than trusting RLS — the dev/CI superuser bypasses RLS, so the explicit filter is the ' +
        'actual gate, and the (forced) RLS from 2.2.1 is the defense-in-depth backstop. Mirrors ' +
        "Story 1.4.8's pattern.\n\n" +
        '**Repository methods** are pure single-op reads (`findStatuses`, ' +
        '`findTransitions`, `findStatusByKey`, `findProjectPolicyMode`); ' +
        "no joins beyond what Prisma's relation includes deliver.\n\n" +
        '## Acceptance criteria\n\n' +
        '- Service exports the 5 read methods above, all with explicit `workspaceId` parameters and DTO-shaped returns (no raw Prisma types leaked to callers).\n' +
        '- Repository methods filter by `workspaceId` explicitly (defense in depth on top of RLS); a cross-workspace `findStatuses(otherProjectId, wrongWorkspaceId)` returns `[]`.\n' +
        "- `getTerminalStatusKeys` returns the set of `category === 'done'` keys — verified against the default seed (returns `new Set(['done', 'cancelled'])` since 2.2.2 ships both as terminal); after a test-side insert adding a `'wont_fix'` status with category `done`, returns `new Set(['done', 'cancelled', 'wont_fix'])`.\n" +
        '- `canTransition` covers all four matrix cells: open mode → true for any (from, to); restricted mode + transition row exists → true; restricted mode + no row → false; `fromKey === toKey` → true regardless of mode.\n' +
        '- Vitest under real Postgres covering the matrix above + the cross-workspace filter assertion.\n' +
        '- No route, no UI — pure service + repo layer.\n\n' +
        '## Context refs\n\n' +
        "- Story 1.4's `workItemsService` + `workItemRepository` — the 4-layer + explicit-`workspaceId` shape this mirrors\n" +
        "- Story 1.6.5's `jobsDashboardService.listByWorkspace` — the explicit-`workspaceId`-filter precedent\n" +
        '- Finding #26 — explicit application-layer tenant gate; finding #21 — terminal-status set surface\n' +
        '- `prodect-core/CLAUDE.md` — DTO mapping owned by service; repos are single-op leaves',
    },
    {
      id: '2.2.4',
      title: 'Transition validation + integration with `issuesService.updateStatus`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['2.2.3', '2.1.2'],
      descriptionMd:
        'Add `issuesService.updateStatus(workItemId, toStatusKey, workspaceId, ctx)` — the ' +
        'first write into `work_item.status` that goes through the typed-workflow gate. ' +
        'The method:\n\n' +
        '- Loads the work item by `id` + `workspaceId` (using the existing tenant-gated read from Story 1.4.8); 404 if missing or cross-tenant.\n' +
        "- Reads the work item's `projectId`; calls `workflowsService.getStatusByKey(projectId, toStatusKey, workspaceId)`; throws `UnknownStatusError` (code `UNKNOWN_STATUS`, → 422) if no such status in this project's workflow.\n" +
        '- Calls `workflowsService.canTransition(projectId, fromKey, toKey, workspaceId)`; throws `IllegalTransitionError` (code `ILLEGAL_TRANSITION`, → 422) on false. Error message names the offending (from, to) pair.\n' +
        "- Writes the new `status` (free-form string column, unchanged shape from 1.4) and emits the existing `work_item_revision` row via 1.4.6's existing revision pipeline — the revision diff records the status change in the same shape every other field does, so Epic 5's activity feed surfaces it for free.\n" +
        "- All in one `$transaction` (status write + revision row), same pattern as 1.4.4's `updateWorkItem`.\n\n" +
        '**Why not just a DB `CHECK` constraint:** a free-form ' +
        "`status` string with a project-scoped legal set + per-project transitions can't " +
        'be expressed as a static `CHECK`. A trigger could (and would also catch direct ' +
        'writes), but the cost is high and the benefit small — the service layer is the only writer ' +
        'for production code; the repository `tx`-required rule from CLAUDE.md keeps the ' +
        "surface narrow. Same risk model as 2.1.2's type-parent rule: the service is the friendly " +
        'gate; the schema layer just keeps `status` NOT NULL.\n\n' +
        "**Boundary with Story 2.1's `createIssue`:** the create path " +
        "(2.1.3) seeds the new issue with the project's *initial* status (looked up via " +
        '`listStatusesByProject().find(s => s.isInitial)`), bypassing transition ' +
        'validation — there\'s no "from" status on a brand-new row. The pre-existing ' +
        "`'todo'` default-status string in `work_item.status` is removed; the " +
        "default now comes from the workflow's initial-status row. `createIssue` in 2.1.3 " +
        'must be updated by this Subtask to call the workflow lookup. (This was identified as a ' +
        'forward update during 2.1 expansion; calling it out here so 2.2.4 owns the change rather ' +
        'than re-discovering it.)\n\n' +
        '## Acceptance criteria\n\n' +
        '- `issuesService.updateStatus` + the two typed errors (`UnknownStatusError`, `IllegalTransitionError`) shipped, both surfacing the offending pair in the message.\n' +
        "- `createIssue` updated to read the initial status from the workflow rather than hardcoding `'todo'`; if the project has no initial status (corrupt seed), throws `NoInitialStatusError` (code `NO_INITIAL_STATUS`, → 500 — server invariant violation).\n" +
        '- Status write + revision write are atomic (one `$transaction`); a forced revision-insert failure rolls back the status change.\n' +
        '- Vitest under real Postgres: legal restricted transition succeeds + writes a revision row; illegal restricted transition rejected; open-mode project accepts any legal status as a transition target; unknown status key rejected; cross-workspace work-item ID → 404, not `UnknownStatusError` (tenant-gate fires first).\n' +
        '- No-op transition (`updateStatus(id, currentKey)`) succeeds without writing a revision row — same idempotency rule revisions already follow elsewhere.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/issuesService.ts` (built in 2.1.2/2.1.3)\n' +
        "- `lib/services/workItemsService.ts` — Story 1.4.4's `updateWorkItem` as the multi-write transaction pattern\n" +
        "- Story 1.4.6's `work_item_revision` writer — the existing diff-emission path\n" +
        '- `lib/workspaces/errors.ts` — the typed-error precedent (code + 422 mapping)\n' +
        '- Finding #21 → resolved when 2.2.6 swaps the literal',
    },
    {
      id: '2.2.5',
      title: 'Workflow management API + project-settings UI',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['2.2.3'],
      descriptionMd:
        'Ship the write surface so a project admin can edit their workflow: add/rename/recolor/reorder ' +
        'statuses, add/remove transitions, and flip `workflow_policy_mode`. Built as ' +
        'Server Actions following the 4-layer rule (Action → Service → Repository → Prisma) and ' +
        'mounted under the existing project-settings route shell from Story 1.5.\n\n' +
        '**Service write methods:**\n\n' +
        '- `createStatus({ projectId, workspaceId, key, label, category, color, position })` — inserts, validates `key` is project-unique, position via fractional-indexing.\n' +
        '- `updateStatus({ statusId, workspaceId, label?, category?, color?, position?, isInitial? })` — partial update; flipping `isInitial` to true inside one tx unsets the previous initial-status row (atomic to satisfy the partial unique index from 2.2.1).\n' +
        "- `deleteStatus({ statusId, workspaceId })` — refuses (throws `StatusInUseError` → 422) if any `work_item.status` still references this status key OR if it's the initial status OR if removing it would leave the project with zero `category = 'done'` statuses (the last terminal-status invariant). Same-tx cleanup deletes all `workflow_transition` rows pointing to or from this status.\n" +
        '- `addTransition({ projectId, workspaceId, fromStatusId, toStatusId })` — inserts; the unique constraint from 2.2.1 makes duplicate inserts idempotent (catch P2002 → return existing).\n' +
        '- `removeTransition({ transitionId, workspaceId })`.\n' +
        "- `setPolicyMode({ projectId, workspaceId, mode })` — flips the project's `workflow_policy_mode` column.\n\n" +
        '**Permission gate:** every write method calls `workspacesService.assertProjectAdmin(userId, projectId, workspaceId)`. ' +
        'v1 routes "project admin" to the workspace owner role added in Story 1.6.5 (finding #36) — ' +
        'full per-project RBAC is Epic 6 work. This is intentionally narrow: the durable shape is a ' +
        'permission check that exists; the durable scope expansion (to a real "project admin" role) ' +
        'is the Epic-6 add. Owner gate today, admin gate later — same gate function, swapped ' +
        'implementation. Not a "shortcut now, real later" — the gate is the durable shape; the ' +
        'role-set behind it widens in Epic 6.\n\n' +
        '**UI: `/settings/project/[projectKey]/workflow`** route under ' +
        'the existing project-settings shell. Two tabs: *Statuses* (drag-to-reorder list, ' +
        'inline edit, add/delete) and *Transitions* (a matrix grid: rows = from-status, ' +
        'columns = to-status, click cell to toggle). A header toggle controls policy mode ' +
        '(`restricted` vs `open`); a banner under the toggle explains the ' +
        'consequence (*"Open mode: any status can transition to any other"*). Uses the Story ' +
        '1.5 shell primitives (Modal, Toast, Pill); no new design-system components needed beyond a ' +
        'color-swatch picker that composes from the existing color tokens. All actions are ' +
        'optimistic with toast confirmation; failures revert + toast the typed-error message.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Six service write methods shipped with their typed errors; every one calls `assertProjectAdmin` first and surfaces the typed-error message on failure.\n' +
        '- Initial-status flip is atomic (the previous initial-status row is unset in the same tx); the partial unique index never sees two true rows.\n' +
        "- Delete protections: deleting a status referenced by any `work_item` → 422 `STATUS_IN_USE`; deleting the initial status → 422 `CANNOT_DELETE_INITIAL_STATUS`; deleting the last `category = 'done'` status → 422 `CANNOT_DELETE_LAST_TERMINAL_STATUS`.\n" +
        '- `/settings/project/[projectKey]/workflow` route renders the two tabs, drives all six service writes through Server Actions, optimistic UI + toast confirmation, A11y (axe) sweep on the page passes.\n' +
        '- Vitest covers the matrix + the three delete-protections + the atomic initial-status flip.\n' +
        '- Playwright spec covers: an owner edits the default workflow (rename "In Review" → "QA"), adds a "Cancelled" terminal status (`category: done`), removes the back-transition `in_review→in_progress`, flips policy mode → restricted re-applied.\n\n' +
        '## Context refs\n\n' +
        "- Story 1.5's `AppLayout` + settings-route shell\n" +
        "- Story 1.6.5's `JobsDashboard` — closest precedent for a project-settings-style admin surface with a Server Action + permission gate\n" +
        "- Story 1.2.5's typed-error catalog + `WorkspaceMembershipError` shape\n" +
        '- Story 1.6.5\'s owner gate + finding #36\'s `workspaceRolesService` — the temporary "owner == admin" implementation seam\n' +
        '- Design system tokens for category colors (semantic Pill tones, post-finding-#35 fix)',
    },
    {
      id: '2.2.6',
      title: 'Resolve finding #21 — generalize `isReady` + `countOpenBlockers`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 10,
      dependsOn: ['2.2.3'],
      descriptionMd:
        "Close finding #21 — Story 1.4.4's `workItemsService.isReady` + " +
        '`workItemLinkRepository.countOpenBlockers` currently hardcode ' +
        "`'done'` as the terminal-status literal. Now that 2.2.3 exposes " +
        '`workflowsService.getTerminalStatusKeys(projectId)`, swap the literal for the ' +
        'set. The blocker is "open" iff its `status` is NOT in its project\'s terminal-key ' +
        'set.\n\n' +
        'The blocker can live in a DIFFERENT project than the work item being readiness-checked ' +
        '(cross-project blocks are legal in the work_item_link model from 1.4.3). So the resolution ' +
        "uses each blocker's own project's terminal set, not the readiness-check work item's " +
        "project's set. The repository method takes a typed input shape and resolves terminal sets " +
        'per project in one batched query — not N+1.\n\n' +
        'Implementation shape: `countOpenBlockers(workItemId, getProjectTerminalSet: ' +
        '(projectId: string) => Promise<Set<string>>)` stays a repo method — ' +
        'the service layer composes `workflowsService.getTerminalStatusKeys` in. To avoid ' +
        'N+1, fetch all unique blocker project IDs in one query, then call a batched ' +
        '`workflowsService.getTerminalStatusKeysByProjects(projectIds, workspaceId)` ' +
        '(new method added on top of 2.2.3) returning `Map<projectId, Set<string>>` ' +
        'in one round-trip.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `workItemsService.isReady` no longer references the string literal `'done'` for terminal classification; uses the per-project terminal-key set.\n" +
        '- New `workflowsService.getTerminalStatusKeysByProjects(projectIds, workspaceId)` ships and is used by `countOpenBlockers` for the batched lookup.\n' +
        "- Vitest test for the scenario from finding #21: a blocker with `status: 'cancelled'` in a default-seeded project (where `cancelled` is `category: 'done'` out of the box) counts as resolved; if a test recategorizes `cancelled` to `todo` in one project's workflow, the same blocker there still counts as blocking — proving the resolution reads each project's live category, not a hardcoded set.\n" +
        "- Cross-project blocker test: project A and project B both have the default seed; an admin recategorizes `cancelled` in project B to `category: 'todo'`; a work item in project A blocked by a cancelled blocker in project B still counts as blocked, while one blocked by a cancelled blocker in project A is ready — the readiness check correctly uses each blocker's own project's terminal set.\n" +
        '- Performance: one query for blockers, one query for the per-project terminal sets, regardless of how many blocker projects there are (asserted via Prisma query log spy).\n' +
        "- The previous v1 hardcode + its inline comment removed; finding #21's note in `countOpenBlockers` + `isReady` deleted.\n" +
        "- Finding #21's entry in `PRODECT_FINDINGS.md` gets a `> Resolved: 2.2.6` appended.\n\n" +
        '## Context refs\n\n' +
        '- Finding #21 in `prodect_plan/PRODECT_FINDINGS.md`\n' +
        '- `lib/services/workItemsService.ts` — current `isReady` + its v1 test\n' +
        '- `lib/repositories/workItemLinkRepository.ts` — current `countOpenBlockers` + the literal to remove\n' +
        '- `workflowsService` from 2.2.3 — extend with the batched method',
    },
    {
      id: '2.2.7',
      title: 'Story E2E — workflow lifecycle + transition enforcement',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 17,
      dependsOn: ['2.2.2', '2.2.4', '2.2.5', '2.2.6'],
      descriptionMd:
        "The Story's closing journey-driven E2E (Playwright, real Postgres, real Next dev, " +
        'following the Story-1.5.6 / Story-1.6.6 pattern). Drives the full workflow lifecycle from ' +
        "the user's seat to surface bugs the unit/integration tests miss, plus the tenant-isolation " +
        'guarantees.\n\n' +
        '**Scenarios covered:**\n\n' +
        '- **Auto-seed:** a new workspace + new project lands at `/settings/project/[projectKey]/workflow` ' +
        'showing the six default statuses (`todo`, `blocked`, `in_progress`, `in_review`, `done`, `cancelled`) ' +
        '+ fifteen transitions + restricted policy. Assert both categories (`todo`, `in_progress`, `done`) ' +
        'are represented and that `blocked` + `cancelled` are rendered with the right pills.\n' +
        '- **Status edit:** rename "In Review" → "QA" via the inline editor; reload; the change persists; existing issues with `status: \'in_review\'` still resolve (the `key` is stable across renames — only the `label` changes; covered by a separate assertion).\n' +
        '- **Blocked round-trip (default-seeded):** create an issue, transition `todo→blocked` (legal per the seed); confirm the issue surfaces under the Blocked column / pill; transition `blocked→in_progress` back; both transitions succeed under restricted mode without flipping policy.\n' +
        '- **Cancellation round-trip (default-seeded):** cancel an in-progress issue (`in_progress→cancelled`, legal per the seed); confirm finding-#21 readiness effect (a work item blocked by this cancelled blocker becomes ready); reopen via `cancelled→todo` and confirm the work item is blocked again.\n' +
        '- **Status add + delete:** add a new "Won\'t Fix" status with `category: done`; `getTerminalStatusKeys` now returns `{done, cancelled, wont_fix}`; try to delete the initial status → 422 toast; try to delete BOTH `done` AND `cancelled` in sequence — the second deletion is blocked by `CANNOT_DELETE_LAST_TERMINAL_STATUS` because `wont_fix` alone keeps the invariant; remove `wont_fix` too → blocked again until at least one terminal remains.\n' +
        '- **Transition enforcement:** from the issue-detail page (existence point: assumed by 2.4; if 2.4 hasn\'t shipped at this Story\'s E2E time, the test drives the transition via the Server Action directly via Playwright route — same gate). Drag/click "Done" from "To Do" in a restricted project: rejected with the typed error. Flip policy to `open`: same move succeeds.\n' +
        "- **Cross-workspace isolation:** workspace A's workflow edits don't bleed into workspace B's project of the same key (mirroring Story 1.6.5's isolation test).\n" +
        '- **Owner-only management:** a non-owner member loading `/settings/project/.../workflow` sees the read-only fallback; their Server Action POST returns 403.\n' +
        '- **Atomic-flip race:** from two simultaneous sessions, both call `updateStatus({ isInitial: true })` on different rows; only one succeeds — the partial unique index from 2.2.1 plus the same-tx unset path from 2.2.5 keeps the invariant.\n\n' +
        '**Helpers:** a new `tests/e2e/_helpers/workflow.ts` lifted from ' +
        'the inline setup, mirroring `shell-session.ts` + `email-fault.ts` ' +
        'patterns. Reused by any later Story (boards, list view) needing a workflow-seeded test ' +
        'fixture.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `tests/e2e/workflow-flow.spec.ts` ships the seven scenarios above; all green locally + in CI.\n' +
        '- `tests/e2e/_helpers/workflow.ts` reusable fixture lifted out.\n' +
        '- The shell-a11y sweep (from 1.5.5) is extended to include `/settings/project/[projectKey]/workflow` in EMPTY state; zero rule exclusions.\n' +
        '- Quality gates green (tsc + eslint + vitest); full E2E suite green in CI (local OOM exception applies per 1.6.4/1.6.5).\n' +
        "- Any bug discovered during this E2E that's in-scope for the Story gets fixed in this Subtask's PR; anything out-of-scope is logged to `PRODECT_FINDINGS.md` per mistake #27.\n\n" +
        '## Context refs\n\n' +
        '- `tests/e2e/shell-flows.spec.ts` (1.5.6) + `tests/e2e/jobs-flow.spec.ts` (1.6.6) — the journey-driven Story E2E shape\n' +
        '- `tests/e2e/_helpers/shell-session.ts` — the lift-helpers pattern\n' +
        '- `tests/e2e/shell-a11y.spec.ts` (1.5.5) — extension surface for the new route\n' +
        '- `playwright.config.ts` — current webServer + env-gate setup\n' +
        '- `PRODECT_FINDINGS.md` — finding-protocol per mistake #27',
    },
    {
      id: '2.2.8',
      title: 'Status color picker — `ColorSwatchPicker` component + wire into the status form',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['2.2.5'],
      descriptionMd:
        'Subtask 2.2.5 shipped the status `color` as a free-form hex text ' +
        '`Input` in the add/edit-status modal — a placeholder. The 2.2.5 card always ' +
        'intended "a color-swatch picker that composes from the existing color tokens"; this ' +
        'Subtask completes that deferred piece (logged as a follow-up during 2.2.5 visual review).\n\n' +
        'Add a reusable `components/ui/ColorSwatchPicker` design-system primitive: a ' +
        'keyboard-navigable **radiogroup** of selectable swatches drawn from the ' +
        'existing design-system color tokens (the category tints + the semantic palette, post-' +
        'finding-#35), each swatch an accessible radio (`aria-checked`, arrow-key ' +
        'navigation, visible focus ring), PLUS a **"None — derive from category"** ' +
        'option that maps to `null`. A custom-hex escape hatch is optional (a small ' +
        '"Custom…" affordance) but the primary affordance is the curated token swatches so colors ' +
        'stay on-brand and AA-safe. No raw free-text hex as the default path.\n\n' +
        'Wire it into the `StatusFormModal` (both Add and Edit) in ' +
        '`WorkflowEditor`, replacing the hex `Input`. The selected value ' +
        '(a token hex string or `null`) flows unchanged to `createStatus` / ' +
        "`updateStatus`'s existing `color` field — no service/schema change " +
        "(2.2.1's `color String?` already stores it; null = derive-from-category).\n\n" +
        '## Acceptance criteria\n\n' +
        '- `components/ui/ColorSwatchPicker.tsx` — a controlled radiogroup of design-token swatches + a "None (derive from category)" choice; fully keyboard-operable (roving tabindex / arrow keys), each swatch has an accessible name, the group is labelled.\n' +
        '- `StatusFormModal` uses it instead of the hex `Input`; selecting a swatch sets `color` to that token hex, "None" sets `null`; the value round-trips through create + edit (the row\'s swatch reflects the saved color).\n' +
        "- The page's axe sweep (shared with 1.5.5 / 2.2.5) still passes with the picker open — radiogroup semantics, contrast of the focus ring + selected indicator.\n" +
        '- A component test (vitest + testing-library): rendering the swatches, selecting one fires `onChange` with its value, selecting "None" fires `null`, keyboard arrow navigation moves the selection.\n' +
        '- Quality gates green (tsc + eslint + prettier + vitest).\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/settings/project/workflow/_components/WorkflowEditor.tsx` (2.2.5) — the `StatusFormModal` the picker slots into\n' +
        '- The design-system color tokens (category tints + semantic palette) + `components/ui/Pill.tsx` (post-finding-#35 AA-safe tones)\n' +
        '- `components/ui/FormField.tsx` / an existing radio-or-segmented control — the a11y radiogroup pattern to mirror\n' +
        '- `lib/dto/workflows.ts` — `WorkflowStatusDto.color: string | null` (the value shape, unchanged)',
    },
    {
      id: '2.2.9',
      title: 'Restore default workflow — re-add missing default statuses + transitions',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.2.5'],
      descriptionMd:
        'After an admin edits a workflow (deletes statuses, removes transitions, renames things), ' +
        'they need a way to get the defaults back without recreating each one by hand. Add a ' +
        '**"Restore defaults"** capability that re-adds any *missing* default ' +
        "statuses and transitions from 2.2.2's `DEFAULT_STATUSES` / " +
        '`DEFAULT_TRANSITIONS`.\n\n' +
        '**Durable shape — ADDITIVE merge, never destructive.** Restoring defaults ' +
        're-adds the six default statuses (matched *by key*) that are missing and the default ' +
        'transitions whose endpoints now exist — but it NEVER deletes a custom status the admin ' +
        "added, never removes their custom transitions, and never overwrites a renamed default's " +
        "label/color. It is **idempotent**: on a pristine default-seeded project it's a " +
        'no-op; running it twice changes nothing the second time. A separate *destructive* ' +
        '"reset to factory" (wipe + reseed) is explicitly OUT of scope here — flagged as a possible ' +
        'follow-up if the user wants it, but additive-restore is the safe default.\n\n' +
        '`workflowsService.restoreDefaultWorkflow({ userId, workspaceId, projectId })` ' +
        '— admin-gated (same `assertProjectAdmin` as 2.2.5). In one transaction: read the ' +
        "project's current statuses + transitions; for each default status whose `key` is " +
        'absent, insert it (appended position via the fractional-index helper, category/label from ' +
        'the default; `isInitial` only if the project currently has NO initial status — ' +
        'otherwise leave the existing initial untouched); then for each default transition pair whose ' +
        'both endpoints now exist, insert it if absent (idempotent on the 2.2.1 unique constraint).\n\n' +
        '**UI:** a "Restore defaults" button in the workflow-settings header ' +
        '(admin-only), behind a confirm modal that states it re-adds the standard statuses & ' +
        'transitions and does NOT remove customizations. Optimistic + toast, same pattern as 2.2.5.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `workflowsService.restoreDefaultWorkflow` re-adds missing default statuses (by key) + missing default transitions; idempotent (a second call is a no-op); never deletes or duplicates rows; admin-gated (`NotProjectAdminError` for a non-owner).\n' +
        '- Initial-status rule: if the project has no initial status, restore makes `todo` initial; if it already has one (even a custom status), the existing initial is left untouched (the partial-unique index from 2.2.1 is never violated).\n' +
        '- A custom status the admin added survives the restore unchanged; a renamed default (e.g. "In Review" → "QA") is matched by key and NOT reverted.\n' +
        '- UI: admin-only "Restore defaults" button + confirm modal + success toast + revalidate; non-admins don\'t see it and a direct Server-Action call is rejected server-side.\n' +
        '- Vitest (real Postgres): delete `in_review` + `cancelled` and a transition, add a custom `on_hold` status, run restore → the two defaults + their transitions return, `on_hold` stays, no dupes; a second restore call is a no-op.\n' +
        '- Quality gates green (tsc + eslint + prettier + vitest).\n\n' +
        '## Context refs\n\n' +
        '- `lib/workflows/defaultWorkflow.ts` (2.2.2) — `DEFAULT_STATUSES` / `DEFAULT_TRANSITIONS` source of truth\n' +
        '- `lib/services/workflowsService.ts` (2.2.2/2.2.5) — `seedDefaultWorkflow` / `createStatus` / `assertProjectAdmin` / the repo write methods to reuse\n' +
        '- `app/(authed)/settings/project/workflow/` (2.2.5) — the settings UI + Server Actions to extend\n' +
        "- `lib/workItems/positioning.ts` — `keyForAppend` for the re-added statuses' positions",
    },
    {
      id: '2.2.10',
      title: 'Protect default statuses (immutable except color) + rename restore action',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.2.5', '2.2.9'],
      descriptionMd:
        'Per **finding #49** (Yue, 2026-06-03): the six default statuses ' +
        '(`todo`/`blocked`/`in_progress`/`in_review`/`done`/`cancelled`) ' +
        'are a STANDARD, protected set. An admin **cannot rename, recategorize, reorder, or ' +
        'delete** a default status — the ONLY editable property is **color**. ' +
        'Custom statuses the admin adds stay **fully editable + deletable**. This ' +
        'revises 2.2.5\'s "all statuses equally mutable" model and resolves the three UX gaps Yue ' +
        'raised: a default has no delete button (non-deletable), a "Default" badge marks it, and ' +
        "since it can't be renamed its label always shows the standard meaning (so the " +
        'internal-`key` confusion disappears).\n\n' +
        '**Service.** Export `DEFAULT_STATUS_KEYS` from ' +
        '`defaultWorkflow.ts`. `deleteStatus` rejects a default ' +
        '(new typed `DefaultStatusProtectedError` → 422). `updateStatus` ' +
        'on a default rejects any change to `label`/`category`/`isInitial`/`position` ' +
        'and allows only `color` (same typed error). The 2.2.5 initial / ' +
        'last-terminal delete-protections stay as the backstop for CUSTOM statuses (a custom ' +
        'status could still be initial or the last terminal).\n\n' +
        '**UI (`WorkflowEditor`).** A "Default" badge (`Pill`) ' +
        'on default statuses. Default rows show NO delete / reorder buttons, and their edit ' +
        'affordance exposes ONLY the `ColorSwatchPicker` (label/category read-only or ' +
        "hidden). Custom rows keep the full edit/delete/reorder set. Reorder: a default's up/down " +
        'is disabled; custom statuses still reorder freely (incl. interleaved with defaults via ' +
        'fractional positions).\n\n' +
        '**Rename the restore action.** Because default statuses can no longer go ' +
        'missing, the only thing that can be lost is default TRANSITIONS. Rename the ' +
        '"Restore defaults" button → **"Restore default transitions"** and update ' +
        "the confirm-modal copy. 2.2.9's `restoreDefaultWorkflow` narrows to (or is " +
        'renamed for) re-adding missing default transitions; its status-re-add path becomes a ' +
        'defensive no-op under the protected model.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A default status CANNOT be deleted, renamed, recategorized, or reordered (typed `DefaultStatusProtectedError` → 422 at the service); it CAN be recolored. Verified per operation.\n' +
        '- A custom status remains fully editable + deletable (the 2.2.5 behavior), and the initial / last-terminal delete-protections still fire for custom statuses where they apply.\n' +
        '- UI: default rows render a "Default" badge, no delete/reorder controls, and a color-only edit; custom rows render the full controls. A11y sweep still passes.\n' +
        '- The "Restore defaults" button is renamed "Restore default transitions"; its action re-adds only the missing default transition edges (idempotent), and the confirm copy reflects the narrower scope.\n' +
        '- Vitest (real Postgres): reject delete/rename/recategorize/reorder of a default; accept recolor; custom-status full edit; restore-default-transitions re-adds a deleted default edge and is a no-op when complete.\n' +
        '- Quality gates green (tsc + eslint + prettier + vitest).\n\n' +
        '## Context refs\n\n' +
        '- Finding #49 in `PRODECT_FINDINGS.md` — the protected-default decision\n' +
        '- `lib/workflows/defaultWorkflow.ts` — add/export `DEFAULT_STATUS_KEYS`\n' +
        '- `lib/services/workflowsService.ts` (2.2.5/2.2.9) — `deleteStatus` / `updateStatus` / `restoreDefaultWorkflow` to gate + rescope; `lib/workflows/errors.ts` for the new error\n' +
        '- `app/(authed)/settings/project/workflow/_components/WorkflowEditor.tsx` + `actions.ts` (2.2.5/2.2.9) — the badge, the default-vs-custom affordances, the button rename\n' +
        '- `components/ui/ColorSwatchPicker.tsx` (2.2.8) + `components/ui/Pill.tsx`',
    },
  ],
};
