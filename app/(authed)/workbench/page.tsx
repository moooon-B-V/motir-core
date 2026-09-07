import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Circle, CircleCheck, CircleDot, Inbox, Star } from 'lucide-react';
import type { ReactNode } from 'react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { HOME_FINISHED_WINDOW_DAYS, homeService } from '@/lib/services/homeService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import type { HomeActorContext } from '@/lib/services/homeService';
import type { HomePageDto } from '@/lib/dto/home';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import type { WorkbenchTab } from '@/lib/workbench/tab';
import { parseWorkbenchTab, workbenchTabHref } from '@/lib/workbench/tab';
import { ProjectsEmptyState } from '../_components/ProjectsEmptyState';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';
import { WorkbenchTabs } from './_components/WorkbenchTabs';
import { WorkbenchList } from './_components/WorkbenchList';
import { toWorkbenchRowViews } from './_components/workbenchRows';

// `/workbench` — the signed-in landing surface (Story MOTIR-2649 · MOTIR-2653,
// renamed and split by lifecycle in Story MOTIR-4777 · MOTIR-4782), per
// `design/workbench/`. A Server Component that resolves the session + the ACTIVE
// PROJECT and reads `homeService` directly (the server-component 4-layer path).
//
// ⚠️ THE ROUTE MOVED, and `/home` still answers — a 308 in `next.config.ts`'s
// `LANDING_REDIRECTS`, preserving the query string so a link to somebody's
// Watching tab survives. `AUTHED_LANDING_PATH` (`lib/navigation/landing.ts`) is
// the ONE owner of the new address; MOTIR-3373 built that constant and its guard
// precisely so this rename would be one edit rather than the nine-literal sweep
// MOTIR-3171 / MOTIR-3173 each found a survivor of.
//
// ⚠️ IT RESOLVES THE ACTIVE PROJECT, exactly like `/items`, `/ready` and
// `/boards` (MOTIR-2761). It did not until 2026-08-17, and the shell said
// otherwise the whole time: the rail's primary section is built inside
// `if (hasProject)` with this row as its FIRST entry, under a project switcher
// the top bar renders on every authed page. A switcher that changes nothing on
// the first screen after sign-in is a control that lies. The cross-project
// question is retained at the workspace tier as MOTIR-2920, not dropped
// (`docs/decisions/home-scope.md`).
//
// ⚠️ AND IT MOUNTS NO NOTIFICATIONS. An earlier shape of this story put a
// "Needs you" widget here — a second mount of the notification stream. It was
// removed (Yue, 2026-08-11) as a duplicate of the bell drawer, which is already
// on every page and carries the unread badge. Two copies of one dataset is two
// things to keep in agreement and a second answer to "where do I read these".
// This page touches nothing about notifications; do not add it back without
// reopening that decision.

// The post-auth settle target — for BOTH credential flows. `_helpers/
// shell-session.ts` waits on a RENDERED Workbench rather than on a URL that
// merely reads right (MOTIR-2645's contract: an authoritative signal, never an
// interval), so BOTH branches below carry it: a reader with no project lands on
// the create-first branch, everyone else on the list.
const WORKBENCH_TESTID = 'workbench-page';

/** The tab's own label, reused as the list's accessible name. */
const TAB_LABEL_KEY: Readonly<Record<WorkbenchTab, string>> = {
  todo: 'tabs.toDo',
  'in-progress': 'tabs.inProgress',
  finished: 'tabs.recentlyFinished',
  watching: 'tabs.watching',
  approvals: 'tabs.toApprove',
};

/**
 * The ONE read this render needs, chosen by tab.
 *
 * Four tabs each have their own service method — the partition is the READ's
 * (MOTIR-4781), not a filter applied to a shared list here — and the fifth has
 * none yet: **To approve renders its SLOT**. MOTIR-4777 draws the tab and ships
 * nothing behind it; the rows, the gate records and the approve control are the
 * sibling story's (MOTIR-4778). An empty page rather than a fifth query is what
 * makes that boundary visible: there is nothing to read, so nothing is read.
 */
function readTab(
  tab: WorkbenchTab,
  ctx: HomeActorContext,
  cursor: string | null,
): Promise<HomePageDto> {
  switch (tab) {
    case 'todo':
      return homeService.listToDo(ctx, { cursor });
    case 'in-progress':
      return homeService.listInProgress(ctx, { cursor });
    case 'finished':
      return homeService.listRecentlyFinished(ctx, { cursor });
    case 'watching':
      return homeService.listWatching(ctx, { cursor });
    case 'approvals':
      return Promise.resolve({ items: [], nextCursor: null });
  }
}

/**
 * An empty tab's drawn state — glyph, copy, and an action only where one helps.
 *
 * ⚠️ **ONLY TWO OF THE FIVE CARRY AN ACTION, and that is a decision rather than
 * an omission** (`design/workbench/design-notes.md` § Empty states). To do sends
 * you to Ready; In progress sends you to the To do TAB rather than mounting a
 * second Ready button one screen from the first. Nothing finishes work on your
 * behalf, nothing makes you watch an item, and nothing conjures an approval, so
 * those three offer no button rather than inventing one. Written as five
 * explicit arms rather than a table for exactly that reason: whether a state has
 * a button is visible where the state is, not a column somebody fills in.
 */
