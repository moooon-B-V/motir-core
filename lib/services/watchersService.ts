import type { Prisma, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toWatcherDto } from '@/lib/mappers/watcherMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { WatchersForbiddenError, WatcherTargetCannotViewError } from '@/lib/watchers/errors';
import type { WatcherDto, WatchersPageDto, WatchStateDto } from '@/lib/dto/watchers';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Watchers service (Story 5.4 · Subtask 5.4.4) — the watch mechanics over the
// 5.4.1 watcher repository. Owns the verified permission split, the
// view-access validation, transactions, and DTO mapping. Routes are HTTP-only
// (CLAUDE.md).
//
// The watcher contract (mirror-verified in the Story 5.4 description):
//   * Watching is NOT editing — ANYONE who can VIEW the issue watches
//     THEMSELVES, the read-only project `viewer` included. Self watch/unwatch
//     is therefore gated on browse alone.
//   * Add/remove OTHERS is Jira's "Manage watchers" permission: project admin
//     or workspace owner/admin (lib/projects/access.ts canManageWatchers).
//   * A watcher MUST hold view access to the issue. Jira silently DROPS a
//     violator (a documented trap); we reject with the typed
//     WatcherTargetCannotViewError (→ 422) instead — the popover surfaces it
//     inline. The same check covers "not a workspace member at all" (the
//     project gate sits beneath the workspace gate, so a non-member can never
//     browse).
//   * Idempotent everywhere: re-watching upserts into the
//     `@@unique([workItemId, userId])` key (no P2002), unwatching while not
//     watching deletes zero rows. The auto-watch hooks lean on this.
//   * Watch paths write NO work_item_revision rows (mirror: watching is not a
//     field change) and emit NO events — the 5.4.5 notification job consumes
//     the existing comment/transition events and reads watcher rows there.
//
// Auto-watch (the verified create-or-comment rule, constant-on): `autoWatch`
// is the hook `workItemsService.createWorkItem` and `commentsService.
// addComment` call INSIDE their own transactions — the watcher row commits or
// rolls back with the work it rode in on. Story 5.7's per-user opt-out
// preference is the documented seam: when it lands, this hook is the ONE
// place that consults it (the callers stay unchanged).
//
// Permission matrix: a missing / cross-workspace / non-browsable issue reads
// as WorkItemNotFoundError (404, finding #44 — "you can't see it" is
// indistinguishable from "it doesn't exist") on EVERY path, the manage paths
// included (the issue must stay hidden even from a probe that would have been
// 403 on a visible one).

/** Watchers-popover page size — a bounded window, never a load-all (finding #57). */
export const WATCHER_PAGE_SIZE = 20;

export interface ListWatchersOptions {
  /** Resume strictly after this page cursor (the previous page's `nextCursor`). */
  cursor?: string;
}

/**
 * Resolve a work item under the hide-gates and the caller's watcher
 * capabilities on its project: a missing / cross-workspace item AND a
 * non-browsable project both read as WorkItemNotFoundError (404 — finding
 * #44). Returns the item + whether the caller may manage others.
 */
async function resolveGatedWorkItem(
  workItemId: string,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<{ item: WorkItem; canManage: boolean }> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
  const caps = await projectAccessService.getWatcherCapabilities(item.projectId, ctx, tx);
  if (!caps.canBrowse) throw new WorkItemNotFoundError(workItemId);
  return { item, canManage: caps.canManageWatchers };
}

/**
 * Assert the TARGET user may VIEW the issue — the typed fix of Jira's
 * silent-drop trap. Resolves the target's own capabilities on the project
 * (workspace membership included: a non-member's `canBrowse` is always
 * false, so "must be a workspace member who can view" is ONE check — and a
 * nonexistent user id fails the same way, no FK error path).
 */
async function assertTargetCanView(
  item: WorkItem,
  targetUserId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const caps = await projectAccessService.getCapabilities(
    item.projectId,
    { userId: targetUserId, workspaceId: item.workspaceId },
    tx,
  );
  if (!caps.canBrowse) throw new WatcherTargetCannotViewError();
}

