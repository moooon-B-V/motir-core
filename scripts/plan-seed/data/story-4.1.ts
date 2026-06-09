import type { PlanStory } from '../types';

/**
 * Story 4.1 — Sprint + backlog data model.
 *
 * The data substrate the rest of Epic 4 (Agile planning) is built on: the
 * `Sprint` entity (name, goal, start/end, state `planned·active·complete`), the
 * issue→sprint association (`work_item.sprint_id`), and a global backlog **rank**
 * ordering (`work_item.backlog_rank`) so the backlog (Story 4.2) and a sprint can
 * both be drag-reordered. PLUS the service-layer **state-machine RULES** for the
 * sprint lifecycle — the transition guard (`planned → active → complete`, one-way)
 * + the one-active-sprint guard — that Story 4.4's start/complete FLOWS compose.
 *
 * 📦 Pure backend — schema + repository + service + tests. **NO UI** (the Backlog
 * UI is Story 4.2; the Scrum board view is Story 4.5), so the design gate does
 * NOT fire (no UI-touching subtask). **NO external SaaS / secret** (sprints are
 * plain Postgres rows), so there is no `type: manual/human` provisioning subtask
 * (mistake #30 checked and clears).
 *
 * ── Decision: a sprint is scoped to the PROJECT, not the board (rung-1 deviation,
 * justified) ───────────────────────────────────────────────────────────────────
 * Jira ties a sprint to a board (`originBoardId`) because a Jira board is a
 * cross-project saved-filter view. In THIS product a board is a per-project READ
 * projection (Story 3.1's `Board.projectId` is a plain FK; boards never span
 * projects), so a project has a single logical sprint sequence regardless of how
 * many scrum boards (Story 3.7 lets a project have N boards) happen to view it.
 * Modelling `sprint.boardId` would force a scrum board to EXIST before any sprint
 * could be created and would split one project's backlog across boards — added
 * complexity with no real use case here. So **`sprint.projectId`** (the deviation,
 * one line of justification per the justified-deviation rule), and **"one active
 * sprint per board" (Story 4.4 stub / Story 4.5 prose) resolves to "one active
 * sprint per PROJECT"** in this model — the partial-unique guard is on
 * `(project_id) WHERE state = 'active'`. This is consistent with what the
 * consumer already left open: Story 4.5.2 deps on "4.1 … `work_item.sprintId` or a
 * join — whatever 4.1 ships" and resolves the active sprint via "WHERE
 * boardId/**projectId** AND state = active" — i.e. the projectId branch. When
 * Story 4.4 expands it targets `projectId`; a re-plan can tighten 4.5.2's
 * story-level dep on 4.1 to the exact subtasks below. The scrum board itself is
 * NOT a sprint-data concern — it is just a VIEW (created via Story 3.7 board CRUD,
 * which already ships `createBoard(projectId, { type })`; the 3.7 UI defers
 * exposing the Scrum option, a separate gap), so 4.1 does NOT provision boards.
 *
 * ── Cross-epic dependency audit (mistake #32) ───────────────────────────────────
 * Every leaf below depends only on shipped Epic-1/Epic-3 substrate (the `WorkItem`
 * model + `positioning.ts` rank helper from Epic 1; nothing from Epic 3 is even
 * required since the sprint is project-scoped) and on its own Story-4.1 siblings.
 * No `dependsOn` points forward of Epic 4 → the audit passes; 4.1 is a clean
 * leaf at the head of Epic 4's build order (its consumers 4.2 / 4.4 / 4.5 all
 * point back at it).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 4.1`. Matches the canonical
 * depth + string-literal style of Stories 3.1 / 4.5.
 */
