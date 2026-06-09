import type { Prisma, WorkItem } from '@prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { keyBetween, keyForAppend } from '@/lib/workItems/positioning';
import { toWorkItemDto, toWorkItemSummaryDto } from '@/lib/mappers/workItemMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  BulkBatchTooLargeError,
  CrossProjectSprintAssignmentError,
  SprintNotFoundError,
} from '@/lib/sprints/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CreateWorkItemInput, WorkItemDto } from '@/lib/dto/workItems';
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

/**
 * The bounded batch cap for the bulk grooming moves (Subtask 4.2.2). A
 * multi-select bulk move is ONE server transaction (atomic — the whole
 * selection moves or none does), but a transaction over an unbounded id set is
 * a footgun, so the batch is capped and an oversize request is rejected with
 * `BulkBatchTooLargeError` BEFORE any write. 100 matches `MAX_BACKLOG_PAGE_SIZE`
 * — a user can never have more than one page selected at once anyway.
 */
export const MAX_BULK_BATCH_SIZE = 100;

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
   * Assign EVERY issue in `itemIds` to a sprint in ONE transaction (Subtask
   * 4.2.2 — the multi-select "Move to sprint ▸" bulk action). Composes the
   * single-issue `assignToSprint` semantics over a bounded batch so the whole
   * selection moves atomically — a mid-batch failure rolls back ALL of it (no
   * partial move) — rather than N client round-trips. Each issue is appended to
   * the sprint's rank tail in selection order (the Jira "drops at the bottom"
   * default) and records a 1.4.6 revision; the same-project guard rejects the
   * WHOLE batch if ANY member belongs to another project (atomic — checked
   * before the first write). Duplicate ids collapse to one move. Returns the
   * moved issues' DTOs in selection order.
   *
   * Empty `itemIds` is a guarded NO-OP (returns `[]`, no transaction) — not an
   * error (`prodect-core-coverage-gate`). Throws: `BulkBatchTooLargeError` (400
   * — over the cap), `SprintNotFoundError` (404), `WorkItemNotFoundError` (404 —
   * an unknown / cross-workspace member), `CrossProjectSprintAssignmentError`
   * (422).
   */
  async bulkAssignToSprint(
    itemIds: string[],
    sprintId: string,
    ctx: ServiceContext,
  ): Promise<WorkItemDto[]> {
    const ids = dedupe(itemIds);
    if (ids.length === 0) return []; // empty-input guard — no-op, not an error
    if (ids.length > MAX_BULK_BATCH_SIZE) {
      throw new BulkBatchTooLargeError(ids.length, MAX_BULK_BATCH_SIZE);
    }

    const sprint = await sprintRepository.findById(sprintId, ctx.workspaceId);
    if (!sprint) throw new SprintNotFoundError(sprintId);

    // Load + validate the WHOLE batch before any write: a missing / foreign
    // (404) or cross-project (422) member rejects the entire move atomically.
    const items: WorkItem[] = [];
    for (const id of ids) {
      const item = await this.loadItem(id, ctx);
      if (item.projectId !== sprint.projectId) {
        throw new CrossProjectSprintAssignmentError(id, sprintId);
      }
      items.push(item);
    }

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // Append the batch to the sprint's tail. Read the boundary rank ONCE,
        // then chain `keyForAppend` so each issue ranks strictly after the
        // previous — bounded single-row writes, never an N-row renumber.
        let prevRank = await workItemRepository.findBoundaryBacklogRank(
          sprint.projectId,
          ctx.workspaceId,
          sprintId,
          'max',
          tx,
        );
        const out: WorkItemDto[] = [];
        for (const item of items) {
          const newRank = keyForAppend(prevRank);
          prevRank = newRank;
          await workItemRepository.setSprint(item.id, sprintId, tx);
          const row = await workItemRepository.setBacklogRank(item.id, newRank, tx);
          await workItemRevisionsService.recordRevision(
            {
              workItemId: item.id,
              changedById: ctx.userId,
              changeKind: 'updated',
              diff: {
                sprintId: { from: item.sprintId, to: sprintId },
                backlogRank: { from: item.backlogRank, to: newRank },
              },
            },
            tx,
          );
          out.push(toWorkItemDto(row));
        }
        return out;
      },
    );
  },

  /**
   * Move EVERY issue in `itemIds` back to the backlog (`sprintId = null`) in ONE
   * transaction (Subtask 4.2.2 — the multi-select "Move to backlog" bulk
   * action). Composes the single-issue `moveToBacklog` semantics over a bounded
   * batch (atomic — all or none). Each issue keeps its `backlogRank`, so it
   * re-appears in the backlog in rank order; an issue already in the backlog is
   * a per-item no-op (no write, no revision), exactly as the single-issue path.
   * Records a 1.4.6 revision per issue that actually moved. Duplicate ids
   * collapse. Returns the issues' DTOs in selection order.
   *
   * Empty `itemIds` is a guarded NO-OP (returns `[]`). Throws:
   * `BulkBatchTooLargeError` (400), `WorkItemNotFoundError` (404).
   */
  async bulkMoveToBacklog(itemIds: string[], ctx: ServiceContext): Promise<WorkItemDto[]> {
    const ids = dedupe(itemIds);
    if (ids.length === 0) return []; // empty-input guard — no-op, not an error
    if (ids.length > MAX_BULK_BATCH_SIZE) {
      throw new BulkBatchTooLargeError(ids.length, MAX_BULK_BATCH_SIZE);
    }

    // Load + workspace-gate the whole batch before any write (a foreign member
    // is a 404 and aborts the entire move).
    const items: WorkItem[] = [];
    for (const id of ids) {
      items.push(await this.loadItem(id, ctx));
    }

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const out: WorkItemDto[] = [];
        for (const item of items) {
          if (item.sprintId === null) {
            out.push(toWorkItemDto(item)); // already in the backlog — no-op
            continue;
          }
          const row = await workItemRepository.setSprint(item.id, null, tx);
          await workItemRevisionsService.recordRevision(
            {
              workItemId: item.id,
              changedById: ctx.userId,
              changeKind: 'updated',
              diff: { sprintId: { from: item.sprintId, to: null } },
            },
            tx,
          );
          out.push(toWorkItemDto(row));
        }
        return out;
      },
    );
  },

  /**
   * Create an issue straight into the backlog or a sprint (Subtask 4.2.2 — the
   * inline "+ Create issue" row). The backlog-domain entry point that the 4.2
   * UI binds to; it REUSES `workItemsService.createWorkItem` rather than
   * re-implementing creation, so key allocation, the initial-status seed, the
   * project-edit gate, the create revision, AND the create-time rank-append all
   * come for free — and, when `input.sprintId` is set, the issue is born already
   * assigned to that sprint (same-project guarded), appended to the sprint tail,
   * in createWorkItem's single transaction (so create + assignment commit or
   * roll back together). `projectId` is supplied separately (from the active
   * project) so the caller can't smuggle a foreign project through the body.
   *
   * Throws whatever `createWorkItem` throws — incl. `SprintNotFoundError` (404)
   * / `CrossProjectSprintAssignmentError` (422) for a bad `sprintId`.
   */
  async createBacklogIssue(
    projectId: string,
    input: Omit<CreateWorkItemInput, 'projectId'>,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return workItemsService.createWorkItem({ ...input, projectId }, ctx);
  },

  /**
   * One BOUNDED page of a project's backlog (`sprintId IS NULL`) in
   * `backlogRank` order, plus the total count (finding #57 — never load-all).
   * `cursor` is the last id from the previous page; `limit` is clamped to
   * [1, 100] (default 50). Returns lighter `WorkItemSummaryDto` rows.
   */
  async getBacklog(
    projectId: string,
    options: { cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<RankedIssuePageDto> {
    const take = clampLimit(options.limit);
    const rows = await workItemRepository.findBacklogPage(projectId, ctx.workspaceId, {
      take,
      cursor: options.cursor,
    });
    const totalCount = await workItemRepository.countBacklog(projectId, ctx.workspaceId);
    return buildPage(rows, take, totalCount);
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

/**
 * Collapse a bulk selection to a deduped id list, preserving first-seen order
 * (a selection is a SET — the same id twice must not be moved/ranked twice).
 */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
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
