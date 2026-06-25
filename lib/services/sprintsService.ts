import { Prisma, type SprintState } from '@prisma/client';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { sprintReportEntryRepository } from '@/lib/repositories/sprintReportEntryRepository';
import { boardsService } from '@/lib/services/boardsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { estimationService } from '@/lib/services/estimationService';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { keyForAppend } from '@/lib/workItems/positioning';
import { toSprintDto, toSprintReportDto, toSprintReportPage } from '@/lib/mappers/sprintMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  CarryOverDestination,
  CompleteSprintInput,
  CreateSprintInput,
  GetSprintReportOptions,
  SprintBlockerDto,
  SprintDto,
  SprintReportDto,
  SprintValidityDto,
  StartSprintInput,
  UpdateSprintInput,
} from '@/lib/dto/sprints';
import {
  CannotDeleteActiveSprintError,
  CannotModifyCompletedSprintError,
  InvalidCarryOverTargetError,
  InvalidSprintNameError,
  InvalidSprintTransitionError,
  NoActiveSprintError,
  NotSprintAdminError,
  SprintAlreadyActiveError,
  SprintNotCompletableError,
  SprintNotFoundError,
  SprintNotStartableError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';

// Sprints service (Story 4.1 · Subtask 4.1.3) — business logic for the sprint
// ENTITY plus the state-machine RULES. It owns:
//   * sprint CRUD for a *planned* (or *complete*) sprint — create / update /
//     delete (the lifecycle ORCHESTRATION — start / complete, scope-lock,
//     carry-over, report — is Story 4.4 and is NOT implemented here);
//   * `assertSprintTransition` — the PURE one-way state-machine guard, exported
//     as a free function so Story 4.4's start/complete flows + the one-active
//     guard import the rule rather than re-deriving it.
//
// 4-layer (CLAUDE.md): one service method = one transaction; every write runs
// under `withWorkspaceContext` so the FORCE-RLS WITH CHECK on `sprint` passes
// under the non-bypass `prodect_app` role; repositories are single-op leaves;
// methods return `SprintDto`s, never raw Prisma rows.
//
// TENANCY (finding #26): every repo read/write carries an explicit
// `workspaceId`; the `sprint` RLS policy is the structural backstop, inert under
// the dev/CI BYPASSRLS superuser, so the application-layer gate is primary. A
// sprint outside the active workspace is a 404 (no existence leak).
//
// AUTHORIZATION: sprint management is owner-gated today (finding #36; TODO(6.4)
// widens the role-set), EXACTLY mirroring `boardsService.assertBoardConfigAdmin`
// — managing sprints is project-planning config, the same tier as the board /
// workflow editors, and Jira gates it to admins (decision-ladder rung 1). The
// gate also asserts the project belongs to the workspace, so a foreign
// projectId 404s before any membership probe.

export const sprintsService = {
  /**
   * Create a PLANNED sprint on a project. Default-names it `"Sprint <n>"`
   * (`maxSequence + 1`) when `name` is omitted, and stamps that ordinal on
   * `sequence`. Validates the date window (both dates parse; `endDate` ≥
   * `startDate` when both given). Does NOT start the sprint — activation is
   * Story 4.4. Returns the new sprint's DTO (`issueCount` 0).
   *
   * Throws: `ProjectNotFoundError` (404 — unknown / cross-workspace project),
   * `NotSprintAdminError` (403), `InvalidSprintNameError` (400),
   * `SprintWindowInvalidError` (422).
   */
  async createSprint(
    projectId: string,
    input: CreateSprintInput,
    ctx: ServiceContext,
  ): Promise<SprintDto> {
    await assertSprintAdmin(ctx.userId, projectId, ctx.workspaceId);

    const name = input.name !== undefined ? validateName(input.name) : undefined;
    const startDate = parseNullableDate(input.startDate);
    const endDate = parseNullableDate(input.endDate);
    assertWindow(startDate ?? null, endDate ?? null);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const sequence =
          (await sprintRepository.maxSequenceForProject(projectId, ctx.workspaceId, tx)) + 1;
        return sprintRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId,
            name: name ?? `Sprint ${sequence}`,
            goal: input.goal ?? null,
            state: 'planned',
            startDate: startDate ?? null,
            endDate: endDate ?? null,
            sequence,
          },
          tx,
        );
      },
    );
    return toSprintDto(row, 0);
  },

  /**
   * The project's single `active` sprint as a DTO, or `null` when none is active
   * (the `sprint_one_active_per_project` partial-unique index guarantees AT MOST
   * one). The `claim_next_ready` dispatch path resolves the active sprint through
   * this before claiming; a `null` here is the "no active sprint — run `motir
   * plan sprint`" signal. A pure read — no admin gate (reading the active sprint
   * is not a mutation; the same workspace tenancy the repo enforces applies).
   */
  async getActiveSprint(projectId: string, ctx: ServiceContext): Promise<SprintDto | null> {
    const row = await sprintRepository.findActiveByProject(projectId, ctx.workspaceId);
    return row ? toSprintDto(row, 0) : null;
  },

  /**
   * Is a sprint FINISHABLE? (Subtask 7.8.15) — the productized form of the
   * *re-validate-the-active-sprint* rule (`motir-meta` `plan-rules.md` #94). A
   * sprint is VALID ⟺ for EVERY in-sprint, NOT-done item, its ENTIRE transitive
   * `blocked_by` closure is `done` OR also in the SAME sprint — walking the
   * parent chain's blockers too (readiness cascades DOWN the hierarchy: a child
   * inherits its ancestors' blockers). When `sprintId` is `null` the project's
   * ACTIVE sprint is validated; an explicit id validates that sprint. The
   * transitive closure is realized WITHOUT a recursive blocker walk: iterating
   * over every not-done member and checking its own ∪ ancestors' direct blockers
   * catches the whole chain, because a blocker that is itself in-sprint is
   * checked as its OWN member, a `done` blocker terminates the path, and an
   * out-of-sprint, not-done blocker is the violation we report at the nearest
   * in-sprint item it gates. ARCHIVED items (and archived blockers) are ignored.
   *
   * A pure READ — no admin gate (mirroring `getActiveSprint` / `listByProject`;
   * the owner gate guards sprint MANAGEMENT writes, not reads), `workspaceId`-
   * gated throughout (finding #26). "Done" is the per-project terminal set
   * (`category = 'done'`, so `done`/`cancelled`/any custom terminal count;
   * finding #21), judged against each blocker's OWN project (blocks can be
   * cross-project). Returns `{ valid: true, blockers: [] }` when finishable;
   * otherwise `valid: false` + one `SprintBlockerDto` per (in-sprint item,
   * out-of-sprint not-done blocker) pair — the exact set a caller surfaces as
   * "pull these blockers in, or move the gated items to the backlog".
   *
   * Throws: `NoActiveSprintError` (409 — `sprintId` null + no active sprint),
   * `SprintNotFoundError` (404 — unknown / cross-workspace `sprintId`).
   */
  async validateSprint(
    projectId: string,
    sprintId: string | null,
    ctx: ServiceContext,
  ): Promise<SprintValidityDto> {
    const sprint =
      sprintId === null
        ? await sprintRepository.findActiveByProject(projectId, ctx.workspaceId)
        : await sprintRepository.findById(sprintId, ctx.workspaceId);
    if (!sprint) {
      if (sprintId === null) throw new NoActiveSprintError(projectId);
      throw new SprintNotFoundError(sprintId);
    }
    return computeSprintValidity(sprint.id, sprint.projectId, ctx);
  },

  /**
   * Update a sprint's editable metadata — rename, edit goal, adjust the planned
   * window. An undefined field is left unchanged; an explicit `null` clears
   * `goal` / a date. The effective window (the patch merged over the current
   * row) is validated. A `complete` sprint is frozen (`CannotModifyCompletedSprintError`);
   * an `active` sprint's goal/window may still be edited (Jira-faithful).
   *
   * Throws: `SprintNotFoundError` (404), `NotSprintAdminError` (403),
   * `CannotModifyCompletedSprintError` (409), `InvalidSprintNameError` (400),
   * `SprintWindowInvalidError` (422).
   */
  async updateSprint(
    id: string,
    patch: UpdateSprintInput,
    ctx: ServiceContext,
  ): Promise<SprintDto> {
    const existing = await sprintRepository.findById(id, ctx.workspaceId);
    if (!existing) throw new SprintNotFoundError(id);
    await assertSprintAdmin(ctx.userId, existing.projectId, ctx.workspaceId);
    if (existing.state === 'complete') throw new CannotModifyCompletedSprintError(id);

    const data: Prisma.SprintUncheckedUpdateInput = {};
    if (patch.name !== undefined) data.name = validateName(patch.name);
    if (patch.goal !== undefined) data.goal = patch.goal;

    const newStart = parseNullableDate(patch.startDate);
    const newEnd = parseNullableDate(patch.endDate);
    if (newStart !== undefined) data.startDate = newStart;
    if (newEnd !== undefined) data.endDate = newEnd;

    // Validate the EFFECTIVE window: a date the patch doesn't touch falls back
    // to the existing row's value, so editing only one endpoint still checks
    // against the other.
    const effectiveStart = newStart !== undefined ? newStart : existing.startDate;
    const effectiveEnd = newEnd !== undefined ? newEnd : existing.endDate;
    assertWindow(effectiveStart, effectiveEnd);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => sprintRepository.update(id, data, tx),
    );
    const issueCount = await workItemRepository.countSprintIssues(id, ctx.workspaceId);
    return toSprintDto(row, issueCount);
  },

  /**
   * Delete a `planned` or `complete` sprint. Its issues are NEVER deleted — the
   * `work_item.sprint_id` FK is `onDelete: SetNull`, so they fall back to the
   * backlog in their existing `backlogRank` order (4.1.1). The `active` sprint
   * cannot be deleted (`CannotDeleteActiveSprintError`); ending it goes through
   * Story 4.4's complete flow.
   *
   * Throws: `SprintNotFoundError` (404), `NotSprintAdminError` (403),
   * `CannotDeleteActiveSprintError` (409).
   */
  async deleteSprint(id: string, ctx: ServiceContext): Promise<void> {
    const existing = await sprintRepository.findById(id, ctx.workspaceId);
    if (!existing) throw new SprintNotFoundError(id);
    await assertSprintAdmin(ctx.userId, existing.projectId, ctx.workspaceId);
    if (existing.state === 'active') throw new CannotDeleteActiveSprintError(id);

    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, (tx) =>
      sprintRepository.delete(id, tx),
    );
  },

  /**
   * List a project's sprints in `sequence` order, each with its committed
   * (non-archived) issue count — the read the Story-4.2 sprint-planning view
   * binds to (the 4.1.4 `getBacklog` / `getSprintIssues` reads cover the rows;
   * this covers the sprint headers). A pure read: no transaction, the repo
   * leaves use the `db` singleton (CLAUDE.md). Tenant-gated by `workspaceId`
   * (finding #26) — `listByProject` filters on it, so a foreign project simply
   * returns an empty list, never another workspace's sprints.
   *
   * Available to any project member (everyday planning), like the backlog
   * reads — NOT owner-gated (the owner gate guards sprint MANAGEMENT writes,
   * not reads). The sprint count per project is small + bounded, so the
   * per-sprint count read is a bounded fan-out, not an unbounded scan.
   *
   * NB: this exposes the already-shipped `sprintRepository.listByProject` leaf
   * (Story 4.1) through the service + a `GET /api/sprints` route — the read
   * surface the 4.2.3 card directs the backlog UI to consume; 4.1 shipped the
   * repo read but not its service/HTTP binding.
   */
  async listByProject(projectId: string, ctx: ServiceContext): Promise<SprintDto[]> {
    const rows = await sprintRepository.listByProject(projectId, ctx.workspaceId);
    return Promise.all(
      rows.map(async (row) =>
        toSprintDto(row, await workItemRepository.countSprintIssues(row.id, ctx.workspaceId)),
      ),
    );
  },

  /**
   * START a planned sprint (Story 4.4 · Subtask 4.4.2) — the head of the sprint
   * lifecycle. Composes Story 4.1's pure `assertSprintTransition` + the
   * one-active-per-project guard, stamps the window + the immutable scope-lock
   * baseline (the "Committed" line — issue count + `SUM(storyPoints)` at
   * activation), makes "the board open" by ensuring the project has a `scrum`
   * board, and flips the sprint to `active`. The complete flow + report are
   * Subtasks 4.4.3 / 4.4.4 and are NOT here.
   *
   * `startDate` defaults to now; `endDate` (optional) is validated `≥ startDate`;
   * an optional `name` renames the sprint on start (the Jira start dialog), and
   * an optional `goal` edits the sprint goal IN THE SAME activation transaction
   * (Story 4.4.8 / finding #68 — so Start is one atomic write, never a separate
   * pre-start PATCH; `undefined` leaves it unchanged, an explicit `null` clears
   * it). The baseline is computed from the sprint's CURRENT issues and never
   * mutated.
   *
   * Concurrency: the friendly `findActiveByProject` pre-check 409s early (before
   * a board is provisioned, so the common already-running case leaves no orphan
   * board); the AUTHORITATIVE guard is the `FOR UPDATE` lock on the project's
   * active sprint INSIDE the activation transaction (TOCTOU close), with the
   * `sprint_one_active_per_project` partial-unique index as the DB backstop.
   *
   * Throws: `SprintNotFoundError` (404), `NotSprintAdminError` (403),
   * `SprintNotStartableError` (422 — not `planned`), `InvalidSprintNameError`
   * (400), `SprintWindowInvalidError` (422), `SprintAlreadyActiveError` (409).
   */
  async startSprint(id: string, input: StartSprintInput, ctx: ServiceContext): Promise<SprintDto> {
    const existing = await sprintRepository.findById(id, ctx.workspaceId);
    if (!existing) throw new SprintNotFoundError(id);
    await assertSprintAdmin(ctx.userId, existing.projectId, ctx.workspaceId);

    // Only a PLANNED sprint is startable — the friendly surface over the pure
    // one-way `assertSprintTransition(planned → active)` rule, which is still
    // composed below as the single source of the transition law.
    if (existing.state !== 'planned') throw new SprintNotStartableError(id, existing.state);
    assertSprintTransition(existing.state, 'active');

    const name = input.name !== undefined ? validateName(input.name) : undefined;
    const startDate = parseNullableDate(input.startDate) ?? new Date();
    const endDate = parseNullableDate(input.endDate) ?? null;
    assertWindow(startDate, endDate);

    // Friendly pre-check: 409 BEFORE provisioning a board, so the common
    // "another sprint is already running" case never leaves an orphan board.
    const alreadyActive = await sprintRepository.findActiveByProject(
      existing.projectId,
      ctx.workspaceId,
    );
    if (alreadyActive) throw new SprintAlreadyActiveError(existing.projectId, alreadyActive.id);

    // "Board opens" — ensure the project has a scrum board to view the sprint.
    // Idempotent (only create when none exists). A service calling a service is
    // allowed; `createBoard` owns its own transaction + seeds default columns
    // (3.7.3). Intentionally NOT inside the activation transaction — board
    // provisioning is independent + idempotent, not part of the atomic flip.
    const boards = await boardsService.listBoards(existing.projectId, ctx);
    if (!boards.some((b) => b.type === 'scrum')) {
      await boardsService.createBoard(
        existing.projectId,
        { name: 'Sprint board', type: 'scrum' },
        ctx,
      );
    }

    const result = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // Authoritative one-active guard: lock the project's active sprint row
        // FOR UPDATE so two concurrent starts serialize; a winner that committed
        // between the pre-check and here is caught (the partial-unique index is
        // the final backstop).
        const locked = await sprintRepository.findActiveByProjectForUpdate(
          existing.projectId,
          ctx.workspaceId,
          tx,
        );
        if (locked) throw new SprintAlreadyActiveError(existing.projectId, locked.id);

        // Scope-lock baseline from the sprint's CURRENT issues (immutable after).
        const committedIssueCount = await workItemRepository.countSprintIssues(
          id,
          ctx.workspaceId,
          undefined,
          tx,
        );
        const committedPoints = await workItemRepository.sumStoryPointsForSprint(
          id,
          ctx.workspaceId,
          tx,
        );

        const data: Prisma.SprintUncheckedUpdateInput = {
          state: 'active',
          startDate,
          endDate,
          committedIssueCount,
          committedPoints,
        };
        if (name !== undefined) data.name = name;
        // Stamp the goal in-transaction when supplied (finding #68): the start
        // dialog edits it inline, so it is part of the atomic activation, not a
        // separate PATCH. `undefined` leaves it unchanged; `null` clears it.
        if (input.goal !== undefined) data.goal = input.goal;

        const row = await sprintRepository.update(id, data, tx);
        return { row, committedIssueCount };
      },
    );
    return toSprintDto(result.row, result.committedIssueCount);
  },

  /**
   * COMPLETE an active sprint (Story 4.4 · Subtask 4.4.3) — the close half of
   * the lifecycle. Composes Story 4.1's pure `assertSprintTransition(active →
   * complete)`, carries the sprint's UNFINISHED issues to a destination (the
   * backlog or another planned sprint), leaves the DONE issues on the completed
   * sprint as its historical record, stamps `completedAt`, and flips the state
   * to `complete` — freeing the project's one-active slot so the next sprint can
   * start. The whole carry-over + close is ONE transaction (a mid-batch failure
   * rolls back everything — never a half-moved set; the 4.2.2 bulk shape).
   *
   * "Unfinished" = an issue whose workflow `status` is NOT in the project's
   * `done`-category terminal set (`workflowsService.getTerminalStatusKeys`,
   * Epic 3) — so "done" generalizes to every `category = done` status, not a
   * hardcoded key. Carry-over destinations (`carryOverTo`, default `'backlog'`):
   *   • `'backlog'` — each unfinished issue's `sprintId` is cleared; it keeps
   *     its `backlogRank` and re-appears in the backlog in order.
   *   • `{ sprintId }` — the unfinished issues are appended to the TARGET
   *     PLANNED sprint's rank tail, in their existing order (same-project
   *     guarded; the target must be a different, planned sprint in the same
   *     project, else `InvalidCarryOverTargetError`).
   * A sprint with NO unfinished issues completes with a no-op carry-over.
   *
   * Concurrency: the project's active sprint row is locked `FOR UPDATE` inside
   * the transaction (the same lost-update guard `startSprint` uses); a sprint
   * that is no longer the project's active one (a concurrent complete won) is
   * rejected as not-completable.
   *
   * Throws: `SprintNotFoundError` (404), `NotSprintAdminError` (403),
   * `SprintNotCompletableError` (422 — not `active`),
   * `InvalidCarryOverTargetError` (422 — target not a same-project planned
   * sprint).
   */
  async completeSprint(
    id: string,
    input: CompleteSprintInput,
    ctx: ServiceContext,
  ): Promise<SprintDto> {
    const existing = await sprintRepository.findById(id, ctx.workspaceId);
    if (!existing) throw new SprintNotFoundError(id);
    await assertSprintAdmin(ctx.userId, existing.projectId, ctx.workspaceId);

    // Only an ACTIVE sprint is completable — the friendly surface over the pure
    // one-way `assertSprintTransition(active → complete)` rule, composed below
    // as the single source of the transition law.
    if (existing.state !== 'active') throw new SprintNotCompletableError(id, existing.state);
    assertSprintTransition(existing.state, 'complete');

    const carryOverTo: CarryOverDestination = input.carryOverTo ?? 'backlog';

    // Validate a sprint carry-over target BEFORE any write: it must be a
    // DIFFERENT, PLANNED sprint in the SAME project (the backlog destination
    // needs no validation). An unknown / cross-workspace / cross-project /
    // non-planned / self target is rejected with InvalidCarryOverTargetError.
    if (carryOverTo !== 'backlog') {
      const targetId = carryOverTo.sprintId;
      const target = await sprintRepository.findById(targetId, ctx.workspaceId);
      if (
        !target ||
        target.id === existing.id ||
        target.projectId !== existing.projectId ||
        target.state !== 'planned'
      ) {
        throw new InvalidCarryOverTargetError(id, targetId);
      }
    }

    // The project's done-category status keys define "finished"; everything else
    // in the sprint is carried over. Reference read of workflow config — no tx.
    const doneStatusKeys = [
      ...(await workflowsService.getTerminalStatusKeys(existing.projectId, ctx.workspaceId)),
    ];

    const result = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // Lost-update guard: lock the project's active sprint row. If it is no
        // longer THIS sprint (a concurrent complete won), it is not completable.
        const locked = await sprintRepository.findActiveByProjectForUpdate(
          existing.projectId,
          ctx.workspaceId,
          tx,
        );
        if (!locked || locked.id !== id) {
          throw new SprintNotCompletableError(id, existing.state);
        }

        // The WHOLE non-archived member set, read ONCE and split by done-
        // category (bounded by the sprint's own scope — a team sprint, not the
        // unbounded backlog; finding #57). An empty `excludeStatusKeys` applies
        // no status filter, so this is every member; `unfinished` is the subset
        // to carry over, in the same `backlogRank` order the carry-over appends.
        const allIssues = await workItemRepository.findSprintIssuesExcludingStatuses(
          id,
          ctx.workspaceId,
          [],
          tx,
        );
        const doneSet = new Set(doneStatusKeys);
        const unfinished = allIssues.filter((item) => !doneSet.has(item.status));

        // FREEZE the at-completion report snapshot BEFORE the carry-over moves
        // the unfinished set out (bug-sprint-report-incomplete-list-zero-after-
        // carry-over). One row per member issue records its done-category
        // BUCKET, its `backlogRank` AT CLOSE (the carry-over re-ranks issues
        // moved into a target sprint, so freezing it here keeps the closed
        // report's order stable), and whether it was added after start (the
        // "added during sprint" figure — frozen so a carried-out addition still
        // counts). `getSprintReport` reads this for a `complete` sprint; the
        // issue ROW content stays live. A sprint never started has no anchor for
        // "added after", so that flag is all-false.
        const addedAfterIds = existing.startDate
          ? new Set(
              await workItemRevisionRepository.findItemIdsAddedToSprintAfter(
                id,
                ctx.workspaceId,
                existing.startDate,
                tx,
              ),
            )
          : new Set<string>();
        await sprintReportEntryRepository.createSnapshot(
          allIssues.map((item) => ({
            workspaceId: ctx.workspaceId,
            sprintId: id,
            workItemId: item.id,
            completed: doneSet.has(item.status),
            addedAfterStart: addedAfterIds.has(item.id),
            backlogRank: item.backlogRank,
          })),
          tx,
        );

        if (carryOverTo === 'backlog') {
          // Clear the sprint association; the issue keeps its backlogRank and
          // re-appears in the backlog in order (a 1.4.6 revision per move).
          for (const item of unfinished) {
            await workItemRepository.setSprint(item.id, null, tx);
            await workItemRevisionsService.recordRevision(
              {
                workItemId: item.id,
                changedById: ctx.userId,
                changeKind: 'updated',
                diff: { sprintId: { from: item.sprintId, to: null } },
              },
              tx,
            );
          }
        } else {
          // Append the carried-over issues to the target sprint's rank tail in
          // their existing order — read the boundary rank ONCE, then chain
          // `keyForAppend` (bounded single-row writes, never an N-row renumber).
          const targetId = carryOverTo.sprintId;
          let prevRank = await workItemRepository.findBoundaryBacklogRank(
            existing.projectId,
            ctx.workspaceId,
            targetId,
            'max',
            tx,
          );
          for (const item of unfinished) {
            const newRank = keyForAppend(prevRank);
            prevRank = newRank;
            await workItemRepository.setSprint(item.id, targetId, tx);
            await workItemRepository.setBacklogRank(item.id, newRank, tx);
            await workItemRevisionsService.recordRevision(
              {
                workItemId: item.id,
                changedById: ctx.userId,
                changeKind: 'updated',
                diff: {
                  sprintId: { from: item.sprintId, to: targetId },
                  backlogRank: { from: item.backlogRank, to: newRank },
                },
              },
              tx,
            );
          }
        }

        // Close: stamp completedAt + flip to complete (frees the one-active slot
        // so a new sprint can start).
        const row = await sprintRepository.update(
          id,
          { state: 'complete', completedAt: new Date() },
          tx,
        );
        // The DONE issues that stayed are the completed sprint's remaining count.
        const issueCount = await workItemRepository.countSprintIssues(
          id,
          ctx.workspaceId,
          undefined,
          tx,
        );
        return { row, issueCount };
      },
    );
    return toSprintDto(result.row, result.issueCount);
  },

  /**
   * The SPRINT REPORT (Story 4.4 · Subtask 4.4.4) — what got done vs. what did
   * not, built to real-product SCALE (finding #57: bounded aggregates +
   * cursor-paginated lists, never a load-all). Powers the complete modal's
   * success state (4.4.6) and the standalone closed-sprint report. A READ — open
   * to any workspace member (like `rollupForSprint` / `listByProject`), NOT
   * owner-gated; the owner gate guards sprint MANAGEMENT writes, not reads. No
   * transaction (a read path; the repos use the `db` singleton).
   *
   * Works for a `complete` sprint (the report) AND an `active` one (a live
   * preview the complete modal shows before confirming). The split is the LIVE
   * view over the sprint's CURRENT membership, which makes the two states read
   * naturally: on an ACTIVE sprint it is the FULL completed/incomplete preview
   * (nothing has moved yet — what the modal shows before you confirm); on a
   * COMPLETED sprint, 4.4.3 has already carried the unfinished issues OUT, so the
   * report shows what SHIPPED and stayed, while the IMMUTABLE `committed` baseline
   * preserves the original scope (committed − completed = how much went
   * unfinished) and the carry-over already routed those issues. The "view all"
   * deep-link + the scope-change count are likewise membership-based, so the whole
   * report is internally consistent. Composes:
   *   • the project's `done`-category status keys (`getTerminalStatusKeys`,
   *     Epic 3) — the completed/incomplete split, so "done" generalizes to every
   *     `category = done` status, not a hardcoded key;
   *   • the points summary — `committed` = the IMMUTABLE `committedPoints`
   *     baseline `startSprint` locked (4.4.2; `null` when started unestimated),
   *     `completed` / `notCompleted` = the live done / not-done point sums REUSED
   *     from Story 4.3.3 `rollupForSprint` (the bounded grouped aggregate — never
   *     a re-sum);
   *   • the completed/incomplete COUNTS — grouped aggregates over the sprint
   *     (`countSprintIssuesByDoneMembership`), NOT page sums;
   *   • the completed/incomplete LISTS — one bounded cursor page each (the UI
   *     shows the page + a "view all" deep-link to `/items` filtered to the
   *     sprint, built from `sprintId`);
   *   • `addedAfterStart` — the issues associated with the sprint after
   *     `startDate`, from the 1.4.6 revision trail (0 when the sprint has no
   *     `startDate`, e.g. never started).
   *
   * Tenant-gated by `workspaceId` (finding #26): a sprint outside the active
   * workspace is an indistinguishable 404.
   *
   * Throws: `SprintNotFoundError` (404 — unknown / cross-workspace sprint).
   */
  async getSprintReport(
    id: string,
    options: GetSprintReportOptions,
    ctx: ServiceContext,
  ): Promise<SprintReportDto> {
    const sprint = await sprintRepository.findById(id, ctx.workspaceId);
    if (!sprint) throw new SprintNotFoundError(id);

    const take = clampReportLimit(options.limit);
    // The committed baseline is the immutable at-START snapshot (4.4.2) in BOTH
    // report modes — never the live roll-up's `committed` (which moves with
    // scope); that contrast is the report's point.
    const committed = sprint.committedPoints === null ? null : sprint.committedPoints.toNumber();

    // A COMPLETED sprint reads its report from the FROZEN at-completion snapshot
    // (`completeSprint` wrote one row per member issue at close) —
    // bug-sprint-report-incomplete-list-zero-after-carry-over. The carry-over
    // has already moved the unfinished issues OUT of the live membership, so a
    // membership read would show 0 incomplete (and 0 not-completed points, and
    // undercount "added during sprint"). The snapshot preserves the
    // completed/incomplete split, order, point sums, and scope-change figure as
    // they were at close, exactly like Jira. The issue ROW content stays LIVE
    // (read through the snapshot's `workItem` relation). An `active` (the
    // complete-modal live preview) / `planned` sprint has NO snapshot and falls
    // through to the live-membership read below.
    if (sprint.state === 'complete') {
      const [snapPoints, completedCount, incompleteCount, completedRows, incompleteRows, added] =
        await Promise.all([
          estimationService.rollupForSprintSnapshot(id, ctx),
          sprintReportEntryRepository.countByCompletion(id, ctx.workspaceId, true),
          sprintReportEntryRepository.countByCompletion(id, ctx.workspaceId, false),
          sprintReportEntryRepository.findByCompletion(id, ctx.workspaceId, {
            completed: true,
            take,
            cursor: options.completedCursor,
          }),
          sprintReportEntryRepository.findByCompletion(id, ctx.workspaceId, {
            completed: false,
            take,
            cursor: options.incompleteCursor,
          }),
          sprintReportEntryRepository.countAddedAfterStart(id, ctx.workspaceId),
        ]);
      return toSprintReportDto({
        sprintId: sprint.id,
        state: sprint.state as SprintDto['state'],
        points: {
          committed,
          completed: snapPoints.completed,
          notCompleted: snapPoints.notCompleted,
        },
        completed: toSprintReportPage(completedRows, take, completedCount),
        incomplete: toSprintReportPage(incompleteRows, take, incompleteCount),
        addedAfterStart: added,
      });
    }

    const doneStatusKeys = [
      ...(await workflowsService.getTerminalStatusKeys(sprint.projectId, ctx.workspaceId)),
    ];

    // Live preview (active / planned): the done/not-done sums REUSE the 4.3.3
    // bounded roll-up over CURRENT membership — correct here because nothing has
    // been carried out yet.
    const rollup = await estimationService.rollupForSprint(id, ctx);

    // Grouped aggregate counts (not page sums) + one bounded page of each list.
    const [completedCount, incompleteCount, completedRows, incompleteRows] = await Promise.all([
      workItemRepository.countSprintIssuesByDoneMembership(id, ctx.workspaceId, {
        statusKeys: doneStatusKeys,
        include: true,
      }),
      workItemRepository.countSprintIssuesByDoneMembership(id, ctx.workspaceId, {
        statusKeys: doneStatusKeys,
        include: false,
      }),
      workItemRepository.findSprintIssuesByDoneMembership(id, ctx.workspaceId, {
        statusKeys: doneStatusKeys,
        include: true,
        take,
        cursor: options.completedCursor,
      }),
      workItemRepository.findSprintIssuesByDoneMembership(id, ctx.workspaceId, {
        statusKeys: doneStatusKeys,
        include: false,
        take,
        cursor: options.incompleteCursor,
      }),
    ]);

    // Scope change: issues added to the sprint after it started (the Jira "added
    // during sprint" figure). A sprint with no startDate (never started) has no
    // anchor — 0.
    const addedAfterStart = sprint.startDate
      ? await workItemRevisionRepository.countItemsAddedToSprintAfter(
          id,
          ctx.workspaceId,
          sprint.startDate,
        )
      : 0;

    return toSprintReportDto({
      sprintId: sprint.id,
      state: sprint.state as SprintDto['state'],
      points: { committed, completed: rollup.completed, notCompleted: rollup.remaining },
      completed: toSprintReportPage(completedRows, take, completedCount),
      incomplete: toSprintReportPage(incompleteRows, take, incompleteCount),
      addedAfterStart,
    });
  },

  /** Re-exported for callers that import the service object. See the free
   *  function below — it is the canonical export Story 4.4 consumes. */
  assertSprintTransition,
};

