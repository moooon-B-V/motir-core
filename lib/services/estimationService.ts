import type { EstimationStatistic, PointScale } from '@prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { toEstimationConfigDto, toSprintPointsDto } from '@/lib/mappers/estimationMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { SprintNotFoundError } from '@/lib/sprints/errors';
import {
  EstimationConfigForbiddenError,
  InvalidEstimateError,
  InvalidScaleConfigError,
} from '@/lib/estimation/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type {
  EstimationConfigDto,
  ParentRollupDto,
  SprintPointsDto,
  UpdateEstimationConfigInput,
} from '@/lib/dto/estimation';

// Estimation service (Story 4.3 · Subtask 4.3.3) — the business logic + data
// access for story-point estimation. It owns:
//   * the per-issue story-point WRITE (`setEstimate`) — separate from the 2.3.6
//     TIME-estimate (`estimateMinutes`) editing path;
//   * the project estimation-config read / admin-update (`getEstimationConfig`
//     / `updateEstimationConfig`);
//   * the BOUNDED roll-up reads (`rollupForSprint` / `rollupForParent`, finding
//     #57) the 4.3.5 UI binds to — and that Story **4.5.2** consumes
//     (`rollupForSprint` IS the reusable bounded aggregate behind its scrum
//     `SprintSummaryDto.points`; the SUM lives in ONE place).
//
// 4-layer (CLAUDE.md): one service method = one transaction (writes run under
// `withWorkspaceContext` so the FORCE-RLS WITH CHECK passes under the non-bypass
// `prodect_app` role); repositories are single-op leaves; methods return DTOs,
// never raw Prisma rows.
//
// TENANCY (finding #26): every repo read/write carries an explicit
// `workspaceId`; a row outside the active workspace is an indistinguishable 404
// (no existence leak). AUTHORIZATION: changing the estimation config is
// owner-gated today (finding #36; TODO(6.4) widens the role-set), mirroring
// `workflowsService` / `boardsService` — Jira gates board Estimation settings to
// admins (decision-ladder rung 1). Reading the config + the roll-ups is open to
// any workspace member (the badge/picker needs it).

