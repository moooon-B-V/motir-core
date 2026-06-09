import type { Prisma } from '@prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { keyBetween, keyForAppend } from '@/lib/workItems/positioning';
import { toWorkItemDto, toWorkItemSummaryDto } from '@/lib/mappers/workItemMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { CrossProjectSprintAssignmentError, SprintNotFoundError } from '@/lib/sprints/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { RankedIssuePageDto, RankPlacementInput } from '@/lib/dto/backlog';

// Backlog / sprint-association service (Story 4.1 · Subtask 4.1.4). The part of
// the sprint "data model" that MOVES issues between the backlog and a sprint and
// ORDERS them — the layer the Story-4.2 backlog + sprint-planning UI binds to.
// Kept distinct from `sprintsService` (the sprint ENTITY's CRUD + state machine)
// because these operate on the WORK ITEM (its `sprintId` / `backlogRank`
// columns), not on the sprint row — a clean cohesion seam, the "focused
// backlogService if cleaner" the card anticipates.
//
// What it owns:
//   * assignToSprint / moveToBacklog — the issue↔sprint association writes;
//   * rankIssue — the single-row backlog-rank reorder (fractional index);
//   * getBacklog / getSprintIssues — the BOUNDED, cursor-paginated reads
//     (finding #57 — never load-all).
// The create-time rank (a new issue is appended to the backlog) is wired into
// `workItemsService.createWorkItem`, not here — it rides the issue-create
// transaction so a new row is never born rank-less.
//
// 4-layer (CLAUDE.md): one method = one transaction; every WRITE runs under
// `withWorkspaceContext` (binds the workspace GUCs so the `work_item` RLS WITH
// CHECK passes under the non-bypass `prodect_app` role), threading the bound
// `tx` into the repo writes + the 1.4.6 revision; repositories stay single-op
// leaves; methods return DTOs, never raw Prisma rows.
//
// TENANCY (finding #26): `workItemRepository.findById` is NOT workspace-filtered,
// so every method explicitly gates the loaded item on `ctx.workspaceId` (a
// foreign item is a 404 — no existence leak); the sprint is loaded through the
// workspace-filtered `sprintRepository.findById`. The `sprint`/`work_item` RLS
// policies are the structural backstop (inert under the dev/CI BYPASSRLS
// superuser), so the application-layer gate is primary.
//
// AUTHORIZATION: association + ranking is EVERYDAY backlog grooming, available
// to any project member — NOT the owner-gated sprint-config tier (decision-
// ladder rung 1: Jira grants "Schedule Issues" / "Edit Issues" to the board's
// members, not just admins; only sprint *management* — create/start/complete —
// is admin-gated, which lives in `sprintsService`). So there is no owner gate
// here; the workspace-context tenancy gate (the actor already holds an active
// workspace context, i.e. is a member) is the access boundary. TODO(6.4):
// project-level roles refine "member".

/** Backlog/sprint page size — the bounded read cap (matches ISSUE_LIST_PAGE_SIZE). */
export const BACKLOG_PAGE_SIZE = 50;
const MAX_BACKLOG_PAGE_SIZE = 100;

