import { homeService, type HomeActorContext } from '@/lib/services/homeService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  PLANNING_TAB_CEILING,
  workbenchPlanningService,
} from '@/lib/services/workbenchPlanningService';
import type { HomePageDto, HomeTabCountsDto } from '@/lib/dto/home';
import type {
  WorkbenchWindowContentDto,
  WorkbenchWindowDto,
  WorkbenchWorkItemWindowDto,
} from '@/lib/dto/workbench';
import type { WorkbenchTab } from '@/lib/workbench/tab';

// ONE WORKBENCH READ (Story MOTIR-8539 · Subtask MOTIR-8573) — the active tab's
// window and every strip count, from one server pass.
//
// ⚠️ THIS IS THE ONE PAIRING IN THE CODEBASE. `app/(authed)/workbench/page.tsx`
// renders a work-item tab from {@link workbenchWindowService.read}, and
// `GET /api/workbench/window` answers from it, so the page's first paint and a
// client applier's re-read cannot be paired two different ways. The window and
// the counts are separate reads issued together in ONE `Promise.all`, exactly as
// the page issued them before: the guarantee that they agree is the same one the
// page always had — one pass, delivered together — and not a transaction.
//
// ⚠️ IT COMPOSES THE READS THAT ALREADY DECIDE ACCESS and adds none of its own:
// a work-item tab is `homeService`'s list for that tab, To approve is
// `approvalGatesService.listAwaitingMe` (as `<ApprovalsTab>` reads it) and
// Planning is `workbenchPlanningService.listMyPlansBeingWritten` at the tab's
// 50-row ceiling (as `<PlanningTab>` reads it). So a reader can receive here
// only what those reads would show them on `/workbench`.

/** The one read a work-item tab needs, chosen by tab — the partition is the read's (MOTIR-4781). */
function readWorkItemTab(
  tab: Exclude<WorkbenchTab, 'approvals' | 'planning'>,
  ctx: HomeActorContext,
  page: number,
): Promise<HomePageDto> {
  switch (tab) {
    case 'todo':
      return homeService.listToDo(ctx, { page });
    case 'in-progress':
      return homeService.listInProgress(ctx, { page });
    case 'to-fix':
      return homeService.listToFix(ctx, { page });
    case 'to-resume':
      return homeService.listToResume(ctx, { page });
    case 'finished':
      return homeService.listRecentlyFinished(ctx, { page });
    case 'watching':
      return homeService.listWatching(ctx, { page });
  }
}

/** Whether `tab` lists work items (rather than gates or plans). */
export function isWorkItemTab(
  tab: WorkbenchTab,
): tab is Exclude<WorkbenchTab, 'approvals' | 'planning'> {
  return tab !== 'approvals' && tab !== 'planning';
}

export const workbenchWindowService = {
  /**
   * The tab's window and the strip's counts, read together.
   *
   * `page` is the 1-based page a work-item tab serves, clamped to its last page
   * by the list read itself (`HomeListOptions.page`); To approve and Planning
   * have no pager and ignore it.
   */
  async read(
    ctx: HomeActorContext,
    { tab, page }: { tab: WorkbenchTab; page: number },
  ): Promise<WorkbenchWindowDto> {
    const readAt = new Date().toISOString();
    if (isWorkItemTab(tab)) {
      const [windowPage, counts, members, workflow] = await Promise.all([
        readWorkItemTab(tab, ctx, page),
        homeService.tabCounts(ctx),
        workspacesService.listMembers(ctx.workspaceId, ctx.userId),
        workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
      ]);
      return {
        tab,
        window: { kind: 'workItems', page: windowPage, members, workflow },
        counts,
        readAt,
      };
    }
    const [window, counts] = await Promise.all([readListTab(tab, ctx), homeService.tabCounts(ctx)]);
    return { tab, window, counts, readAt };
  },

  /**
   * What the page's first paint needs, in ONE wave: a work-item tab's window with
   * the counts, or — on To approve and Planning, whose rows are read inside their
   * own `<Suspense>` (MOTIR-4794) — the counts alone. One call, so the page keeps
   * the single read wave `tests/navigation/loading-boundary-guard.test.ts` holds it to.
   */
  async readFirstPaint(
    ctx: HomeActorContext,
    { tab, page }: { tab: WorkbenchTab; page: number },
  ): Promise<{ counts: HomeTabCountsDto; window: WorkbenchWorkItemWindowDto | null }> {
    if (!isWorkItemTab(tab)) return { counts: await this.readCounts(ctx), window: null };
    const read = await this.read(ctx, { tab, page });
    return { counts: read.counts, window: read.window.kind === 'workItems' ? read.window : null };
  },

  /**
   * The strip's counts alone — what the page needs on To approve and Planning,
   * whose rows are read inside their own `<Suspense>` (MOTIR-4794).
   */
  async readCounts(ctx: HomeActorContext): Promise<HomeTabCountsDto> {
    return homeService.tabCounts(ctx);
  },
};

/** To approve and Planning, read as their tab components read them. */
async function readListTab(
  tab: 'approvals' | 'planning',
  ctx: HomeActorContext,
): Promise<WorkbenchWindowContentDto> {
  if (tab === 'approvals') {
    return { kind: 'approvals', queue: await approvalGatesService.listAwaitingMe(ctx) };
  }
  return {
    kind: 'planning',
    page: await workbenchPlanningService.listMyPlansBeingWritten(ctx, {
      page: 1,
      limit: PLANNING_TAB_CEILING,
    }),
  };
}