export const watchersService = {
  /**
   * Watch the issue YOURSELF — needs only view access (a `viewer` may watch;
   * watching is not editing). Idempotent: re-watching is absorbed by the
   * unique (upsert). Returns the new state + count for the eye control's
   * optimistic reconcile. No revision, no event.
   */
  async watch(workItemId: string, ctx: ServiceContext): Promise<WatchStateDto> {
    return db.$transaction(async (tx) => {
      const { item } = await resolveGatedWorkItem(workItemId, ctx, tx);
      await watcherRepository.add(item.id, ctx.userId, tx);
      const watcherCount = await watcherRepository.countByWorkItem(item.id, tx);
      return { watching: true, watcherCount };
    });
  },

  /**
   * Stop watching YOURSELF. Idempotent: unwatching while not watching deletes
   * zero rows and still returns the (unchanged) state. View-gated like watch.
   */
  async unwatch(workItemId: string, ctx: ServiceContext): Promise<WatchStateDto> {
    return db.$transaction(async (tx) => {
      const { item } = await resolveGatedWorkItem(workItemId, ctx, tx);
      await watcherRepository.remove(item.id, ctx.userId, tx);
      const watcherCount = await watcherRepository.countByWorkItem(item.id, tx);
      return { watching: false, watcherCount };
    });
  },

  /**
   * Add ANOTHER user as a watcher — the "Manage watchers" half (project admin
   * / workspace owner-admin). The target must be a workspace member who can
   * VIEW the issue, or the typed WatcherTargetCannotViewError (→ 422) rejects
   * — never the mirror's silent drop. Idempotent on an already-watching
   * target. Returns the added watcher row (the popover appends it) + count.
   */
  async addWatcher(
    workItemId: string,
    targetUserId: string,
    ctx: ServiceContext,
  ): Promise<{ watcher: WatcherDto; watcherCount: number }> {
    return db.$transaction(async (tx) => {
      const { item, canManage } = await resolveGatedWorkItem(workItemId, ctx, tx);
      if (!canManage) throw new WatchersForbiddenError('add');
      await assertTargetCanView(item, targetUserId, tx);

      const row = await watcherRepository.add(item.id, targetUserId, tx);
      const [user] = await userRepository.findByIds([targetUserId], tx);
      const watcherCount = await watcherRepository.countByWorkItem(item.id, tx);
      return { watcher: toWatcherDto({ ...row, user: user! }), watcherCount };
    });
  },

  /**
   * Remove a user from the watcher list — "Manage watchers"-gated like
   * addWatcher (your OWN row comes off via `unwatch`, no admin needed).
   * Idempotent on a non-watching target. Returns the new count.
   */
  async removeWatcher(
    workItemId: string,
    targetUserId: string,
    ctx: ServiceContext,
  ): Promise<{ watcherCount: number }> {
    return db.$transaction(async (tx) => {
      const { item, canManage } = await resolveGatedWorkItem(workItemId, ctx, tx);
      if (!canManage) throw new WatchersForbiddenError('remove');
      await watcherRepository.remove(item.id, targetUserId, tx);
      const watcherCount = await watcherRepository.countByWorkItem(item.id, tx);
      return { watcherCount };
    });
  },

  /**
   * One cursor-paged window of the issue's watchers (finding #57 — never a
   * load-all): up to {@link WATCHER_PAGE_SIZE} rows, oldest-first (stable
   * roster order), each as Avatar · name. View-gated like every read.
   * `canManage` rides along so the popover knows whether to render the
   * add/remove affordances without a second round-trip.
   */
  async listWatchers(
    workItemId: string,
    options: ListWatchersOptions,
    ctx: ServiceContext,
  ): Promise<WatchersPageDto> {
    const { item, canManage } = await resolveGatedWorkItem(workItemId, ctx);

    // take+1 probes for a next page without a second count read.
    const window = await watcherRepository.listByWorkItem(item.id, {
      take: WATCHER_PAGE_SIZE + 1,
      cursor: options.cursor,
    });
    const page = window.slice(0, WATCHER_PAGE_SIZE);
    const hasMore = window.length > WATCHER_PAGE_SIZE;
    const totalCount = await watcherRepository.countByWorkItem(item.id);

    return {
      watchers: page.map(toWatcherDto),
      totalCount,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      canManage,
    };
  },

  /**
   * The auto-watch hook (the verified create-or-comment rule, constant-on):
   * called by `workItemsService.createWorkItem` and `commentsService.
   * addComment` INSIDE their own transactions, AFTER their permission gates
   * have passed — so no re-gate here, just the idempotent upsert. When Story
   * 5.7's per-user auto-watch preference lands, THIS is the one seam that
   * consults it; the callers stay unchanged.
   */
  async autoWatch(workItemId: string, userId: string, tx: Prisma.TransactionClient): Promise<void> {
    await watcherRepository.add(workItemId, userId, tx);
  },
};