export const backlogService = {
  /**
   * Associate an issue with a sprint. Same-project guarded: the sprint and the
   * issue MUST share a project (else `CrossProjectSprintAssignmentError`).
   * Placement: when `placement` names a neighbour the issue is ranked between
   * them WITHIN the target sprint; otherwise it is appended to the END of the
   * sprint (the Jira "drops at the bottom" default), computed off the sprint's
   * current max rank. The association + rank + a 1.4.6 revision all commit in
   * one transaction. Returns the updated issue's DTO.
   *
   * Throws: `WorkItemNotFoundError` (404 — unknown / cross-workspace issue),
   * `SprintNotFoundError` (404 — unknown / cross-workspace sprint),
   * `CrossProjectSprintAssignmentError` (422).
   */
  async assignToSprint(
    itemId: string,
    sprintId: string,
    placement: RankPlacementInput | undefined,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const item = await this.loadItem(itemId, ctx);
    const sprint = await sprintRepository.findById(sprintId, ctx.workspaceId);
    if (!sprint) throw new SprintNotFoundError(sprintId);
    if (sprint.projectId !== item.projectId) {
      throw new CrossProjectSprintAssignmentError(itemId, sprintId);
    }

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const newRank = await resolveRank(item.projectId, ctx.workspaceId, sprintId, placement, tx);
        await workItemRepository.setSprint(itemId, sprintId, tx);
        // The rank write runs second, so its returned row carries BOTH the new
        // sprintId (set just above, same tx) and the new rank — no re-read needed.
        const row = await workItemRepository.setBacklogRank(itemId, newRank, tx);
        await workItemRevisionsService.recordRevision(
          {
            workItemId: itemId,
            changedById: ctx.userId,
            changeKind: 'updated',
            diff: {
              sprintId: { from: item.sprintId, to: sprintId },
              backlogRank: { from: item.backlogRank, to: newRank },
            },
          },
          tx,
        );
        return toWorkItemDto(row);
      },
    );
  },

  /**
   * Move an issue OUT of its sprint and back to the backlog (`sprintId = null`).
   * The issue keeps its existing `backlogRank`, so it re-appears in the backlog
   * in rank order (the card's contract). A no-op when the issue is already in
   * the backlog (no write, no revision). One transaction; records a 1.4.6
   * revision on a real change. Returns the issue's DTO.
   *
   * Throws: `WorkItemNotFoundError` (404).
   */
  async moveToBacklog(itemId: string, ctx: ServiceContext): Promise<WorkItemDto> {
    const item = await this.loadItem(itemId, ctx);
    if (item.sprintId === null) return toWorkItemDto(item); // already in the backlog

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const row = await workItemRepository.setSprint(itemId, null, tx);
        await workItemRevisionsService.recordRevision(
          {
            workItemId: itemId,
            changedById: ctx.userId,
            changeKind: 'updated',
            diff: { sprintId: { from: item.sprintId, to: null } },
          },
          tx,
        );
        return toWorkItemDto(row);
      },
    );
  },

  /**
   * Reorder an issue within its CURRENT scope (its sprint, or the backlog when
   * `sprintId IS NULL`) by minting a single fractional-index `backlogRank`
   * strictly between the named neighbours — one row changes, never an N-row
   * renumber. `placement` names the neighbours the issue lands between (see
   * `RankPlacementInput`): both → interior drop; only `beforeId` → append after
   * it; only `afterId` → prepend before it; neither → the sole/first key. A
   * placement that resolves to the issue's current rank is a no-op. One
   * transaction; records a 1.4.6 revision on a real change. Returns the DTO.
   *
   * Throws: `WorkItemNotFoundError` (404 — the issue or a named neighbour).
   */
  async rankIssue(
    itemId: string,
    placement: RankPlacementInput,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const item = await this.loadItem(itemId, ctx);
    const newRank = await this.resolveNeighbourRank(placement, ctx);
    if (newRank === item.backlogRank) return toWorkItemDto(item); // no-op

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const row = await workItemRepository.setBacklogRank(itemId, newRank, tx);
        await workItemRevisionsService.recordRevision(
          {
            workItemId: itemId,
            changedById: ctx.userId,
            changeKind: 'updated',
            diff: { backlogRank: { from: item.backlogRank, to: newRank } },
          },
          tx,
        );
        return toWorkItemDto(row);
      },
    );
  },

  /**
   * One BOUNDED page of a project's backlog (`sprintId IS NULL`) in
   * `backlogRank` order, plus the total count (finding #57 — never load-all).
   * `cursor` is the last id from the previous page; `limit` is clamped to
   * [1, 100] (default 50). Returns lighter `WorkItemSummaryDto` rows.
   *
   * Issues in a `done`-category status are EXCLUDED from the backlog (list +
   * count): the backlog is the to-be-planned pile, so a completed unsprinted
   * issue doesn't belong there (mirror rung 1 — Jira hides the Done column from
   * the backlog; `todo` AND `in_progress` unsprinted issues stay). Done issues
   * inside a sprint are unaffected — `getSprintIssues` keeps them (they're part
   * of the sprint's scope), matching Jira's active-sprint behaviour.
   */
  async getBacklog(
    projectId: string,
    options: { cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<RankedIssuePageDto> {
    const take = clampLimit(options.limit);
    const excludeStatusKeys = await this.backlogExcludedStatusKeys(projectId, ctx.workspaceId);
    const rows = await workItemRepository.findBacklogPage(projectId, ctx.workspaceId, {
      take,
      cursor: options.cursor,
      excludeStatusKeys,
    });
    const totalCount = await workItemRepository.countBacklog(
      projectId,
      ctx.workspaceId,
      excludeStatusKeys,
    );
    return buildPage(rows, take, totalCount);
  },

  /**
   * The status keys hidden from the backlog: a project's `done`-category status
   * keys (e.g. the default workflow's `done` + `cancelled`). Read straight from
   * `workflowsRepository` (no DTO needed — keys only); the workspace gate is the
   * repo's. Empty only for a cross-workspace / status-less project, in which
   * case the backlog read applies no status filter.
   */
  async backlogExcludedStatusKeys(projectId: string, workspaceId: string): Promise<string[]> {
    const statuses = await workflowsRepository.findStatuses(projectId, workspaceId);
    return statuses.filter((s) => s.category === 'done').map((s) => s.key);
  },

  /**
   * A sprint's ranked issues as a bounded page + the committed-issue count. A
   * sprint is smaller than the backlog, but the read is still paged-capable
   * (finding #57), not an unbounded load. Tenant-gates the sprint by workspace
   * (a foreign / unknown sprint is a 404). Returns `WorkItemSummaryDto` rows.
   *
   * Throws: `SprintNotFoundError` (404).
   */
  async getSprintIssues(
    sprintId: string,
    options: { cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<RankedIssuePageDto> {
    const sprint = await sprintRepository.findById(sprintId, ctx.workspaceId);
    if (!sprint) throw new SprintNotFoundError(sprintId);

    const take = clampLimit(options.limit);
    const rows = await workItemRepository.findSprintIssues(sprintId, ctx.workspaceId, {
      take,
      cursor: options.cursor,
    });
    const totalCount = await workItemRepository.countSprintIssues(sprintId, ctx.workspaceId);
    return buildPage(rows, take, totalCount);
  },

  /**
   * Load an issue and enforce the finding-#26 workspace gate: a missing OR
   * cross-workspace item is an indistinguishable 404. Used by every write path
   * before it touches the row.
   */
  async loadItem(itemId: string, ctx: ServiceContext) {
    const item = await workItemRepository.findById(itemId);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(itemId);
    }
    return item;
  },

  /**
   * Resolve a `rankIssue` placement to a concrete `backlogRank` by reading the
   * named neighbours' ranks (workspace-gated) and minting a key between them.
   * Absent / unfound neighbours collapse to an open bound (`keyBetween` accepts
   * nulls): only `afterId` → prepend; only `beforeId` → append; neither → the
   * first key. A named neighbour that doesn't exist in the workspace is a 404.
   */
  async resolveNeighbourRank(placement: RankPlacementInput, ctx: ServiceContext): Promise<string> {
    const ids = [placement.beforeId, placement.afterId].filter(
      (id): id is string => typeof id === 'string',
    );
    const ranks = await workItemRepository.findBacklogRankByIds(ids, ctx.workspaceId);
    const rankOf = (id: string | undefined): string | null => {
      if (id === undefined) return null;
      const hit = ranks.find((r) => r.id === id);
      if (!hit) throw new WorkItemNotFoundError(id);
      return hit.backlogRank;
    };
    return keyBetween(rankOf(placement.beforeId), rankOf(placement.afterId));
  },
};

/**
 * Resolve the rank for `assignToSprint`: a named neighbour pair ranks the issue
 * between them within the target sprint; an empty placement appends it to the
 * END of the sprint (the sprint's current max rank + 1, the Jira default). The
 * append branch uses the bounded boundary read (`findBoundaryBacklogRank`),
 * never a full sprint scan.
 */
async function resolveRank(
  projectId: string,
  workspaceId: string,
  sprintId: string,
  placement: RankPlacementInput | undefined,
  tx: Prisma.TransactionClient,
): Promise<string> {
  if (placement && (placement.beforeId !== undefined || placement.afterId !== undefined)) {
    const ids = [placement.beforeId, placement.afterId].filter(
      (id): id is string => typeof id === 'string',
    );
    const ranks = await workItemRepository.findBacklogRankByIds(ids, workspaceId, tx);
    const rankOf = (id: string | undefined): string | null => {
      if (id === undefined) return null;
      const hit = ranks.find((r) => r.id === id);
      if (!hit) throw new WorkItemNotFoundError(id);
      return hit.backlogRank;
    };
    return keyBetween(rankOf(placement.beforeId), rankOf(placement.afterId));
  }
  // No placement → append to the bottom of the sprint.
  const maxRank = await workItemRepository.findBoundaryBacklogRank(
    projectId,
    workspaceId,
    sprintId,
    'max',
    tx,
  );
  return keyForAppend(maxRank);
}

/** Clamp a requested page size to [1, MAX]; default when absent/NaN. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return BACKLOG_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_BACKLOG_PAGE_SIZE);
}

/**
 * Turn a `take + 1` over-fetch into a `RankedIssuePageDto`: the extra row (if
 * present) signals a next page and supplies the cursor; the page itself is
 * trimmed back to `take` and mapped to summary DTOs.
 */
function buildPage(
  rows: Awaited<ReturnType<typeof workItemRepository.findBacklogPage>>,
  take: number,
  totalCount: number,
): RankedIssuePageDto {
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  // When hasMore, the page is exactly `take` rows, so its last row is rows[take-1].
  const nextCursor = hasMore ? rows[take - 1]!.id : null;
  return { items: page.map(toWorkItemSummaryDto), nextCursor, totalCount };
}