/** The sprint report's default + max issue-list page size (Story 4.4.4) —
 *  mirrors `backlogService`'s `BACKLOG_PAGE_SIZE` / `MAX_BACKLOG_PAGE_SIZE`. */
const SPRINT_REPORT_PAGE_SIZE = 50;
const MAX_SPRINT_REPORT_PAGE_SIZE = 100;

/** Clamp a requested report page `limit` to `[1, 100]`; NaN / absent → 50. */
function clampReportLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return SPRINT_REPORT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SPRINT_REPORT_PAGE_SIZE);
}

/**
 * The PURE sprint state-machine guard (Story 4.1 · Subtask 4.1.3). The lifecycle
 * is one-way: `planned → active → complete`. ALLOWS exactly `planned→active` and
 * `active→complete`; throws `InvalidSprintTransitionError` for every skip
 * (`planned→complete`), reopen (`complete→active`, `active→planned`) and
 * self-transition (`x→x`). No I/O — Story 4.4's start/complete flows + the
 * one-active guard import THIS so the rule lives in exactly one place.
 */
export function assertSprintTransition(from: SprintState, to: SprintState): void {
  const allowed =
    (from === 'planned' && to === 'active') || (from === 'active' && to === 'complete');
  if (!allowed) throw new InvalidSprintTransitionError(from, to);
}

