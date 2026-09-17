import { withWorkspaceContext } from '@/lib/workspaces';
import {
  workItemRepository,
  HOME_SLICE_DONE,
  HOME_SLICE_IN_PROGRESS,
  HOME_SLICE_TODO,
} from '@/lib/repositories/workItemRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  finishedWindowStart,
  resolveActiveProjectScope,
  type HomeActorContext,
} from '@/lib/services/homeService';
import {
  WORKBENCH_TAB_KEYS,
  type WorkbenchTabKey,
  type WorkbenchTabWatermarkDto,
  type WorkbenchWatermarkDto,
} from '@/lib/dto/workbench';
import {
  decodeWatermarkCursor,
  encodeWatermarkCursor,
  movedTabs,
} from '@/lib/workbench/watermarkCursor';

// THE WATERMARK READ (Story MOTIR-5238 · Subtask MOTIR-5240) — one cheap read
// answering, for one reader in one project: *has anything you can see changed
// since the watermark you hold, and in which tabs?*
//
// It is the only thing the Workbench stream polls, so its cost is paid once per
// second per open Workbench. Two properties are therefore load-bearing:
//
//   * IT RETURNS A SIGNAL, NEVER CONTENT. Per tab, a size and a freshness — no
//     rows, no titles, no ids. The client re-reads through the reads it already
//     has, which keeps every access decision in the reads that already make it
//     and means this read cannot leak a row a reader may not see.
//   * ITS OUTPUT IS BOUNDED BY CONSTRUCTION. Five pairs and a cursor, whatever
//     the project's size. That is what makes polling affordable at all.
//
// ⚠️ IT COMPOSES THE SHIPPED PREDICATES AND DEFINES NO SIXTH. The four work tabs
// are `homeService`'s assignee-OR-reporter union, scoped by
// `resolveActiveProjectScope`; the approvals tab is the gate's own routing
// predicate, reached exactly as `homeService.tabCounts` reaches it — the scoped
// project ids plus the reader. A watermark derived from its own idea of who sees
// what drifts from those five ASYMMETRICALLY and SILENTLY: nudging on something
// the reader cannot see is merely wasteful, while failing to nudge on something
// they CAN see is the feature not working, for one tab, for one kind of change,
// with nothing red anywhere because the list is still correct whenever anybody
// reloads.
//
// ⚠️ AND IT ADDS NO `db` AND NO TRANSACTION OF ITS OWN. One
// `withWorkspaceContext` — the same door every Workbench read already goes
// through, and the thing that binds `app.workspace_id` so the RLS-gated reads
// answer at all — with the repositories underneath it (the 4-layer rule).

/**
 * The reading for every tab, taken inside ONE workspace context.
 *
 * ⚠️ FIVE STATEMENTS, NOT TEN. Each work tab's size and freshness come back from
 * a single `aggregate` (`_count` + `_max` over one `where`), because a second
 * round trip per tab is a standing per-second cost rather than a tidiness
 * question. Watching is the one exception and the table's shape is why: `watcher`
 * carries no `updatedAt` of its own, so its freshness lives on the work item
 * across a relation Prisma's `_max` cannot reach, and it costs one extra one-row
 * read. Issued together under one context, exactly as `tabCounts` issues its
 * five counts — the project scope is the expensive half and every tab needs the
 * same one.
 */
async function readTabs(
  ctx: HomeActorContext,
): Promise<Record<WorkbenchTabKey, WorkbenchTabWatermarkDto>> {
  return withWorkspaceContext(ctx, async (tx) => {
    const projectScopes = await resolveActiveProjectScope(ctx, tx);
    const [toDo, inProgress, recentlyFinished, approvals, watching] = await Promise.all([
      workItemRepository.watermarkByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice: HOME_SLICE_TODO },
        tx,
      ),
      workItemRepository.watermarkByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice: HOME_SLICE_IN_PROGRESS },
        tx,
      ),
      // The finished window is part of the PREDICATE here, exactly as it is in
      // the list and the count — a reading taken without it would be a
      // freshness for a different set, and the tab would nudge on work that
      // finished in June.
      workItemRepository.watermarkByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice: HOME_SLICE_DONE, sortField: 'completedAt', since: finishedWindowStart() },
        tx,
      ),
      // ⚠️ THE GATE'S OWN PREDICATE, and deliberately NOT the membership `OR`
      // above it. A decision queue routes to exactly one recipient
      // (`assigneeId ?? reporterId`, `docs/decisions/approval-gates.md` §2), and
      // the scope is built here the same way `homeService.tabCounts` builds it
      // for the badge — the browsable project ids, which are `[]` for a reader
      // who may not browse their active project, and the reader.
      approvalGateRepository.watermarkAwaitingRoutedTo(
        { projectIds: projectScopes.map((scope) => scope.projectId), userId: ctx.userId },
        tx,
      ),
      watcherRepository.watermarkByUser(ctx.userId, ctx.workspaceId, projectScopes, tx),
    ]);
    const pair = (reading: { count: number; latest: Date | null }): WorkbenchTabWatermarkDto => ({
      count: reading.count,
      latest: reading.latest?.toISOString() ?? null,
    });
    return {
      toDo: pair(toDo),
      inProgress: pair(inProgress),
      recentlyFinished: pair(recentlyFinished),
      approvals: pair(approvals),
      watching: pair(watching),
    };
  });
}

export const workbenchWatermarkService = {
  /**
   * READ the watermark, and say which tabs have moved since the one presented.
   *
   * `since` is the opaque cursor the caller last received, or nothing at all.
   * The three cases are deliberately different and the difference is the whole
   * of the resume contract:
   *
   *   * **ABSENT** — this reader has seen nothing, so nothing has moved under
   *     them. `moved: []`, and the surface they are rendering is its own first
   *     observation.
   *   * **READABLE** — the tabs whose pair differs, and only those. Replaying
   *     the same cursor is therefore idempotent: it names nothing the second
   *     time, which is what makes a reconnect neither a replay nor a gap.
   *   * **UNREADABLE** — a cursor from another build, truncated, or edited.
   *     EVERY tab, because the reader may be holding a list this stream can no
   *     longer speak about, and one redundant re-read is cheaper than a list
   *     that silently stops updating.
   */
  async read(ctx: HomeActorContext, since?: string | null): Promise<WorkbenchWatermarkDto> {
    const tabs = await readTabs(ctx);
    const presented = decodeWatermarkCursor(since);
    const moved: WorkbenchTabKey[] =
      since && presented === null ? [...WORKBENCH_TAB_KEYS] : movedTabs(presented, tabs);
    return { cursor: encodeWatermarkCursor(tabs), tabs, moved };
  },
};
