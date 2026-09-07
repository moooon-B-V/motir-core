import type { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  workItemRepository,
  HOME_SLICE_DONE,
  HOME_SLICE_IN_PROGRESS,
  HOME_SLICE_TODO,
  HOME_SLICE_UNFINISHED,
  type HomeCategorySlice,
  type HomeProjectScope,
  type HomeWorkItemRow,
  type WatchingCursor,
  type WatchingGroup,
} from '@/lib/repositories/workItemRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { toHomeWorkItemRowDto } from '@/lib/mappers/homeMappers';
import {
  decodeHomeCursor,
  decodeWatchingCursor,
  encodeHomeCursor,
  encodeWatchingCursor,
} from '@/lib/workbench/cursor';
import type { HomePageDto, HomeTabCountsDto } from '@/lib/dto/home';

// The Home landing surface's read layer (Story MOTIR-2649 · Subtask
// MOTIR-2651) — the business logic behind `/home`'s two tabs. Orchestrates the
// repositories, owns the ACCESS decision, and maps to DTOs; the repositories
// stay leaves (CLAUDE.md § the 4-layer architecture).
//
// ⚠️ ACTIVE-PROJECT-SCOPED, like every other list surface (MOTIR-2761). This
// read was workspace-scoped until 2026-08-17 and argued for it from external
// precedent — Jira "Your work", Linear Inbox, Plane Home. In all three that
// surface sits ABOVE the project selector; Motir imported the scope without the
// placement and then put `/home` FIRST in the PROJECT tier of the rail, under a
// project switcher the shell renders on every authed page. A switcher that
// changes nothing on the first screen after sign-in teaches the reader that the
// context path is decoration, so the scope moved to match the placement.
//
// The cross-project question — "what is on me across this whole WORKSPACE" — is
// retained rather than dropped: it becomes a workspace-tier surface, MOTIR-2920
// (`docs/decisions/home-scope.md` §3). It is not this read.

/** The page size a Workbench tab reads when the caller names none. */
export const HOME_PAGE_SIZE = 25;

/**
 * How far back "recently finished" reaches, in DAYS (Story MOTIR-4777 ·
 * MOTIR-4781).
 *
 * A NAMED constant rather than an inline `7`, because it is the number the
 * surface has to put in words — the tab draws a window caption, and a caption
 * and a predicate that disagree is a list that reads as broken rather than as
 * bounded. Applied in SQL against `completedAt`, never against `updatedAt`, and
 * never by filtering AFTER the read: a post-read filter shortens pages instead
 * of failing, and "the list sometimes ends early" is a bug nobody traces back
 * to a date comparison.
 */
export const HOME_FINISHED_WINDOW_DAYS = 7;

