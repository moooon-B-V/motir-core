import type { PlanStory } from '../types';

/**
 * Story 3.1 — Board data model + column-from-workflow projection.
 *
 * The FIRST story of Epic 3 (Boards) and a pure-backend story: it ships the
 * board entity model, the read projection that turns a project's issues into
 * columns-of-cards, the server-validated move/reorder mutation path, and the
 * board API — but NO UI. The Kanban board surface (columns, cards, drag-drop)
 * is Story 3.2, and the design gate fires THERE (3.2 carries the
 * `design/boards/` mockup + its `type: design` subtask). 3.1 has no
 * UI-touching subtask, so it has no design subtask — by design, not omission.
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 3.1`. Matches the
 * canonical depth + string-literal style of the Epic-2 modules (e.g. 2.2).
 */
export const story_3_1: PlanStory = {
  id: '3.1',
  title: 'Board data model + column-from-workflow projection',
  status: 'planned',
  descriptionMd:
    'The data-model + projection floor under every board surface in Epic 3. A project owns one or ' +
    'more **boards**; each board owns an ordered set of **columns**; each column maps to a SET of ' +
    "the project's workflow statuses (Story 2.2). The board is a pure **read projection over " +
    "issues** — a card's column is *derived* from its `work_item.status`, and the board stores no " +
    'per-card placement state of its own. The load-bearing principle (carried from the stub): ' +
    '**moving a card = a workflow transition, never a board-local write.** A cross-column drop ' +
    'resolves to `issuesService.updateStatus` (validated by `workflowsService.canTransition` under ' +
    "the project's policy mode — Story 2.2.4); an in-column drop is a pure rank change on " +
    '`work_item.position`. This story builds the backend for both; Story 3.2 builds the drag-drop UI ' +
    'that calls it (illegal drops snap back on the typed error this story raises).\n\n' +
    '**Durable shape — why a real board entity, not "column == status".** The mirror product (Jira; ' +
    'decision-ladder rung 1) does NOT hardwire one column per status: a column maps to *many* ' +
    'statuses (the canonical example — merge `In Progress` + `In Review` into one "In Progress" ' +
    'column), and a status mapped to no column is **unmapped** (hidden from the board until an admin ' +
    'maps it). So the schema is a `board` + `board_column` + a `board_column_status` mapping ' +
    '(many statuses → one column; a status maps to ≤1 column per board). The "column == one status, ' +
    '1:1" form is the shortcut the no-shortcuts rule forbids ("simpler X now, migrate later"). The ' +
    '**default** board generated for a new project IS one-column-per-status (the column-from-workflow ' +
    'projection) — but that is a seeded *default over the durable mapping*, not a hardcoded shape. ' +
    'v1 auto-creates exactly ONE Kanban board per project; the `board.projectId` FK is non-unique, so ' +
    'multiple boards per project is a non-breaking later addition (board CRUD is not v1 scope). The ' +
    'Scrum (sprint-scoped) board is Story 3.4.\n\n' +
    '**Scale shape — the projection is bounded, never "load every row" (finding #57).** A real ' +
    "team's project has thousands of issues; a board that reads them all to render is prototype- " +
    'thinking. The projection paginates **per column**: each column returns its first N cards ' +
    '(ordered by `work_item.position`), a per-column total count, and a cursor for lazy "load more" ' +
    '(Story 3.2 virtualizes within a column). Done/terminal columns are additionally bounded to a ' +
    'recent window (Jira hides done issues older than ~14 days) with the full count surfaced. The ' +
    "projection reuses Story 2.5's issue-read path + filter shape (`workItemRepository` flat reads, " +
    'the AND-across-facet / OR-within-facet filter), not a new full-table scan.\n\n' +
    '**Prerequisites & contracts.** Story 2.2 ships `workflow_status` (the columns derive from these, ' +
    'in `status.position` order) + `project.workflow_policy_mode` + the transition validation the ' +
    'move path delegates to (2.2.4). Story 1.4 ships `work_item` with the `status` string + the ' +
    '`position` fractional index (finding #18) the within-column reorder writes. Story 2.5 ships the ' +
    "paginated issue-read precedent (2.5.12). All work follows `prodect-core/CLAUDE.md`'s 4-layer " +
    'architecture (Route → Service → Repository → Prisma); every new route carries an explicit ' +
    '`workspaceId` application-layer gate (finding #26 — RLS is the backstop, not the sole gate, ' +
    'because the dev/CI superuser bypasses RLS).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install && pnpm prisma generate && pnpm prisma migrate dev` against a fresh local DB.\n' +
    '- `pnpm test` — vitest covers the schema RLS, the default-board seed (one column per status, in workflow order), the repository reads, the projection (grouping + per-column pagination + count + unmapped statuses), and the move/reorder service (cross-column move = transition, illegal-move rejection, in-column rank change).\n' +
    '- `pnpm test:e2e --grep board-projection` — the closing API-level suite drives the real stack through the board endpoints (no UI yet — that arrives in 3.2).\n' +
    '- **Manual API check:** create a workspace + project (the default board auto-seeds). `GET /api/projects/[key]/board` → six columns (To Do / Blocked / In Progress / In Review / Done / Cancelled, in workflow order), each with its cards grouped by status, per-column counts, and an empty `unmappedStatuses`. Create ~10 issues across statuses → they appear in the right columns.\n' +
    '- **Unmapped-status check (finding #57 / mirror-product):** add a custom status via the workflow editor (Story 2.2.5). `GET …/board` → the new status appears in `unmappedStatuses` (NOT a new column, and NOT silently dropped) — proving the projection surfaces, rather than hides, statuses with no column mapping.\n' +
    '- **Scale check (finding #57):** `pnpm db:seed:large` (Story 2.5.16), open a column with hundreds of cards → the projection returns a bounded first page + a total count + a cursor; `GET …/board/columns/[id]/cards?cursor=…` returns the next page. The board never loads every row.\n' +
    "- **Move = transition check:** `POST …/board/move` a card from To Do → In Progress → it returns the moved card with the new status, and the issue's `status` is updated via the workflow path. Attempt an illegal cross-column move under `restricted` policy (e.g. To Do → Done if no such transition) → a typed `IllegalBoardMoveError` (HTTP 409), issue status unchanged — the snapback contract 3.2 relies on.\n" +
    '- **In-column reorder check:** move a card within the same column (no status change) → only `work_item.position` changes, no transition is attempted, column membership is unchanged.\n' +
    "- **RLS proof:** open a psql session as `prodect_app`, `SET app.workspace_id = '<workspace-A>'`, query `board` / `board_column` / `board_column_status` — see only workspace A's rows.",
  items: [
    {
      id: '3.1.1',
      title: 'Schema — `board` + `board_column` + `board_column_status` mapping + RLS',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['2.2.1', '1.3.1', '1.4.2'],
      descriptionMd:
        'Add the three board tables to `prisma/schema.prisma` and ship one Prisma migration that ' +
        'creates all three plus their RLS policies, reusing the workspace-scoped `app.workspace_id` ' +
        'GUC pattern Story 2.2.1 established (mirrors `job_run` / finding #33). Every table carries an ' +
        'explicit `workspaceId` column + a `projectId` FK + the Story-1.2 RLS gate, so board data ' +
        'inherits tenant isolation by structure, not by joins.\n\n' +
        '**Tables and key constraints:**\n\n' +
        '- `board`: `(id, workspaceId, projectId, name, type, createdAt, updatedAt)`. `type` is a ' +
        'Prisma enum `BoardType { kanban, scrum }` (the durable shape — Jira has both; the Scrum ' +
        'sprint-scoped view is Story 3.4, but the enum value exists now so 3.4 adds no enum ' +
        'migration). `projectId` is a plain FK, **NOT unique** — one project may own many boards ' +
        '(multiple-boards-per-project is a non-breaking later addition; v1 seeds exactly one). ' +
        '`@@index([projectId])` for the per-project board lookup.\n' +
        '- `board_column`: `(id, workspaceId, projectId, boardId, name, position, wipLimit, createdAt, ' +
        'updatedAt)`. `boardId` FK with `onDelete: Cascade`. `position` is `Decimal(20,10)` matching ' +
        'the work-item / workflow-status column-shape rule (finding #18) — the same fractional-index ' +
        'ordering, so column reorder (a later admin action) needs no new mechanism. `wipLimit` is ' +
        '`Int?` (nullable) — the column exists now so the WIP work in Story 3.3 adds no migration; ' +
        '**enforcement / over-limit warnings are 3.3, not this story** (this story only persists the ' +
        'column). `@@index([boardId, position])` for ordered column reads.\n' +
        '- `board_column_status`: `(id, workspaceId, projectId, boardId, columnId, statusId, ' +
        'createdAt)` — the **column ↔ status mapping**. `columnId` FK → `board_column` ' +
        '(`onDelete: Cascade`); `statusId` FK → `workflow_status` (`onDelete: Cascade`). ' +
        '`@@unique([boardId, statusId])` enforces a status maps to **≤1 column per board** ' +
        '(many statuses MAY map to one column — the Jira "merge In Progress + In Review" shape — but ' +
        'a status is never in two columns at once). A project status with NO row here is **unmapped** ' +
        '(surfaced by the 3.1.4 projection, not shown as a column). `@@index([columnId])` for the ' +
        'per-column status read.\n\n' +
        '**RLS:** all three tables enable RLS + `FORCE ROW LEVEL SECURITY` (so even the table owner is ' +
        'gated, per Story 1.4.5). One policy per table covering all four verbs: ' +
        "`USING (workspace_id = current_setting('app.workspace_id')::uuid)` + the system-admin escape " +
        "hatch `OR current_setting('app.system_admin', true) = 'true'` (finding #33), mirroring " +
        '`workflow_status` exactly.\n\n' +
        "**What this does NOT do:** seed any rows (the default board is 3.1.2's job — application " +
        'code under the `prodect_app` role with the workspace GUC set, never a SQL `INSERT` in the ' +
        'migration); add any read/write service or repository (3.1.3+); or change `work_item` ' +
        '(card placement is derived from its existing `status` + `position`, no new column).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `board` + `board_column` + `board_column_status` + the `BoardType` enum added in ONE Prisma migration; `prisma migrate dev` applies cleanly against a fresh DB.\n' +
        '- RLS enabled + FORCED on all three tables; the `app.workspace_id` + `app.system_admin` GUC policy mirrors `workflow_status` (finding #33).\n' +
        '- `@@unique([boardId, statusId])` on `board_column_status` enforces ≤1 column per status per board; a second mapping of the same status to a different column on the same board is rejected by a constraint violation.\n' +
        '- `board.projectId` is indexed but NOT unique (multiple boards per project is legal at the schema level).\n' +
        '- `board_column.position` is `Decimal(20,10)` (finding #18); `board_column.wipLimit` is nullable `Int`.\n' +
        '- An RLS-proof test (mirroring `tests/jobs/rls.test.ts` / the 2.2.1 workflow RLS test) under `SET LOCAL ROLE prodect_app`: workspace A sees only its own board rows; cross-workspace SELECT returns 0; an INSERT carrying a foreign `workspaceId` is rejected.\n' +
        '- No SQL `INSERT` for default rows in the migration (seeding is application-layer, 3.1.2).\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — Story 1.3 `project`, Story 1.4 `work_item`, Story 2.2 `workflow_status` / `workflow_transition` / `StatusCategory`\n' +
        '- Story 2.2.1’s `workflow_status` migration — the canonical RLS + `app.system_admin` escape-hatch shape this Subtask mirrors\n' +
        '- Story 1.4.5’s `FORCE ROW LEVEL SECURITY` migration on `work_item`\n' +
        '- `tests/jobs/rls.test.ts` — the role-switch RLS-proof harness\n' +
        '- `prodect-core/CLAUDE.md` — 4-layer rule, repo-write contract\n' +
        '- Finding #18 — `Decimal(20,10)` position-column shape; finding #33 — GUC namespace',
    },
    {
      id: '3.1.2',
      title:
        'Default-board seed (`lib/boards/defaultBoard.ts`) wired into `createProject` + backfill',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['3.1.1', '3.1.3', '2.2.2'],
      descriptionMd:
        'Generate, for every new project, one default **Kanban** board whose columns are the ' +
        'column-from-workflow projection: one column per workflow status, in `status.position` ' +
        'order, each column mapped to its single status. This is a seeded default *over* the durable ' +
        'many-to-one mapping (3.1.1), not a hardcoded 1:1 — an admin can later merge/split columns.\n\n' +
        '**`lib/boards/defaultBoard.ts`** — a pure function ' +
        '`buildDefaultBoard(statuses: WorkflowStatusDto[]): DefaultBoardSpec` that takes the ' +
        "project's seeded statuses (the six from `lib/workflows/defaultWorkflow.ts`: To Do / Blocked / " +
        'In Progress / In Review / Done / Cancelled) and returns the board (name `"Board"`, ' +
        '`type: kanban`), one column per status (`name = status.label`, `position` mirroring ' +
        '`status.position`), and one `board_column_status` mapping per column → its status. Pure / ' +
        'typed / no I/O — snapshot-testable, exactly like `defaultWorkflow.ts`.\n\n' +
        '**Wire into `projectsService.createProject`.** Inside the SAME transaction that already seeds ' +
        'the default workflow (Story 2.2.2), after the statuses exist, call the board repositories ' +
        '(3.1.3) to persist the default board + columns + mappings. Ordering matters: the board seed ' +
        'reads the just-created status rows to map columns, so it runs after the workflow seed within ' +
        'the one `createProject` transaction (one service method = one transaction, per CLAUDE.md).\n\n' +
        '**Backfill existing projects.** The seed reseeds the `moooon` tenant wholesale, but real ' +
        'projects created before this story have no board. Ship an idempotent backfill (a one-off ' +
        'script under `scripts/` or a data-migration step, mirroring how prior stories backfilled): ' +
        'for each project lacking a board, build + persist the default board from its current ' +
        'statuses. Idempotent — re-running skips projects that already have a board.\n\n' +
        '**Out of scope:** board CRUD / rename / multi-board (not v1); reacting to LATER status ' +
        'additions (a custom status added post-seed lands **unmapped**, surfaced by the 3.1.4 ' +
        'projection — this story does not auto-append a column for it, matching Jira).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lib/boards/defaultBoard.ts` exports a pure `buildDefaultBoard(statuses)` returning the board + ordered columns + column→status mappings; unit-tested in isolation (snapshot of the six-column default).\n' +
        '- `projectsService.createProject` seeds the default board inside its existing transaction, after the workflow seed; a newly created project has exactly one Kanban board with one column per status, in workflow order, each mapped to its status.\n' +
        '- The seed is workspace-scoped (runs under the `prodect_app` role with the workspace GUC) — no raw SQL inserts, all through the 3.1.3 repositories.\n' +
        '- An idempotent backfill creates the default board for pre-existing board-less projects and is safe to re-run (no duplicate boards).\n' +
        '- A vitest integration test (real Postgres) asserts: create project → board + 6 columns + 6 mappings exist with the right names/order; re-running the backfill is a no-op.\n\n' +
        '## Context refs\n\n' +
        '- `lib/workflows/defaultWorkflow.ts` — the six-status default this projects from (Story 2.2.2)\n' +
        '- `lib/services/projectsService.ts` — the `createProject` transaction the board seed joins\n' +
        '- Story 2.2.2 — the default-workflow seed wired into `createProject` (the exact pattern this mirrors)\n' +
        '- `scripts/plan-seed/seed.ts` — how the tenant reseed runs services under the workspace GUC\n' +
        '- `prodect-core/CLAUDE.md` — one-service-method-one-transaction; no raw inserts',
    },
    {
      id: '3.1.3',
      title:
        'Board repositories — `boardRepository` / `boardColumnRepository` / `boardColumnStatusRepository`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['3.1.1'],
      descriptionMd:
        'The data-access leaf layer for boards — three repositories, each a set of single-Prisma-op ' +
        'methods, write methods requiring `tx: Prisma.TransactionClient` (CLAUDE.md). Named by ' +
        'primary entity, not call site.\n\n' +
        '**`boardRepository`** — `findByProject(projectId, workspaceId, tx?)` → `Board[]` (ordered by ' +
        '`createdAt`; v1 returns the single default board), `findDefaultForProject(projectId, ' +
        "workspaceId, tx?)` → `Board | null` (the project's board for the v1 single-board case), " +
        '`findById(boardId, workspaceId, tx?)` → `Board | null`, `create(data, tx)` → `Board`.\n\n' +
        '**`boardColumnRepository`** — `findByBoard(boardId, workspaceId, tx?)` → `BoardColumn[]` ' +
        '(ordered by `position asc`), `findById(columnId, workspaceId, tx?)` → `BoardColumn | null`, ' +
        '`create(data, tx)` → `BoardColumn`, `update(columnId, data, tx)` → `BoardColumn` (for the ' +
        'WIP/rename writes a later story uses). Batched `findByBoards(boardIds[], workspaceId, tx?)` ' +
        'for no-N+1 reads, mirroring `workflowsRepository.findStatusesByProjects`.\n\n' +
        '**`boardColumnStatusRepository`** — `findByBoard(boardId, workspaceId, tx?)` → ' +
        '`BoardColumnStatus[]` (the full mapping for the projection to bucket statuses → columns), ' +
        '`create(data, tx)` → `BoardColumnStatus`, `deleteByColumn(columnId, tx)` and ' +
        '`deleteByStatus(boardId, statusId, tx)` (re-map writes a later admin story uses). ' +
        '`findByColumn(columnId, workspaceId, tx?)` for a single column’s statuses.\n\n' +
        '**Rules:** each method is ONE Prisma call (no composition — that’s the service); reads used ' +
        'only by read paths may use the `db` singleton; writes require `tx`; every method takes ' +
        '`workspaceId` and scopes by it at the app layer (finding #26) on top of RLS. No DTO mapping ' +
        'here (services map). No business logic.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Three repositories exported as `export const <name>Repository = { ... }`, each method a single Prisma op.\n' +
        '- All write methods (`create` / `update` / `delete*`) take a required `tx: Prisma.TransactionClient`; pure reads may use `db`.\n' +
        '- Every method takes + filters by `workspaceId` (app-layer gate atop RLS, finding #26).\n' +
        '- Batched `findByBoards` exists for the projection’s no-N+1 read; no repository method calls another repository.\n' +
        '- Vitest (real Postgres) covers the reads + a representative write under a transaction, asserting workspace scoping.\n\n' +
        '## Context refs\n\n' +
        '- `lib/repositories/workflowsRepository.ts` — the exact shape (single-op, required-tx writes, batched reads) this mirrors\n' +
        '- `lib/repositories/workItemRepository.ts` — read-path / filter conventions\n' +
        '- `prodect-core/CLAUDE.md` — Repository layer rules (single op, required tx, entity-named, leaves)',
    },
    {
      id: '3.1.4',
      title:
        'Board projection service — columns + grouped, per-column-paginated cards + unmapped statuses',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['3.1.3', '3.1.2', '2.5.12'],
      descriptionMd:
        'The read heart of the story: `boardsService` turns a project’s board + workflow + issues ' +
        'into the column-of-cards projection the 3.2 UI renders — **bounded, never load-all** ' +
        '(finding #57).\n\n' +
        '**`getBoard(projectId, opts, ctx)` → `BoardProjectionDto`.** Reads the default board ' +
        '(3.1.3), its columns (ordered by `position`), and the `board_column_status` mapping; reads ' +
        "the project's workflow statuses (`workflowsService.listStatusesByProject`). For each column, " +
        'it loads the **first page** of cards whose `work_item.status` ∈ that column’s mapped status ' +
        'keys, ordered by `work_item.position asc`, via the Story-2.5 read path (a grouped/per-status ' +
        '`workItemRepository` query — reuse `findProjectIssuesFlat` + count, the same AND-across-facet ' +
        'filter shape, NOT a new full scan). Returns, per column: the column meta (id, name, position, ' +
        'wipLimit), the page of card DTOs, the per-column **total count**, and a **cursor** for ' +
        '"load more". Plus a top-level `unmappedStatuses: WorkflowStatusDto[]` — every project status ' +
        'with no `board_column_status` row (Jira’s behavior; surfaced, never silently dropped).\n\n' +
        '**Per-column pagination + lazy load (finding #57).** Default page size (e.g. 50) per column; ' +
        'the projection NEVER returns every card. `loadColumnCards(boardId, columnId, cursor, ctx)` → ' +
        '`PagedColumnCardsDto` returns subsequent pages so 3.2 can virtualize within a tall column. ' +
        "**Done/terminal columns** (`status.category = 'done'`) are additionally bounded to a recent " +
        'window (most-recent N by completion/position) with the full count surfaced — mirroring Jira’s ' +
        '"hide done older than ~14 days"; document the window as the durable shape, not a magic cap.\n\n' +
        '**`BoardCardDto`** — the card projection of `work_item`: `(id, key, identifier, kind, title, ' +
        'status, priority, assigneeId, assignee summary, position, parentId, dueDate, estimateMinutes, ' +
        'isReady/blocked signal)`. The blocked/ready signal reuses Story 1.4 / finding #21 readiness ' +
        "(`category = 'done'` terminal generalization) so a board card can show a blocked indicator. " +
        'Mapper in `lib/mappers/boardMappers.ts`; DTOs in `lib/dto/boards.ts`.\n\n' +
        '**Out of scope:** swimlane grouping + WIP enforcement (Story 3.3 — the projection returns ' +
        '`wipLimit` but does not enforce it); the move/reorder writes (3.1.5); any UI (3.2).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `boardsService.getBoard` returns ordered columns, each with its mapped statuses, a bounded first page of cards (ordered by `position`), a per-column total count, and a cursor — plus a top-level `unmappedStatuses` list.\n' +
        '- A project status with no column mapping appears in `unmappedStatuses` and in NO column (not dropped, not auto-columned).\n' +
        '- The projection reuses the Story-2.5 issue-read path (no new full-table scan); it never returns all cards for a column — `loadColumnCards` returns subsequent pages by cursor.\n' +
        '- Done-category columns are bounded to a documented recent window with the full count still reported.\n' +
        '- `BoardCardDto` carries the readiness/blocked signal via the finding-#21 terminal predicate; cards are DTOs (no raw Prisma rows cross the boundary), mapped in `lib/mappers/boardMappers.ts`.\n' +
        '- Vitest (real Postgres) covers: grouping into the right columns, per-column count + pagination + cursor, unmapped-status surfacing, terminal-column windowing, and workspace scoping.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workItemsService.ts` + `lib/repositories/workItemRepository.ts` — `findProjectIssuesFlat` / `countProjectIssues` / the `RepoIssueFilter` shape (Story 2.5.12) the projection reuses\n' +
        '- `lib/services/workflowsService.ts` — `listStatusesByProject` / `getTerminalStatusKeys` (the done-category set for terminal-column windowing)\n' +
        '- `lib/dto/workItems.ts` — the card-field precedent for `BoardCardDto`\n' +
        '- Story 1.4 / finding #21 — the readiness predicate the blocked signal reuses\n' +
        '- Finding #57 — the bounded-projection (no load-all) scale rule; finding #26 — the workspace gate\n' +
        '- `prodect-core/CLAUDE.md` — service owns DTO mapping; mappers in `lib/mappers/*`',
    },
    {
      id: '3.1.5',
      title: 'Board mutation service — cross-column move = workflow transition; in-column = rank',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.1.3', '2.2.4'],
      descriptionMd:
        'The write side that makes "moving a card = a workflow transition, not a board-local write" ' +
        'real. `boardsService.moveCard(boardId, workItemId, target, ctx)` where ' +
        '`target = { toColumnId, beforeId?, afterId? }`, in one transaction:\n\n' +
        '**1. Resolve the target column’s status.** Read the column’s `board_column_status` mapping. ' +
        'If the card’s current status is already in the target column’s mapped set (a within-column ' +
        'drop, OR a drop into a multi-status column that already contains the card’s status) → **no ' +
        'transition**, only a rank change. Otherwise pick the target status: the column’s mapped ' +
        'status; for a multi-status column, the one ordered first by `status.position` (Jira’s rule). ' +
        'A drop onto an **unmapped** target (a column with no statuses, or an unmapped status) is ' +
        'rejected with a typed error.\n\n' +
        '**2. Cross-column move → transition.** Delegate the status change to the validated path ' +
        '`issuesService.updateStatus` (Story 2.2.4), which runs `workflowsService.canTransition` under ' +
        "the project's policy mode. An illegal transition raises — caught + re-raised as a typed " +
        '`IllegalBoardMoveError` (carrying from/to status + the reason) so the 3.1.6 route maps it to ' +
        'HTTP 409 and the 3.2 UI **snaps the card back**. The issue’s `status` is the single source ' +
        'of truth; the board stores nothing about placement.\n\n' +
        '**3. Rank within the column.** Recompute `work_item.position` between the `beforeId` / ' +
        '`afterId` neighbors via the existing `lib/workItems/positioning.ts` fractional-index helper ' +
        '(finding #18) — the same mechanism the tree ordering uses. A pure within-column reorder ' +
        '(step 1 found no status change) does ONLY this, attempting no transition. (Board rank is the ' +
        'global `work_item.position`; the backlog-rank semantics deepen in Epic 4 — this story does ' +
        'not fork a board-local rank.)\n\n' +
        '**Returns** the updated `BoardCardDto` + the applied status + the resolved column, so the UI ' +
        'can reconcile its optimistic update. One service method = one transaction; typed errors ' +
        '(`IllegalBoardMoveError`, `UnmappedColumnTargetError`, not-found) live in `lib/boards/errors.ts`.\n\n' +
        '**Out of scope:** the drag-drop UI + optimistic update + snapback animation (Story 3.2 — this ' +
        'is the server contract it calls); WIP-limit rejection on over-limit drops (Story 3.3).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `boardsService.moveCard` resolves the target column’s status, delegates cross-column moves to the validated `issuesService.updateStatus` path (2.2.4), and updates `work_item.position` for rank — all in one transaction.\n' +
        '- A within-column move (or a drop into a column that already maps the card’s status) changes ONLY `position`; no transition is attempted.\n' +
        '- An illegal cross-column transition under `restricted` policy raises a typed `IllegalBoardMoveError` and leaves the issue status + position unchanged (the snapback contract).\n' +
        '- A drop onto an unmapped target raises a typed `UnmappedColumnTargetError`.\n' +
        '- Multi-status target columns resolve to the first status by `status.position` (Jira rule); the resolution is unit-tested.\n' +
        '- Vitest (real Postgres) covers: legal cross-column move (status + rank change), illegal move rejection (no mutation), pure in-column reorder (rank only), unmapped-target rejection, and workspace scoping.\n\n' +
        '## Context refs\n\n' +
        '- Story 2.2.4 — `issuesService.updateStatus` + `workflowsService.canTransition` (the validated transition path the move delegates to; do NOT re-implement transition validation)\n' +
        '- `lib/workItems/positioning.ts` — the fractional-index rank helper (finding #18) reused for in-column reorder\n' +
        '- `lib/services/workflowsService.ts` — policy mode + `canTransition`\n' +
        '- `prodect-core/CLAUDE.md` — one-service-method-one-transaction; typed errors in `lib/<domain>/errors.ts`',
    },
    {
      id: '3.1.6',
      title:
        'Board API routes — `GET` projection, `GET` column page, `POST` move (thin, workspace-gated)',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['3.1.4', '3.1.5'],
      descriptionMd:
        'The HTTP surface for the board backend — thin route handlers (parse, session, ONE service ' +
        'call, map typed errors), no business logic, no Prisma (CLAUDE.md). Each carries an explicit ' +
        '`workspaceId` application-layer gate (finding #26).\n\n' +
        '**Routes** (under the project key, mirroring the existing `/api/projects/[key]/…` tree):\n\n' +
        '- `GET /api/projects/[key]/board` → `BoardProjectionDto` (the default board projection — ' +
        'columns, first page of cards per column with counts + cursors, `unmappedStatuses`). Calls ' +
        '`boardsService.getBoard`.\n' +
        '- `GET /api/projects/[key]/board/columns/[columnId]/cards?cursor=&limit=` → ' +
        '`PagedColumnCardsDto` (the lazy "load more" page for one column). Calls ' +
        '`boardsService.loadColumnCards`.\n' +
        '- `POST /api/projects/[key]/board/move` with body `{ workItemId, toColumnId, beforeId?, ' +
        'afterId? }` → the moved `BoardCardDto`. Calls `boardsService.moveCard`. Maps ' +
        '`IllegalBoardMoveError` → **409**, `UnmappedColumnTargetError` → **422**, not-found → **404**, ' +
        'unauthenticated → **401** — the status codes the 3.2 UI branches on (409 ⇒ snap back).\n\n' +
        'Resolve the project by `key` + session workspace; the board id is implicit (the project’s ' +
        'default board) for v1, but the service takes `boardId` so multi-board routing is a later, ' +
        'non-breaking addition. Validate the request body shape; reject unknown columns / cross- ' +
        'project ids before the service call.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Three route handlers, each parsing the request, reading the session via `getSession()`, gating on `workspaceId`, calling exactly one service method, and returning `NextResponse.json`.\n' +
        '- No `db.*` / `prisma.$transaction` in any route file; typed service errors are mapped to 401 / 404 / 409 / 422 (an illegal move → 409, the snapback signal).\n' +
        '- `GET …/board` returns the projection; `GET …/columns/[id]/cards` returns the next page by cursor; `POST …/move` returns the moved card or the right typed error.\n' +
        '- Smoke/route tests assert the happy path + the 409 illegal-move mapping + the 401 unauthenticated guard.\n\n' +
        '## Context refs\n\n' +
        '- `app/api/projects/[key]/…` — the existing project-scoped route tree + key/workspace resolution pattern\n' +
        '- `lib/services/boardsService.ts` — `getBoard` / `loadColumnCards` / `moveCard` (3.1.4, 3.1.5)\n' +
        '- `lib/boards/errors.ts` — the typed errors the route maps to status codes\n' +
        '- `prodect-core/CLAUDE.md` — Route layer rules (HTTP only, one service call, error→status mapping); finding #26 — explicit workspace gate',
    },
    {
      id: '3.1.7',
      title: 'Story E2E — board projection + move-as-transition over the real stack (API-level)',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['3.1.4', '3.1.5', '3.1.6'],
      descriptionMd:
        'The closing integration suite for the board backend, driven through the real stack via the ' +
        '3.1.6 API (there is NO board UI yet — that arrives in Story 3.2, and the full drag-drop ' +
        'Playwright journey + WIP cases live in the Epic-3 test story 3.5). This story’s E2E proves ' +
        'the projection + move contract end-to-end so 3.2 can build the UI against a trusted backend.\n\n' +
        'A Playwright (API-request) spec `tests/e2e/board-projection.spec.ts` (or the project’s ' +
        'API-test harness) that, against a freshly seeded project:\n\n' +
        '- `GET …/board` → the six default columns in workflow order, cards grouped into the right ' +
        'columns, per-column counts, empty `unmappedStatuses`.\n' +
        '- Add a custom status (via the 2.2.5 workflow API) → `GET …/board` shows it in ' +
        '`unmappedStatuses`, in no column.\n' +
        '- Seed many cards in one column → the projection returns a bounded first page + count + ' +
        'cursor; `GET …/columns/[id]/cards?cursor=` returns the next page (finding #57 — no load-all).\n' +
        '- `POST …/move` a card across columns under a legal transition → 200, new status reflected ' +
        'on the issue + in a re-fetched projection.\n' +
        '- `POST …/move` an illegal cross-column transition under `restricted` policy → **409**, the ' +
        'issue status unchanged on re-fetch (the snapback contract 3.2 depends on).\n' +
        '- `POST …/move` within a column → 200, rank changes, status + column membership unchanged.\n\n' +
        'This subtask adds the cross-cutting E2E only; the per-method Vitest coverage lives in 3.1.1–' +
        '3.1.6 (real Postgres). It does NOT duplicate the Epic-3 test story (3.5), which adds the ' +
        'drag-drop UI journey + WIP + swimlane cases once 3.2/3.3 land.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e --grep board-projection` runs green against the real stack.\n' +
        '- The spec asserts: default-column projection + grouping + counts; unmapped-status surfacing; per-column pagination via cursor; legal move updates status; illegal move → 409 with status unchanged; in-column reorder changes rank only.\n' +
        '- No board UI is asserted (none exists yet); the suite drives the 3.1.6 API directly.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/workflow-flow.spec.ts` (Story 2.2.7) — the closing-E2E pattern this mirrors\n' +
        '- `tests/e2e/` harness + `tests/helpers/db.ts` — real-Postgres truncation between tests\n' +
        '- The 3.1.6 board routes under test; Story 3.5 — the Epic-3 test story this defers the UI journey to',
    },
  ],
};