export const estimationService = {
  /**
   * Set or clear (`points = null`) an issue's story-point estimate. Validates
   * the value (a non-negative number within `Decimal(6, 2)` range, ≤ 2 decimal
   * places), writes the single `storyPoints` column, and records a 1.4.6
   * revision in the SAME transaction. The TIME estimate (`estimateMinutes`)
   * stays on its existing 2.3.6 path — this method owns story points only.
   *
   * Throws: `WorkItemNotFoundError` (404 — unknown / cross-workspace issue),
   * `InvalidEstimateError` (422).
   */
  async setEstimate(
    itemId: string,
    points: number | null,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const value = validateEstimate(points);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // Lock the row, then RE-READ it under the lock — ONE read, inside the tx
        // (mirroring `workItemsService.updateWorkItem`; no redundant pre-flight
        // read). Two purposes: (1) two concurrent estimate writes serialize on
        // the `FOR UPDATE` lock, so the revision `from` is the authoritative
        // committed value, not a stale snapshot a racing writer could already
        // have invalidated; (2) the explicit `workspaceId` check on the re-read
        // is the finding-#26 tenant gate — a missing / cross-workspace item is
        // an indistinguishable 404. The explicit check (not just RLS) keeps the
        // gate primary under the dev/CI BYPASSRLS role too.
        const locked = await workItemRepository.lockById(itemId, tx);
        if (!locked) throw new WorkItemNotFoundError(itemId);
        const current = await workItemRepository.findById(itemId, tx);
        if (!current || current.workspaceId !== ctx.workspaceId) {
          throw new WorkItemNotFoundError(itemId);
        }
        const from = current.storyPoints === null ? null : Number(current.storyPoints);

        const row = await workItemRepository.setStoryPoints(itemId, value, tx);
        await workItemRevisionsService.recordRevision(
          {
            workItemId: itemId,
            changedById: ctx.userId,
            changeKind: 'updated',
            diff: { storyPoints: { from, to: value } },
          },
          tx,
        );
        return toWorkItemDto(row);
      },
    );
  },

  /**
   * Read a project's estimation config (any workspace member). The project is
   * tenant-gated by id + workspaceId — a missing / cross-workspace project is a
   * 404. Returns `{ estimationStatistic, pointScale, customScaleValues }`.
   *
   * Throws: `ProjectNotFoundError` (404).
   */
  async getEstimationConfig(projectId: string, ctx: ServiceContext): Promise<EstimationConfigDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    return toEstimationConfigDto(project);
  },

  /**
   * Admin-update a project's estimation config. Owner-gated (the same gate the
   * workflow / board settings use). Validates the EFFECTIVE (patch-merged)
   * config: enum membership of any supplied statistic / scale, and a non-empty
   * all-non-negative-numeric `customScaleValues` when the effective scale is
   * `custom`. Returns the updated config.
   *
   * Throws: `ProjectNotFoundError` (404), `EstimationConfigForbiddenError`
   * (403), `InvalidScaleConfigError` (422).
   */
  async updateEstimationConfig(
    projectId: string,
    patch: UpdateEstimationConfigInput,
    ctx: ServiceContext,
  ): Promise<EstimationConfigDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await assertEstimationAdmin(ctx.userId, ctx.workspaceId);

    const data = validateConfigPatch(patch, project);

    const updated = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => projectRepository.updateEstimationConfig(projectId, data, tx),
    );
    return toEstimationConfigDto(updated);
  },

  /**
   * The BOUNDED sprint points roll-up (finding #57) — `{ committed, completed,
   * remaining }` over the configured statistic. `completed` counts only issues
   * whose status maps to a `category = 'done'` workflow status; `remaining`
   * floored at 0; a wholly unestimated sprint returns `{ 0, 0, 0 }`. ONE grouped
   * aggregate, NEVER a load-all + client sum.
   *
   * **Exported as the reusable aggregate Story 4.5.2 consumes** for its scrum
   * `SprintSummaryDto.points` (4.5.2 adds only the per-column `columnPoints`
   * breakdown) — the sprint-points SUM stays in this one place.
   *
   * Throws: `SprintNotFoundError` (404 — unknown / cross-workspace sprint).
   */
  async rollupForSprint(sprintId: string, ctx: ServiceContext): Promise<SprintPointsDto> {
    const sprint = await sprintRepository.findById(sprintId, ctx.workspaceId);
    if (!sprint) throw new SprintNotFoundError(sprintId);

    const statistic = await resolveStatistic(sprint.projectId);
    const { committed, completed } = await workItemRepository.sumPointsForSprint(
      sprintId,
      ctx.workspaceId,
      statistic,
    );
    return toSprintPointsDto(committed, completed);
  },

  /**
   * The BOUNDED epic/parent subtree roll-up (finding #57) — the configured
   * statistic summed over the parent's DESCENDANTS at any depth, via one
   * recursive-CTE aggregate. Distinct from the parent's OWN estimate. An
   * unestimated subtree returns `{ total: 0 }`. NEVER a load-the-subtree + sum.
   *
   * Throws: `WorkItemNotFoundError` (404 — unknown / cross-workspace parent).
   */
  async rollupForParent(parentId: string, ctx: ServiceContext): Promise<ParentRollupDto> {
    const item = await workItemRepository.findById(parentId);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(parentId);
    }
    const statistic = await resolveStatistic(item.projectId);
    return workItemRepository.sumPointsForParent(parentId, ctx.workspaceId, statistic);
  },
};

/** The largest value `Decimal(6, 2)` can hold (4 integer + 2 fractional digits). */
const MAX_STORY_POINTS = 9999.99;

/**
 * Validate a story-point estimate value. `null` clears (always valid). A number
 * must be finite, non-negative, within the `Decimal(6, 2)` range, and carry at
 * most two decimal places. Returns the value unchanged on success.
 */
function validateEstimate(points: number | null): number | null {
  if (points === null) return null;
  if (typeof points !== 'number' || !Number.isFinite(points)) {
    throw new InvalidEstimateError('A story-point estimate must be a finite number.');
  }
  if (points < 0) {
    throw new InvalidEstimateError('A story-point estimate must not be negative.');
  }
  if (points > MAX_STORY_POINTS) {
    throw new InvalidEstimateError(`A story-point estimate must not exceed ${MAX_STORY_POINTS}.`);
  }
  // Two-decimal-place cap (the column is Decimal(6, 2)) — reject finer precision
  // up front rather than letting Postgres silently round it.
  if (Math.round(points * 100) !== points * 100) {
    throw new InvalidEstimateError('A story-point estimate allows at most two decimal places.');
  }
  return points;
}