async function EmptyTab({ tab }: { tab: WorkbenchTab }): Promise<ReactNode> {
  const t = await getTranslations('workbench');
  // `--el-icon-muted` and the primitive's own type scale come from `EmptyState`;
  // the glyph is `aria-hidden` because the title carries the meaning.
  switch (tab) {
    case 'todo':
      return (
        <EmptyState
          icon={<Circle className="h-12 w-12" aria-hidden />}
          title={t('empty.toDo.title')}
          description={t('empty.toDo.body')}
          action={
            <Link href="/ready" className={buttonVariants({ variant: 'secondary' })}>
              <CircleDot className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
              {t('empty.toDo.action')}
            </Link>
          }
        />
      );
    case 'in-progress':
      return (
        <EmptyState
          icon={<CircleDot className="h-12 w-12" aria-hidden />}
          title={t('empty.inProgress.title')}
          description={t('empty.inProgress.body')}
          action={
            <Link
              href={workbenchTabHref('todo')}
              className={buttonVariants({ variant: 'secondary' })}
            >
              <Circle className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
              {t('empty.inProgress.action')}
            </Link>
          }
        />
      );
    case 'finished':
      return (
        <EmptyState
          icon={<CircleCheck className="h-12 w-12" aria-hidden />}
          title={t('empty.recentlyFinished.title')}
          description={t('empty.recentlyFinished.body')}
        />
      );
    case 'watching':
      return (
        <EmptyState
          icon={<Star className="h-12 w-12" aria-hidden />}
          title={t('empty.watching.title')}
          description={t('empty.watching.body')}
        />
      );
    case 'approvals':
      return (
        <EmptyState
          icon={<Inbox className="h-12 w-12" aria-hidden />}
          title={t('empty.approvals.title')}
          description={t('empty.approvals.body')}
        />
      );
  }
}

export default async function WorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  // NO ACTIVE PROJECT — carried from the shipped page UNCHANGED and built on by
  // nothing. The Workbench has no no-project state and the design draws none;
  // MOTIR-4815 RETIRES this branch by seeding a default project at
  // registration, so `getActiveProject()` stops being able to return null. It
  // survives here only so the two cards can land in either order.
  if (!ctx) {
    return (
      <div data-testid={WORKBENCH_TESTID}>
        <ProjectsEmptyState aiConfigured={isMotirAiConfigured()} />
      </div>
    );
  }

  const params = await searchParams;
  const tab = parseWorkbenchTab(params['tab']);
  const cursorParam = params['cursor'];
  const cursor = (Array.isArray(cursorParam) ? cursorParam[0] : cursorParam) ?? null;

  const t = await getTranslations('workbench');

  const [page, counts, members, workflow] = await Promise.all([
    readTab(tab, ctx, cursor),
    homeService.tabCounts(ctx),
    workspacesService.listMembers(ctx.workspaceId, ctx.userId),
    // ONE workflow, for the one project the page reads. This surface used to
    // resolve a workflow PER PROJECT ON THE PAGE, because two projects can spell
    // the same lifecycle differently — rent it was paying on a boundary it
    // should not have crossed. Narrowing to the active project retires it.
    workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
  ]);

  const rows = toWorkbenchRowViews(page.items, workflow, members, tab === 'watching');
  const isEmpty = rows.length === 0;

  return (
    <div data-testid={WORKBENCH_TESTID} className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { project: ctx.project.name })}
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        <WorkbenchTabs active={tab} counts={counts} />

        {/* The window caption — a bounded list that does not say what bounds it
            reads as a list that is missing things, and the second sentence is
            there because the first raises the question it answers. It sits above
            the EMPTY state too: "nothing finished this week" is the same claim
            about the same window. */}
        {tab === 'finished' ? (
          <p className="text-xs text-(--el-text-secondary)">
            {t('finishedWindow', { days: HOME_FINISHED_WINDOW_DAYS })}
          </p>
        ) : null}

        {isEmpty ? (
          <EmptyTab tab={tab} />
        ) : (
          <WorkbenchList rows={rows} label={t(TAB_LABEL_KEY[tab])} tab={tab} />
        )}

        {/* Paging is a LINK, not a fetch — the cursor rides the URL beside
            `?tab=`, so a page is bookmarkable and the server re-reads. There is
            no "previous": a keyset walks forward, and the way back is the tab's
            own href, which is what `Start over` is. */}
        {page.nextCursor ? (
          <div className="flex items-center justify-between gap-3">
            {cursor ? (
              <Link
                href={workbenchTabHref(tab)}
                className="text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed)"
              >
                {t('pager.startOver')}
              </Link>
            ) : (
              <span />
            )}
            <Link
              href={workbenchTabHref(tab, page.nextCursor)}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              {t('pager.next')}
            </Link>
          </div>
        ) : cursor ? (
          <div className="flex items-center justify-between gap-3">
            <Link
              href={workbenchTabHref(tab)}
              className="text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed)"
            >
              {t('pager.startOver')}
            </Link>
            <span className="text-xs text-(--el-text-secondary)">{t('pager.end')}</span>
          </div>
        ) : null}
      </div>

      {/* The quick-view peek — the SAME `?peek=` island /items, /ready and the
          board mount. Opening a row here is not a different interaction, so it
          is not a different surface. */}
      <IssueQuickViewController />
    </div>
  );
}
