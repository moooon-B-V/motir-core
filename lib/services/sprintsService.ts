import { Prisma, type SprintState } from '@prisma/client';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { boardsService } from '@/lib/services/boardsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { keyForAppend } from '@/lib/workItems/positioning';
import { toSprintDto } from '@/lib/mappers/sprintMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  CarryOverDestination,
  CompleteSprintInput,
  CreateSprintInput,
  SprintDto,
  StartSprintInput,
  UpdateSprintInput,
} from '@/lib/dto/sprints';
import {
  CannotDeleteActiveSprintError,
  CannotModifyCompletedSprintError,
  InvalidCarryOverTargetError,
  InvalidSprintNameError,
  InvalidSprintTransitionError,
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

        // The WHOLE unfinished set, moved atomically (bounded by the sprint's
        // own scope — a team sprint, not the unbounded backlog; finding #57).
        const unfinished = await workItemRepository.findSprintIssuesExcludingStatuses(
          id,
          ctx.workspaceId,
          doneStatusKeys,
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
        const issueCount = await workItemRepository.countSprintIssues(id, ctx.workspaceId, tx);
        return { row, issueCount };
      },
    );
    return toSprintDto(result.row, result.issueCount);
  },

  /** Re-exported for callers that import the service object. See the free
   *  function below — it is the canonical export Story 4.4 consumes. */
  assertSprintTransition,
};

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
