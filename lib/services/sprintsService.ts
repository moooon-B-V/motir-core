import { Prisma, type SprintState } from '@prisma/client';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { toSprintDto } from '@/lib/mappers/sprintMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CreateSprintInput, SprintDto, UpdateSprintInput } from '@/lib/dto/sprints';
import {
  CannotDeleteActiveSprintError,
  CannotModifyCompletedSprintError,
  InvalidSprintNameError,
  InvalidSprintTransitionError,
  NotSprintAdminError,
  SprintNotFoundError,
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