/** The start of the finished window, as of now. */
function finishedWindowStart(): Date {
  return new Date(Date.now() - HOME_FINISHED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
/** The ceiling a caller-supplied page size is clamped to. */
const HOME_MAX_PAGE_SIZE = 100;

/**
 * Who is reading, and WHICH PROJECT they are reading. The project id is the
 * caller's ACTIVE project — `getActiveProject()` on the page, the same resolver
 * `/items`, `/ready` and `/boards` use — and it is REQUIRED rather than
 * optional, so there is no call shape that quietly reverts to the workspace.
 */
export interface HomeActorContext extends AccessActorContext {
  projectId: string;
}

export interface HomeListOptions {
  /** The opaque token from a previous page's `nextCursor`; omit for page one. */
  cursor?: string | null;
  limit?: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return HOME_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit < 1) return HOME_PAGE_SIZE;
  return Math.min(Math.floor(limit), HOME_MAX_PAGE_SIZE);
}

/**
 * The ACTIVE project — if the actor may browse it — paired with ITS OWN
 * done-category status keys. The two axes Home's reads scope on, now over a set
 * of at most one.
 *
 * ⚠️ THE ACCESS DECISION IS STILL THE SERVICE'S, and narrowing the project axis
 * did not retire it. RLS is WORKSPACE-rooted; the thing Home can leak is a
 * PRIVATE PROJECT INSIDE the actor's own workspace, which RLS admits and
 * `canBrowse` does not — and an actor's ACTIVE project can be one they may not
 * browse (the pointer is a stored member preference, and project membership can
 * be revoked under it). Such a reader gets an EMPTY scope set, so the read is
 * empty rather than an error — the no-existence-leak convention every other
 * project gate follows.
 *
 * ⚠️ AND THE SHAPE STAYS A `HomeProjectScope[]`, not a bare `projectId`. The
 * lifecycle axis MOTIR-2758 added travels inside it precisely so no call shape
 * can scope the projects without also deciding what counts as finished in each
 * of them; collapsing to an id here would be the narrowing quietly dropping it.
 *
 * The result is passed INTO the query, never applied to its output. Filtering
 * after the read would shorten pages instead of failing, and "the list sometimes
 * ends early" is a bug nobody traces back to an access rule.
 */
async function activeProjectScope(
  ctx: HomeActorContext,
  tx: Prisma.TransactionClient,
): Promise<HomeProjectScope[]> {
  const project = await projectRepository.findById(ctx.projectId, tx);
  // The workspace check is belt AND braces: RLS already bounds the read to
  // `ctx.workspaceId`, but a stale active-project pointer is exactly the input
  // that would otherwise cross a tenant on the day RLS is relaxed.
  if (!project || project.workspaceId !== ctx.workspaceId) return [];
  const browsable = await projectAccessService.filterBrowsable([project], ctx, tx);
  if (browsable.length === 0) return [];

  // The LIFECYCLE axis, resolved beside the access one and passed into the query
  // with it (MOTIR-2758, WIDENED by MOTIR-4781). It used to resolve only the
  // TERMINAL slice, because there was one list and finished work was the thing
  // to hide. The Workbench splits that list into three ALONG this axis, so the
  // whole partition is resolved — one query, three groups — and the reads pick
  // the categories each of them is for. Same table, same RLS gate, same `tx`;
  // what changed is how much of the answer is kept.
  //
  // ⚠️ Threaded `tx`, not a second context. `workflow_status` is RLS-gated on
  // `app.workspace_id` (`…_add_workflow_status_and_transition_rls`), and that GUC
  // is bound by the `withWorkspaceContext` transaction the caller is already
  // inside. Read on any other connection under the non-bypass `motir_app` role
  // and the answer is NOTHING — an empty done-key set, an exclusion that
  // silently no-ops in production, and a test suite that stays green because it
  // connects as the owner.
  const byCategory = await workflowsService.getStatusKeysByCategoryByProjects(
    [ctx.projectId],
    ctx.workspaceId,
    tx,
  );
  return [
    {
      projectId: ctx.projectId,
      /* istanbul ignore next -- defensive: the resolver seeds an entry for every requested project id, so the `??` arm is unreachable */
      statusKeysByCategory: byCategory.get(ctx.projectId) ?? {
        todo: [],
        in_progress: [],
        done: [],
      },
    },
  ];
}

/**
 * Shape one repository page into the wire DTO.
 *
 * The reads are asked for `limit + 1` rows: the extra row is the HAS-MORE
 * probe, dropped before mapping. A `nextCursor` minted from a row that is not
 * returned is what makes the boundary exact — the alternative (mint a cursor
 * whenever the page came back full) hands the caller a cursor to an empty page
 * on every list whose length is a multiple of the page size.
 */
function toPage(rows: HomeWorkItemRow[], limit: number, viewerId: string): HomePageDto {
  return pageWith(rows, limit, viewerId, (row) =>
    encodeHomeCursor({ at: row.updatedAt, id: row.id }),
  );
}

/**
 * The same shaping, with the cursor MINTED BY THE CALLER — because each read
 * pages on its own axis and a cursor minted from a different pair than the read
 * orders by is a page boundary that drifts.
 */
function pageWith(
  rows: HomeWorkItemRow[],
  limit: number,
  viewerId: string,
  mint: (row: HomeWorkItemRow) => string,
): HomePageDto {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((row) => toHomeWorkItemRowDto(row, viewerId)),
    nextCursor: hasMore && last ? mint(last) : null,
  };
}