export const story_4_1: PlanStory = {
  id: '4.1',
  title: 'Sprint + backlog data model',
  status: 'done',
  descriptionMd:
    'The **data model + service core** the whole of Epic 4 (Agile planning) rides on. Three things ship ' +
    'here, all backend: (1) the **`Sprint` entity** — `name`, `goal`, `startDate`, `endDate`, `state` ' +
    '(`planned·active·complete`), scoped to a project; (2) the **issue→sprint association** — a nullable ' +
    '`work_item.sprint_id` FK (null = the issue is in the backlog); and (3) a **global backlog rank** — ' +
    '`work_item.backlog_rank`, the single opaque fractional-index ordering (the Jira "Rank") that lets ' +
    'the backlog (Story 4.2) AND a sprint be drag-reordered off one field. On top of the rows, the ' +
    '**service-layer state-machine RULES**: the sprint transition guard (`planned → active → complete`, ' +
    'one-way — no skip, no reopen) and the **one-active-sprint-per-project** guard, both shipped + ' +
    "unit-tested HERE so Story 4.4's start/complete *flows* just compose them.\n\n" +
    '**Sprint is project-scoped (justified rung-1 deviation — see the module header).** A board in this ' +
    "product is a per-project read projection (Story 3.1), not Jira's cross-project filter view, so the " +
    'sprint hangs off `sprint.projectId` (denormalized `workspaceId` too, matching the schema-wide ' +
    'tenancy-denormalization pattern on `work_item` / `board`). "One active sprint per board" (Story 4.4 ' +
    'stub / Story 4.5 prose) therefore resolves to **one active sprint per PROJECT** — enforced by a ' +
    "PARTIAL unique index `WHERE state = 'active'` on `(project_id)`, exactly the raw-SQL pattern " +
    "`board_one_default_per_project` / `workflow_status_one_initial_per_project` already use (Prisma's " +
    "DSL can't express a filtered unique index). The backlog is the project's issues with " +
    '`sprint_id IS NULL`, in `backlog_rank` order.\n\n' +
    '**What 4.1 ships vs. what Story 4.4 ships (the clean seam).** 4.1 owns the ENTITY and the RULES: ' +
    'sprint CRUD for a *planned* sprint (create / rename / edit goal+dates / delete), the issue↔sprint ' +
    'association writes (assign to sprint / move to backlog), the backlog rank writes (rank between two ' +
    'neighbours), the bounded backlog + sprint-issue READ queries the 4.2 UI binds to, and the pure ' +
    'transition-guard helper `assertSprintTransition(from, to)`. Story **4.4** owns the lifecycle ' +
    'ORCHESTRATION that *uses* those rules: the *start* flow (scope-lock semantics, "board opens"), the ' +
    '*complete* flow (carry-over of unfinished issues back to the backlog / into the next sprint), and ' +
    'the sprint **report** — none of which ship here. 4.1 ships `assertSprintTransition` and the ' +
    'one-active guard so 4.4 composes them; 4.1 does NOT ship `startSprint` / `completeSprint` bodies ' +
    "(that would steal 4.4's scope) beyond what the guard tests need. Story **4.3** (estimation) adds " +
    'the story-point field; 4.1 does not — point roll-ups are 4.3/4.6.\n\n' +
    '**Backlog rank = one global fractional-index field, reusing `positioning.ts` (no new mechanism).** ' +
    'The rank is the SAME opaque base-62 fractional-index `String` the `work_item` / `board_column` / ' +
    '`workflow_status` / `board` positions already use (`lib/workItems/positioning.ts` — `keyForAppend` ' +
    '/ `keyForPrepend` / `keyBetween`), so a reorder is a single-row write and there is no Decimal / ' +
    'integer-renumber machinery to add. It is a **separate** ordering from `work_item.position` (which ' +
    "orders the issue TREE under its parent) — Jira's Rank is likewise orthogonal to the issue " +
    'hierarchy. New issues get a `backlog_rank` appended at creation; the migration backfills every ' +
    'existing issue deterministically by `(projectId, createdAt)` so the ordering is total from day one.\n\n' +
    "**Completeness / scale (finding #57 — plan the bounded shape now, not load-all).** A real team's " +
    'backlog is thousands of issues, so the backlog READ is **cursor-paginated in rank order** with an ' +
    'aggregate **count** (and a per-sprint committed-issue count) — never a "fetch every backlog row" ' +
    'read. The 4.2 backlog UI lazy-loads pages against this; 4.1 ships the bounded query, not a ' +
    'load-everything one. The association + rank writes are O(1) single-row writes (fractional index), ' +
    'never an N-row renumber.\n\n' +
    '**4-layer + tenancy (CLAUDE.md).** The `Sprint` FK and the `work_item.sprint_id` FK are modelled as ' +
    'Prisma `@relation`s on BOTH sides with explicit `onDelete` (so `prisma migrate dev` reports "No ' +
    'difference detected" — the FK-drift lesson, `bug-attachment-fk-migration-drift`); reads/writes are ' +
    'repository single-ops (writes require `tx`); the service owns the transactions + DTO mapping + typed ' +
    'errors; the explicit application-layer `workspaceId` gate (finding #26) covers every sprint/backlog ' +
    'read & write; the `sprint` table gets the same pure-workspace RLS policy as `board` / ' +
    '`workflow_status` (non-null `workspace_id`, every write under an active workspace context, no ' +
    'system-admin escape hatch). Sprint and association changes record a `work_item_revision` row (reuse ' +
    'the Story 1.4.6 audit trail) inside the same transaction, so the activity feed (Story 5.5) and ' +
    'reporting (Epic 6) see sprint moves for free.\n\n' +
    '**Out of scope (Epic-4 siblings / later):** the backlog + sprint-planning UI, drag-to-reorder, ' +
    'drag-into-sprint, inline estimate (Story **4.2**); story-point estimation + roll-ups (Story ' +
    '**4.3**); the start/complete lifecycle flows, scope lock, carry-over, sprint report, "board opens" ' +
    'provisioning (Story **4.4**); the Scrum board view + sprint header (Story **4.5**); velocity + ' +
    'burndown charts (Story **4.6**); a multi-value sprint *history* field on issues for reporting ' +
    '(Jira keeps one — v1 carries the single active `sprint_id` and lets the 1.4.6 revision trail record ' +
    'sprint changes; multi-sprint history is a later reporting concern); scrum-board CRUD/provisioning ' +
    '(Story 3.7 board CRUD — a view concern, not sprint data).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (applies the `add_sprint_and_backlog_rank` migration), `pnpm db:seed`, `pnpm dev`.\n' +
    '- **Migration is clean (no drift):** a second `pnpm prisma migrate dev` reports **"No difference detected"** — the `Sprint` FK and `work_item.sprint_id` FK are modelled as `@relation` on both sides (no spurious `DROP CONSTRAINT`, per `bug-attachment-fk-migration-drift`). `pnpm prisma migrate status` is up to date.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the sprint state machine + association + rank + guards stays ≥90% per-file branch/fn/line on the new service/repository files (the CI coverage gate, `prodect-core-coverage-gate`); empty-input guards on any new repo method have a direct test.\n' +
    '- **State machine:** `assertSprintTransition` allows `planned→active` and `active→complete`; rejects `planned→complete` (skip), `complete→active` / `active→planned` (reopen), and any self-transition, with the typed error.\n' +
    '- **One-active guard:** creating/activating a second `active` sprint in the same project fails on the partial-unique index (`sprint_one_active_per_project`); a different project may have its own active sprint concurrently.\n' +
    '- **Association + backlog:** assigning an issue to a sprint sets `sprint_id` and drops it from the backlog read; moving it back to the backlog nulls `sprint_id` and restores it in `backlog_rank` order; assigning an issue to a sprint in a DIFFERENT project is rejected (same-project guard).\n' +
    '- **Rank:** `backlog_rank` is the `positioning.ts` base-62 string; ranking an issue between two neighbours is a single-row write that lands it strictly between them; every pre-existing issue has a backfilled rank (the ordering is total).\n' +
    '- **Bounded read (finding #57):** the backlog query is cursor-paginated in rank order with a total count; it never selects every backlog row. `pnpm db:seed:large` (a project with thousands of backlog issues) → the backlog read returns one bounded page + the count, the rank writes stay O(1).\n' +
    '- **Tenancy:** a cross-workspace sprint/backlog read or write is denied by the finding-#26 `workspaceId` gate; the `sprint` RLS policy rejects access outside the active workspace context.\n' +
    '- **Audit:** assigning/removing a sprint or reranking writes a `work_item_revision` row in the same transaction (visible to the Story 5.5 activity feed).',
  items: [
    {
      id: '4.1.1',
      title:
        'Schema + migration — `Sprint` model + `SprintState` enum + `work_item.sprint_id` / `backlog_rank`, one-active-per-project partial-unique index, RLS, rank backfill',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: [],
      descriptionMd:
        'Add the persistence layer for sprints + the backlog rank, as ONE Prisma migration, modelled so ' +
        '`prisma migrate dev` is drift-free.\n\n' +
        '**`Sprint` model** (`@@map("sprint")`): `id` (cuid), `workspaceId @map("workspace_id")` + ' +
        '`projectId @map("project_id")` (the project the sprint belongs to — see the module-header ' +
        'scope decision; denormalized `workspaceId` matches `board` / `work_item`), `name` (String, ' +
        'required — default-named "Sprint N" by the service via `sequence`), `goal` (String? `@db.Text`, ' +
        'the sprint goal), `state SprintState @default(planned)`, `startDate DateTime?` + `endDate ' +
        'DateTime?` (the sprint window — nullable on a planned sprint, set/edited by the service; Story ' +
        '4.4 stamps them on *start*), `completedAt DateTime?` (set by 4.4 on *complete*), `sequence Int` ' +
        '(per-project monotonic ordinal for the default name + stable listing), `createdAt` / ' +
        '`updatedAt`. Relations: `workspace`/`project` (`onDelete: Cascade`, like `board`); a ' +
        '`workItems WorkItem[]` back-relation. Indexes: `@@index([workspaceId])`, ' +
        "`@@index([projectId, state])` (resolve the active sprint + list a project's sprints).\n\n" +
        '**`SprintState` enum** (`@@map("sprint_state")`): `planned`, `active`, `complete` — matching the ' +
        "plan's vocabulary (Jira API's future/active/closed). Values exist now so Story 4.4 adds no enum " +
        'ALTER.\n\n' +
        '**`WorkItem` additions:** `sprintId String? @map("sprint_id")` + a `sprint Sprint? @relation(fields: ' +
        '[sprintId], references: [id], onDelete: SetNull)` — **`SetNull`** so deleting/clearing a sprint ' +
        'NEVER deletes issues (they fall back to the backlog); and `backlogRank String? @db.Text ' +
        '@map("backlog_rank")` — the global fractional-index rank (the same `positioning.ts` base-62 ' +
        'string the other `position` columns use; SEPARATE from `work_item.position`, which orders the ' +
        'tree). Index `@@index([projectId, sprintId, backlogRank])` to serve both the backlog read ' +
        "(`sprintId IS NULL`, rank order) and a sprint's ranked issues off one composite.\n\n" +
        '**Both FK sides modelled (CLAUDE.md FK rule + `bug-attachment-fk-migration-drift`):** the ' +
        '`Sprint.workItems` ↔ `WorkItem.sprint` relation is declared on BOTH sides with the explicit ' +
        '`onDelete: SetNull`, so the generated migration matches `schema.prisma` and a re-run reports "No ' +
        'difference detected" (no raw-SQL-only FK, no spurious `DROP CONSTRAINT` on the next migrate).\n\n' +
        "**Raw-SQL tail of the migration** (Prisma DSL can't express these — same pattern as the 3.1 / " +
        '3.7 board migrations):\n' +
        '- **One-active-per-project partial-unique index** `sprint_one_active_per_project`: `CREATE ' +
        "UNIQUE INDEX … ON sprint (project_id) WHERE state = 'active'` — the data-layer guard behind " +
        '"one active sprint per project" (mirrors `board_one_default_per_project`).\n' +
        '- **RLS policy** on `sprint`: the pure-workspace gate (non-null `workspace_id`, every ' +
        'read/write under the active workspace context), copied from the `board` / `workflow_status` ' +
        'policy — NO system-admin escape hatch.\n' +
        '- **Backlog-rank backfill:** assign every existing `work_item` a `backlog_rank` deterministically ' +
        'in `(project_id, created_at, id)` order (monotonic base-62 keys, the same scheme ' +
        '`positioning.ts` emits) so the ordering is total immediately. Leave the column nullable (new ' +
        'issues get a rank at creation in 4.1.4); the backfill makes the existing set total.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `schema.prisma` gains the `Sprint` model + `SprintState` enum + the `work_item.sprint_id` / `backlog_rank` columns and indexes described above; the `Sprint.workItems ↔ WorkItem.sprint` FK is modelled on BOTH sides with `onDelete: SetNull`.\n' +
        '- One migration `add_sprint_and_backlog_rank` creates the table, enum, columns, indexes, the `sprint_one_active_per_project` PARTIAL unique index, the `sprint` RLS policy, and the `backlog_rank` backfill. `pnpm prisma migrate dev` applies cleanly and a SECOND run reports **"No difference detected"** (no FK drift).\n' +
        '- The partial-unique index rejects a second `active` sprint in the same project but allows one active sprint per project across different projects; the backfill leaves every pre-existing issue with a non-null `backlog_rank`.\n' +
        '- `pnpm prisma generate` + `pnpm typecheck` + `pnpm build` pass; no other model changes.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` `model WorkItem` (lines ~299), `model Board` + `enum BoardType` (~607) — the tenancy-denormalization + partial-unique (`board_one_default_per_project`) + RLS patterns to mirror\n' +
        '- `prisma/sql/*` board/workflow_status migrations — the raw-SQL partial-unique-index + RLS-policy precedents to copy\n' +
        '- `lib/workItems/positioning.ts` — the base-62 fractional-index scheme the backfill emits (so new ranks interleave with backfilled ones)\n' +
        '- `prodect-core/CLAUDE.md` (FK-as-`@relation` on both sides; the migration FK-drift rule) + the `bug-attachment-fk-migration-drift` precedent\n' +
        '- Jira sprint states (future/active/closed) as the mirror for `planned/active/complete`',
    },
    {
      id: '4.1.2',
      title:
        '`sprintRepository` + `work_item` sprint/rank repo methods (single-op; writes require `tx`)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['4.1.1'],
      descriptionMd:
        'The data-access leaf for sprints + the backlog rank, per the 4-layer rule (each method one Prisma ' +
        'op; no business logic, no transactions; writes take a required `tx: Prisma.TransactionClient`; ' +
        'reads used inside a write-guarding transaction take `tx` + `SELECT … FOR UPDATE` where a ' +
        'concurrent write could race).\n\n' +
        '**`sprintRepository`** (`lib/repositories/sprintRepository.ts`): `create(data, tx)`, ' +
        '`update(id, data, tx)`, `delete(id, tx)`, `findById(id)`, `findActiveByProject(projectId)` (the ' +
        'single `state == active` row — reads `tx` + `FOR UPDATE` in the variant the activation guard ' +
        'uses), `listByProject(projectId)` (ordered by `sequence` / `state`), `countByProjectAndState` / ' +
        '`maxSequenceForProject(projectId)` (for the next default name). NO cross-repo calls (repos are ' +
        'leaves).\n\n' +
        '**`work_item` sprint/rank methods** — extend `workItemRepository` (the entity owns them, not a ' +
        'new repo): `setSprint(itemId, sprintId | null, tx)` (the association write), `setBacklogRank(itemId, ' +
        'rank, tx)`, and the bounded reads `findBacklogPage(projectId, { cursor, limit }, ...)` ' +
        '(`sprint_id IS NULL`, `backlog_rank` order, `limit+1` for the next-cursor) + ' +
        '`countBacklog(projectId)` + `findSprintIssues(sprintId)` / `countSprintIssues(sprintId)` + the ' +
        '`findRankNeighbours`/boundary reads `rankIssue` needs (the prev/next `backlog_rank` around a ' +
        'target). Each is a single Prisma op (`$queryRaw` only where a grouped/aggregate read needs it).\n\n' +
        '**Empty-input guards** (the `prodect-core-coverage-gate` lesson): any method that can be called ' +
        'with an empty id list / null cursor short-circuits with a direct unit test so the per-file ' +
        'branch-coverage gate stays green.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `sprintRepository` exposes the create/update/delete + findById/findActiveByProject/listByProject/count/maxSequence methods; write methods require `tx`; `findActiveByProject` has a `FOR UPDATE` variant for the activation guard path.\n' +
        '- `workItemRepository` gains `setSprint`, `setBacklogRank`, the cursor-paginated `findBacklogPage` + `countBacklog`, `findSprintIssues` + `countSprintIssues`, and the rank-neighbour reads — each a single Prisma op; writes require `tx`.\n' +
        '- No repository method calls another repository or opens a transaction; aggregates/raw reads use `$queryRaw`. Empty-input guards are directly unit-tested.\n' +
        "- `pnpm typecheck` passes; methods return Prisma rows (mapping is the service's job).\n\n" +
        '## Context refs\n\n' +
        '- `lib/repositories/boardRepository.ts` / `workItemRepository.ts` — the single-op + required-`tx` + `$queryRaw`-aggregate patterns to mirror; where the `work_item` sprint/rank methods land\n' +
        '- `lib/workItems/positioning.ts` — `keyBetween` (the service computes the rank; the repo just persists it)\n' +
        '- `prodect-core/CLAUDE.md` (repository layer rules; entity-name-wins for method placement) + `prodect-core-coverage-gate` (empty-input-guard tests)',
    },
    {
      id: '4.1.3',
      title:
        '`sprintsService` — sprint CRUD + `assertSprintTransition` state-machine guard + DTOs/errors',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['4.1.2'],
      descriptionMd:
        'The business-logic layer for the sprint ENTITY + the state-machine RULES (Story 4.4 composes the ' +
        'rules into its start/complete flows — they are NOT implemented here).\n\n' +
        '**`sprintsService`** (`lib/services/sprintsService.ts`) — one method = one transaction, owns DTO ' +
        'mapping (`lib/mappers/sprintMappers.ts` → `lib/dto/sprints.ts`), throws typed errors ' +
        '(`lib/sprints/errors.ts`) the route layer maps to status codes, and enforces the finding-#26 ' +
        'application-layer `workspaceId` gate on every read/write:\n' +
        '- `createSprint(projectId, { name?, goal?, startDate?, endDate? })` — creates a **planned** ' +
        'sprint; default-names it `"Sprint <maxSequence+1>"` when `name` is omitted; validates the date ' +
        'window (`endDate` ≥ `startDate` when both given). Does NOT start it.\n' +
        '- `updateSprint(id, patch)` — rename / edit goal / adjust the planned window. Date/name validation; ' +
        'rejects editing a `complete` sprint.\n' +
        '- `deleteSprint(id)` — deletes a `planned` (or `complete`) sprint; its issues fall back to the ' +
        'backlog via the `onDelete: SetNull` FK (their `backlog_rank` already exists, so they re-appear in ' +
        "rank order). Rejects deleting the `active` sprint (that goes through 4.4's complete flow).\n" +
        '- **`assertSprintTransition(from: SprintState, to: SprintState)`** — the PURE state-machine guard: ' +
        'allows `planned→active` and `active→complete`; throws `InvalidSprintTransitionError` for skips ' +
        '(`planned→complete`), reopens (`complete→active`, `active→planned`), and self-transitions. ' +
        "Exported as a pure function so Story 4.4's start/complete flows + the one-active guard call it " +
        'without re-deriving the rules. (4.1 ships + tests the guard; 4.4 owns the orchestration that ' +
        'consumes it — scope-lock, carry-over, report.)\n' +
        '- Mappers return a `SprintDto` (`id, name, goal, state, startDate, endDate, completedAt, ' +
        'sequence, issueCount`) — never a raw Prisma model.\n\n' +
        '**Typed errors** (`lib/sprints/errors.ts`): `SprintNotFoundError`, `InvalidSprintTransitionError`, ' +
        '`SprintWindowInvalidError`, `CannotModifyCompletedSprintError`, `CannotDeleteActiveSprintError` — ' +
        'distinct codes so the (future) route layer maps them to 404/409/422.\n\n' +
        '**Routes** are minimal here (CRUD endpoints `POST/PATCH/DELETE /api/sprints`) — HTTP-only, one ' +
        'service call each, error→status mapping; the rich sprint-planning surface is Story 4.2.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `sprintsService` exposes `createSprint` (planned, default-named, window-validated), `updateSprint`, `deleteSprint` (issues fall to backlog; active rejected), and the pure exported `assertSprintTransition`; each write is one transaction; reads/writes enforce the finding-#26 `workspaceId` gate; methods return `SprintDto`s.\n' +
        '- `assertSprintTransition` allows `planned→active` + `active→complete` and throws `InvalidSprintTransitionError` for every skip/reopen/self transition; it is a pure function (no I/O) Story 4.4 can import.\n' +
        '- Typed errors live in `lib/sprints/errors.ts`; the CRUD routes are HTTP-only (one service call + error mapping each).\n' +
        '- `pnpm test:coverage` keeps the new service file ≥90% branch/fn/line (the coverage gate); start/complete ORCHESTRATION is explicitly absent (deferred to Story 4.4).\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/boardsService.ts` (3.1/3.7) — the service shape to mirror (one-tx-per-method, DTO mapping, `workspaceId` gate); `lib/mappers/*`, `lib/dto/*`, `lib/<domain>/errors.ts` layout\n' +
        '- Story 4.4 (sprint lifecycle) — the consumer of `assertSprintTransition` + the one-active guard; Story 4.2 (backlog UI) — the consumer of the CRUD + DTOs\n' +
        '- `prodect-core/CLAUDE.md` (service layer: transactions, DTOs, typed errors) + `prodect-core-coverage-gate`',
    },
    {
      id: '4.1.4',
      title:
        'Issue↔sprint association + backlog rank ordering + bounded backlog/sprint read API (the data layer Story 4.2 binds to)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['4.1.3'],
      descriptionMd:
        'The association + ranking + read API that powers the Story-4.2 backlog UI — the part of the "data ' +
        'model" that moves issues between the backlog and sprints and orders them, built to real-product ' +
        'SCALE (finding #57).\n\n' +
        '**Association writes** (in `sprintsService`, or a focused `backlogService` if cleaner — same ' +
        '4-layer rules):\n' +
        '- `assignToSprint(itemId, sprintId, { rank? })` — set `work_item.sprint_id`; **same-project ' +
        'guard**: the sprint and the issue MUST share a project (throw `CrossProjectSprintAssignmentError` ' +
        'otherwise). Optionally place it at a rank within the sprint.\n' +
        '- `moveToBacklog(itemId)` — null `sprint_id`; the issue re-appears in the backlog in its existing ' +
        '`backlog_rank` order.\n' +
        '- `rankIssue(itemId, { beforeId? , afterId? })` — compute the new `backlog_rank` via ' +
        '`positioning.ts` `keyBetween(prevRank, nextRank)` and write the SINGLE row (no N-row renumber). ' +
        'Works for both a backlog issue and an issue within a sprint (one global rank field). Guards the ' +
        'degenerate "no neighbours" (append/prepend) cases.\n' +
        '- **Create-time rank:** new issues get a `backlog_rank` appended (`keyForAppend`) when created — ' +
        'wire this into the issue-create path (`workItemsService.create`) so the backfill (4.1.1) stays ' +
        'total going forward. Keep the touch on the create path minimal.\n' +
        '- Every association/rank write records a `work_item_revision` row (reuse the 1.4.6 audit ' +
        'service) in the SAME transaction.\n\n' +
        '**Bounded reads** (the finding-#57 shape):\n' +
        '- `getBacklog(projectId, { cursor?, limit })` → `{ items: WorkItemSummaryDto[], nextCursor, ' +
        'totalCount }` — `sprint_id IS NULL`, `backlog_rank` order, cursor-paginated (NEVER load-all), ' +
        'with the aggregate count for the "N issues" header.\n' +
        "- `getSprintIssues(sprintId)` → the sprint's ranked issues (+ count) for the planning view; bounded " +
        'the same way (a sprint is smaller, but the read is still paged-capable, not unbounded).\n' +
        'Routes: `POST /api/work-items/[id]/sprint` (assign/clear), `POST /api/work-items/[id]/rank`, `GET ' +
        '/api/projects/[id]/backlog` — HTTP-only, one service call each. Mapping via ' +
        '`lib/mappers/*`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `assignToSprint` (same-project guarded), `moveToBacklog`, and `rankIssue` (single-row ' +
        '`keyBetween` write, append/prepend edge cases handled) exist, own their transaction, record a 1.4.6 revision, and enforce the `workspaceId` gate.\n' +
        '- New issues receive a `backlog_rank` at creation (the create path appends one); cross-project sprint assignment is rejected with the typed error.\n' +
        "- `getBacklog` is cursor-paginated in rank order with a total count and never selects every row; `getSprintIssues` returns the sprint's ranked issues + count; both return DTOs.\n" +
        '- `pnpm db:seed:large` → the backlog read returns one bounded page + the count and rank writes stay O(1) (finding #57); routes are HTTP-only one-service-call handlers.\n' +
        '- `pnpm test:coverage` keeps the new files ≥90% branch/fn/line.\n\n' +
        '## Context refs\n\n' +
        '- Story 4.1.2 (`work_item` sprint/rank repo methods) + 4.1.3 (`sprintsService` + DTOs/errors) — the layers this composes\n' +
        '- `lib/workItems/positioning.ts` (`keyBetween` / `keyForAppend` / `keyForPrepend`) — the single-row rank computation\n' +
        '- `lib/services/workItemsService.ts` + the 1.4.6 `workItemRevisionsService` — the create path to append the rank into + the audit-trail write to reuse\n' +
        '- Story 4.2 (backlog UI) — the consumer of `getBacklog` / `assignToSprint` / `rankIssue`; finding #57 (bounded reads); finding #26 (`workspaceId` gate); `prodect-core/CLAUDE.md`',
    },
    {
      id: '4.1.5',
      title:
        'Tests — sprint state machine, one-active guard, association + same-project guard, rank ordering, bounded backlog at scale',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['4.1.3', '4.1.4'],
      descriptionMd:
        'The closing test subtask — Vitest over the real Postgres (the project convention: no mocks except ' +
        '`getSession`; `tests/helpers/db.ts` truncation), proving the data model + rules the rest of Epic 4 ' +
        'depends on. No UI/E2E here (4.1 has no UI; the sprint E2E rides Story 4.5.4 once a board renders ' +
        'sprints).\n\n' +
        '**State machine + guards:** `assertSprintTransition` accepts `planned→active` + `active→complete` ' +
        'and rejects every skip/reopen/self transition; the `sprint_one_active_per_project` partial-unique ' +
        'index rejects a second active sprint in a project (DB-level, asserted via the repository) while ' +
        'allowing one active sprint per project across two projects; `createSprint` default-naming + ' +
        'window validation; `deleteSprint` drops a planned sprint and its issues fall to the backlog ' +
        '(`SetNull`), and refuses the active sprint.\n\n' +
        '**Association + rank:** `assignToSprint` sets `sprint_id` and removes the issue from the backlog ' +
        'read; the same-project guard rejects a cross-project assignment; `moveToBacklog` restores it in ' +
        'rank order; `rankIssue` lands an issue strictly between two neighbours with a SINGLE-row write ' +
        "(assert no other row's rank changed) and handles append/prepend; new issues get a `backlog_rank` " +
        'at creation; each write records a 1.4.6 revision row.\n\n' +
        '**Bounded reads (finding #57):** `getBacklog` is cursor-paginated in `backlog_rank` order and ' +
        'returns the total count; seed a large backlog and assert the read returns ONE bounded page (not ' +
        'every row) and the cursor walks the full ordering deterministically; the rank writes stay O(1) on ' +
        'the large set.\n\n' +
        '**Tenancy:** a cross-workspace sprint/backlog read or write is denied by the finding-#26 gate.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` (real Postgres) covers: the transition guard (all legal + illegal pairs), the one-active-per-project index (rejects 2nd active in a project; allows per-project), create-default-naming + window validation, delete-to-backlog + active-delete refusal, association + same-project guard, `moveToBacklog`, single-row `rankIssue` (append/prepend + between), create-time rank, the 1.4.6 revision writes, and the cross-workspace denial.\n' +
        '- A scale test (seeded large backlog) asserts `getBacklog` returns one bounded page + the total count (never load-all) and the cursor walks the whole rank order; rank writes are O(1).\n' +
        '- `pnpm test:coverage` keeps the Story-4.1 service/repository files ≥90% branch/fn/line (the CI coverage gate); the suite uses the real-Postgres harness + the single allowed `getSession` mock.\n\n' +
        '## Context refs\n\n' +
        '- `tests/helpers/db.ts` — real-Postgres truncation harness + the large-seed fixture pattern\n' +
        '- Story 4.1.3 (service + guard) + 4.1.4 (association + rank + bounded reads) — the units under test\n' +
        '- `prodect-core-coverage-gate` (≥90% per-file; empty-input guards need a direct test) + `prodect-core-local-postgres` (the sandbox already has PG@5433) + `prodect-core/CLAUDE.md` (real-Postgres, no mocks)\n' +
        '- Story 4.5.4 — where the sprint-rendering E2E lives (4.1 ships no UI, so no E2E here)',
    },
  ],
};