/**
 * Compute a sprint's finishability (Subtask 7.8.15) — the engine behind
 * `validateSprint`, given an already-resolved sprint. See the method's doc for
 * the validity rule. Reads: the sprint's non-archived members (status + parent),
 * the project terminal set ("done"), the not-done members' ancestor chains, and
 * the `blocked_by` edges of every member ∪ ancestor (the probe set). Each probe
 * is mapped back to the in-sprint not-done member(s) it gates, so a violation is
 * attributed to the in-sprint item (a member's own blocker → that member; an
 * ancestor's blocker → every descendant member in the sprint).
 */
async function computeSprintValidity(
  sprintId: string,
  projectId: string,
  ctx: ServiceContext,
): Promise<SprintValidityDto> {
  // ALL non-archived members (done + not-done): the in-sprint membership set the
  // "blocker is also in the sprint?" test keys on. `findSprintIssuesExcludingStatuses`
  // with an empty exclusion set is the whole committed set (it already filters
  // archived + tenant).
  const members = await workItemRepository.findSprintIssuesExcludingStatuses(
    sprintId,
    ctx.workspaceId,
    [],
  );
  const memberIds = new Set(members.map((m) => m.id));
  const membersById = new Map(members.map((m) => [m.id, m]));

  // "Done" = the sprint project's terminal (category='done') status keys — only
  // NOT-done members need a finishability check (a done item is already finished).
  const terminalForSprint = await workflowsService.getTerminalStatusKeys(
    projectId,
    ctx.workspaceId,
  );
  const notDone = members.filter((m) => !terminalForSprint.has(m.status));
  if (notDone.length === 0) {
    return { sprintId, valid: true, blockers: [] };
  }

  // The PROBE set = each not-done member ∪ its ancestor chain (the cascade: a
  // child inherits its ancestors' blockers). `gatedMembersByProbe` maps every
  // probe id back to the in-sprint not-done member(s) it gates, so a violating
  // blocker is reported at the in-sprint item, not the ancestor.
  const ancestorsByItem = await workItemRepository.findAncestorIdsForItems(
    notDone.map((m) => m.id),
    ctx.workspaceId,
  );
  const gatedMembersByProbe = new Map<string, Set<string>>();
  const gate = (probeId: string, memberId: string) => {
    const set = gatedMembersByProbe.get(probeId);
    if (set) set.add(memberId);
    else gatedMembersByProbe.set(probeId, new Set([memberId]));
  };
  for (const m of notDone) {
    gate(m.id, m.id);
    for (const ancestorId of ancestorsByItem.get(m.id) ?? []) gate(ancestorId, m.id);
  }

  const edges = await workItemLinkRepository.findBlockerEdgesForItems([
    ...gatedMembersByProbe.keys(),
  ]);
  // Per-project terminal sets — a block can be cross-project, so each blocker's
  // done-ness is judged against its OWN project (finding #21).
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    edges.map((e) => e.blockerProjectId),
    ctx.workspaceId,
  );

  const blockers: SprintBlockerDto[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const inSprint = memberIds.has(edge.blockerId);
    const done = terminalByProject.get(edge.blockerProjectId)?.has(edge.blockerStatus) ?? false;
    if (inSprint || done) continue; // satisfied: in the same sprint, or already done
    for (const memberId of gatedMembersByProbe.get(edge.fromId) ?? []) {
      const member = membersById.get(memberId);
      if (!member) continue;
      const key = `${member.identifier} ${edge.blockerKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blockers.push({
        item: member.identifier,
        blockedBy: edge.blockerKey,
        blockerStatus: edge.blockerStatus,
        blockerSprintId: edge.blockerSprintId,
      });
    }
  }
  // Deterministic order (by gated item, then blocker) for a stable wire shape.
  blockers.sort((a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy));
  return { sprintId, valid: blockers.length === 0, blockers };
}

/**
 * Owner-gate for sprint management (finding #36; TODO(6.4) widens the role-set).
 * Resolves + tenant-gates the project in one call — a project that doesn't exist
 * OR belongs to another workspace 404s BEFORE any membership probe (no
 * existence leak), then requires the actor to be the workspace owner. Mirrors
 * `boardsService.assertBoardConfigAdmin`.
 */
async function assertSprintAdmin(
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const project = await projectRepository.findById(projectId);
  if (!project || project.workspaceId !== workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  const membership = await workspaceMembershipRepository.findByUserAndWorkspace(
    userId,
    workspaceId,
  );
  if (!isOwnerRole(membership?.role)) {
    throw new NotSprintAdminError();
  }
}

/** Trim + reject a blank sprint name. Returns the trimmed name. */
function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new InvalidSprintNameError();
  return trimmed;
}

/**
 * Parse an optional ISO date input into a `Date | null | undefined`:
 *   - `undefined` → `undefined` (the field is not being set/changed)
 *   - `null`      → `null` (explicitly cleared)
 *   - a string    → a `Date`, or `SprintWindowInvalidError` if it doesn't parse.
 */
function parseNullableDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SprintWindowInvalidError(`Invalid date: "${value}".`);
  }
  return date;
}

/** Reject a window whose end precedes its start (both endpoints present). */
function assertWindow(start: Date | null, end: Date | null): void {
  if (start && end && end.getTime() < start.getTime()) {
    throw new SprintWindowInvalidError();
  }
}