const ESTIMATION_STATISTICS: readonly EstimationStatistic[] = [
  'story_points',
  'time_estimate',
  'issue_count',
];
const POINT_SCALES: readonly PointScale[] = ['fibonacci', 'linear', 'custom'];

/**
 * Validate the EFFECTIVE (patch-merged-over-current) estimation config and
 * return the Prisma update payload (only the supplied fields). Rejects an
 * unknown statistic / scale enum value, and an empty / non-numeric / negative
 * `customScaleValues` when the effective scale is `custom`.
 */
function validateConfigPatch(
  patch: UpdateEstimationConfigInput,
  current: { pointScale: PointScale; customScaleValues: number[] },
): {
  estimationStatistic?: EstimationStatistic;
  pointScale?: PointScale;
  customScaleValues?: number[];
} {
  const data: {
    estimationStatistic?: EstimationStatistic;
    pointScale?: PointScale;
    customScaleValues?: number[];
  } = {};

  if (patch.estimationStatistic !== undefined) {
    if (!ESTIMATION_STATISTICS.includes(patch.estimationStatistic as EstimationStatistic)) {
      throw new InvalidScaleConfigError(
        `Unknown estimation statistic: "${patch.estimationStatistic}".`,
      );
    }
    data.estimationStatistic = patch.estimationStatistic as EstimationStatistic;
  }
  if (patch.pointScale !== undefined) {
    if (!POINT_SCALES.includes(patch.pointScale as PointScale)) {
      throw new InvalidScaleConfigError(`Unknown point scale: "${patch.pointScale}".`);
    }
    data.pointScale = patch.pointScale as PointScale;
  }
  if (patch.customScaleValues !== undefined) {
    data.customScaleValues = validateScaleValues(patch.customScaleValues);
  }

  // When the effective scale is `custom`, the deck must be present + non-empty.
  const effectiveScale = data.pointScale ?? current.pointScale;
  const effectiveValues = data.customScaleValues ?? current.customScaleValues;
  if (effectiveScale === 'custom' && effectiveValues.length === 0) {
    throw new InvalidScaleConfigError('A custom point scale needs at least one value.');
  }
  return data;
}

/**
 * Validate a `customScaleValues` deck: every entry a finite, non-negative
 * number. (Emptiness is checked against the effective scale by the caller, so a
 * deck can be cleared while the scale is non-custom.)
 */
function validateScaleValues(values: number[]): number[] {
  if (!Array.isArray(values)) {
    throw new InvalidScaleConfigError('`customScaleValues` must be an array of numbers.');
  }
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new InvalidScaleConfigError('Every custom scale value must be a non-negative number.');
    }
  }
  return values;
}

/**
 * Resolve a project's configured estimation statistic for a roll-up, defaulting
 * to `story_points` when the project (somehow) has no config row. A read-only
 * reference lookup — the roll-up's own `workspaceId` gate keeps the aggregate
 * tenant-scoped, so no extra tenancy check is needed here.
 */
async function resolveStatistic(projectId: string): Promise<EstimationStatistic> {
  const config = await projectRepository.findEstimationConfig(projectId);
  return config?.estimationStatistic ?? 'story_points';
}

/**
 * Owner-gate for estimation-config changes (finding #36; TODO(6.4) widens the
 * role-set), mirroring `workflowsService.assertProjectAdmin` /
 * `boardsService.assertBoardConfigAdmin`. The project's workspace membership of
 * the actor is the gate; the project↔workspace tenancy check already ran in the
 * caller (so a foreign project 404s before this).
 */
async function assertEstimationAdmin(userId: string, workspaceId: string): Promise<void> {
  const membership = await workspaceMembershipRepository.findByUserAndWorkspace(
    userId,
    workspaceId,
  );
  if (!isOwnerRole(membership?.role)) {
    throw new EstimationConfigForbiddenError();
  }
}