export const homeService = {
  /**
   * THE MEMBERSHIP PREDICATE, in one place — every item in the ACTIVE PROJECT
   * where the actor is the assignee **OR** the reporter, each item exactly
   * once, cursor-paged, narrowed to the lifecycle categories the caller asks
   * for.
   *
   * The two predicates are merged into one list rather than split into two tabs
   * because Motir is AI-native: an item created through the MCP carries the
   * creating user as REPORTER, and that same user runs it rather than assigning
   * it onward, so reporter and assignee are usually one person wearing two hats.
   * The dedupe requirement exists ONLY because of that merge — and it is the
   * database's job (a single `OR`), not the service's, so it holds across a page
   * boundary and not merely within one page.
   *
   * ⚠️ THE THREE WORK TABS ARE THIS ONE READ, PARTITIONED (MOTIR-4781). They
   * share the membership `OR`, the access decision, the project scope, the
   * dedupe and the keyset; what differs is which `workflow_status.category`
   * each is for, and — for Recently finished — the window and the axis. Writing
   * them as three reads would be three chances for the dedupe or the scope to
   * drift, on a surface whose whole promise is that the tabs PARTITION the same
   * set.
   */
  async listSlice(
    ctx: HomeActorContext,
    slice: HomeCategorySlice,
    options: HomeListOptions = {},
  ): Promise<HomePageDto> {
    const limit = clampLimit(options.limit);
    const cursor = decodeHomeCursor(options.cursor);
    const rows = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await activeProjectScope(ctx, tx);
      return workItemRepository.findByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        { projectScopes, slice, take: limit + 1, cursor },
        tx,
      );
    });
    return toPage(rows, limit, ctx.userId);
  },

  /** TO DO — nothing has been started. */
  async listToDo(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    return homeService.listSlice(ctx, HOME_SLICE_TODO, options);
  },

  /**
   * IN PROGRESS — what is moving.
   *
   * On this product that tab is where a human meets what their agents did: a
   * card at `implemented` or `in_review` is an agent's finished output waiting
   * for a person, not idle work, and it is invisible in a list sorted by time.
   * It holds every `in_progress`-CATEGORY status, which is why renaming a
   * column cannot empty it.
   */
  async listInProgress(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    return homeService.listSlice(ctx, HOME_SLICE_IN_PROGRESS, options);
  },

  /**
   * RECENTLY FINISHED — the week's work, which this surface has never shown.
   *
   * ⚠️ TWO THINGS DIFFER FROM ITS SIBLINGS AND THEY ARE ONE DECISION: it orders
   * by `completedAt` and it pages on `completedAt`. A read ordered by one
   * column and paged on another repeats and drops rows silently as items are
   * updated underneath the reader.
   *
   * ⚠️ AND THE WINDOW IS `completedAt`, NEVER `updatedAt`. `/home` excluded
   * done work outright (MOTIR-2758), so nothing here is a narrowing of an
   * existing list — this is a dataset the product could not express until
   * MOTIR-4780 stored the moment a card finished. Building the window on
   * `updatedAt` would list work finished in June that somebody re-titled today,
   * and would do it without ever erroring.
   */
  async listRecentlyFinished(
    ctx: HomeActorContext,
    options: HomeListOptions = {},
  ): Promise<HomePageDto> {
    const limit = clampLimit(options.limit);
    const cursor = decodeHomeCursor(options.cursor);
    const rows = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await activeProjectScope(ctx, tx);
      return workItemRepository.findByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        {
          projectScopes,
          slice: HOME_SLICE_DONE,
          take: limit + 1,
          cursor,
          sortField: 'completedAt',
          since: finishedWindowStart(),
        },
        tx,
      );
    });
    return pageWith(rows, limit, ctx.userId, (row) =>
      // The probe row's `completedAt` is non-null by construction: the read
      // filters on `completedAt >= <window>`, so a null could not have matched.
      encodeHomeCursor({ at: row.completedAt ?? row.updatedAt, id: row.id }),
    );
  },

  /**
   * MY WORK — everything of the reader's that is not finished.
   *
   * ⚠️ TRANSITIONAL, and owned by MOTIR-4782. The shipped `/home` page renders
   * two tabs and this card changes no surface, so the old read survives — as a
   * NAME over the same partition, `['todo', 'in_progress']`, which is exactly
   * the set MOTIR-2758's done-EXCLUSION described. Expressing it as the union
   * of the two work categories rather than as a second implementation is what
   * makes it impossible for it to disagree with the tabs that replace it.
   *
   * @deprecated Remove with `/home` when MOTIR-4782 lands `/workbench`.
   */
  async listMyWork(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    return homeService.listSlice(ctx, HOME_SLICE_UNFINISHED, options);
  },

  /**
   * EVERY tab's count, in one workspace context.
   *
   * The tab strip shows the size of the tabs you are NOT looking at as well as
   * the one you are, so a reader can tell whether switching is worth it — which
   * means the numbers are the size of each SET, not of the current page.
   * Resolved together because the project scope — the access check plus that
   * project's status partition — is the expensive half and every count needs
   * the same one.
   *
   * ⚠️ ONE ROUND TRIP, not one per tab. The counts are issued together inside a
   * single `withWorkspaceContext` transaction; a per-tab call would re-run the
   * access check and the status resolution four times for one render.
   */
  async tabCounts(ctx: HomeActorContext): Promise<HomeTabCountsDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await activeProjectScope(ctx, tx);
      const [toDo, inProgress, recentlyFinished, watching] = await Promise.all([
        workItemRepository.countByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          { slice: HOME_SLICE_TODO },
          tx,
        ),
        workItemRepository.countByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          { slice: HOME_SLICE_IN_PROGRESS },
          tx,
        ),
        workItemRepository.countByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          { slice: HOME_SLICE_DONE, sortField: 'completedAt', since: finishedWindowStart() },
          tx,
        ),
        watcherRepository.countByUser(ctx.userId, ctx.workspaceId, projectScopes, tx),
      ]);
      return {
        toDo,
        inProgress,
        recentlyFinished,
        // The sibling story's number (MOTIR-4778). This story draws the slot
        // and ships nothing behind it, so the honest value is zero rather than
        // an absent field the strip would have to special-case.
        approvals: 0,
        watching,
        // Transitional — `/home`'s two-tab strip, until MOTIR-4782 replaces it.
        // Derived from the two above rather than counted again, so the old
        // badge and the new ones cannot disagree.
        myWork: toDo + inProgress,
      };
    });
  },

  /**
   * WATCHING — the items the actor watches IN THE ACTIVE PROJECT, with what is
   * MOVING ordered ahead of what is WAITING.
   *
   * A genuinely different audience from the work tabs, not a partition of them:
   * an item the actor both owns and watches is returned by BOTH reads. That is
   * not a bug to fix at this layer — the two reads answer different questions,
   * and MOTIR-2655 asserts the overlap explicitly so nobody "corrects" it later.
   *
   * ⚠️ MOTIR-4781 GAVE IT AN ORDER, NOT A FILTER. Membership is untouched and
   * nothing is dropped. The cursor carries the GROUP as well as the position,
   * because the read walks the two groups in sequence and a position alone
   * would be ambiguous between them (`watcherRepository.listByUser`).
   */
  async listWatching(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    const limit = clampLimit(options.limit);
    const cursor = decodeWatchingCursor(options.cursor);
    const { rows, inProgressKeys } = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await activeProjectScope(ctx, tx);
      const found = await watcherRepository.listByUser(
        ctx.userId,
        ctx.workspaceId,
        { projectScopes, take: limit + 1, cursor },
        tx,
      );
      return {
        rows: found,
        inProgressKeys: new Set(
          projectScopes.flatMap((sc) => [...sc.statusKeysByCategory.in_progress]),
        ),
      };
    });
    return pageWith(rows, limit, ctx.userId, (row) => {
      const group: WatchingGroup = inProgressKeys.has(row.status) ? 'in_progress' : 'todo';
      const next: WatchingCursor = { at: row.updatedAt, id: row.id, group };
      return encodeWatchingCursor(next);
    });
  },
};
