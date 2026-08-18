import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CircleCheck, CircleDot, Star } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { homeService } from '@/lib/services/homeService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { parseHomeTab, homeTabHref } from '@/lib/home/tab';
import { ProjectsEmptyState } from '../_components/ProjectsEmptyState';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';
import { HomeTabs } from './_components/HomeTabs';
import { HomeList } from './_components/HomeList';
import { toHomeRowViews } from './_components/homeRows';

// `/home` — the signed-in landing surface (Story MOTIR-2649 · Subtask
// MOTIR-2653), per `design/home/`. A Server Component that resolves the session
// + the ACTIVE PROJECT and reads `homeService` directly (the server-component
// 4-layer path).
//
// ⚠️ IT RESOLVES THE ACTIVE PROJECT, exactly like `/items`, `/ready` and
// `/boards` (MOTIR-2761). It did not until 2026-08-17, and the shell said
// otherwise the whole time: the rail's primary section is built inside
// `if (hasProject)` with Home as its FIRST row, under a project switcher the
// top bar renders on every authed page. A switcher that changes nothing on the
// first screen after sign-in is a control that lies. The cross-project question
// is retained at the workspace tier as MOTIR-2920, not dropped
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
// shell-session.ts` waits on a RENDERED Home rather than on a URL that merely
// reads right (MOTIR-2645's contract: an authoritative signal, never an
// interval), so BOTH branches below carry it: a fresh sign-up has no project
// and lands on the create-first branch, an existing account lands on the list.
// There is no longer a second landing to keep in step — MOTIR-2921 moved
// sign-up here behind MOTIR-2654's sign-in, and `/dashboard`'s own marker is no
// longer a post-auth one (`docs/decisions/home-scope.md` §2.3).
const HOME_TESTID = 'home-page';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  // NO ACTIVE PROJECT — and `getActiveProject` returns null only when the actor
  // can see ZERO projects in this workspace (the resolver recovers to the first
  // visible one and persists the pointer), so this is "there is nothing to
  // pick", never "you have not picked yet". A route a reader is LANDED on gets
  // the create-first door; `/ready`, `/items` and `/boards` are navigated to and
  // keep their actionless notice (`docs/decisions/home-scope.md` §1–2.2). The
  // component is the shipped one `/dashboard` already renders here — reused,
  // not reimplemented, so it brings its own copy in both catalogues.
  if (!ctx) {
    return (
      <div data-testid={HOME_TESTID}>
        <ProjectsEmptyState aiConfigured={isMotirAiConfigured()} />
      </div>
    );
  }

  const params = await searchParams;
  const tab = parseHomeTab(params['tab']);
  const cursorParam = params['cursor'];
  const cursor = (Array.isArray(cursorParam) ? cursorParam[0] : cursorParam) ?? null;

  const t = await getTranslations('home');

  const [page, counts, members, workflow] = await Promise.all([
    tab === 'watching'
      ? homeService.listWatching(ctx, { cursor })
      : homeService.listMyWork(ctx, { cursor }),
    homeService.tabCounts(ctx),
    workspacesService.listMembers(ctx.workspaceId, ctx.userId),
    // ONE workflow, for the one project the page reads. Home used to resolve a
    // workflow PER PROJECT ON THE PAGE, because two projects can spell the same
    // lifecycle differently — rent this surface was paying on a boundary it
    // should not have crossed. Narrowing to the active project retires it.
    workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
  ]);

  const rows = toHomeRowViews(page.items, workflow, members, tab);

  const isEmpty = rows.length === 0;

  return (
    <div data-testid={HOME_TESTID} className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { project: ctx.project.name })}
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        <HomeTabs active={tab} counts={counts} />

        {isEmpty ? (
          tab === 'watching' ? (
            <EmptyState
              icon={<Star className="h-12 w-12" aria-hidden />}
              title={t('empty.watching.title')}
              description={t('empty.watching.body')}
            />
          ) : (
            <EmptyState
              icon={<CircleCheck className="h-12 w-12" aria-hidden />}
              title={t('empty.myWork.title')}
              description={t('empty.myWork.body')}
              action={
                <Link href="/ready" className={buttonVariants({ variant: 'secondary' })}>
                  <CircleDot className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
                  {t('empty.myWork.action')}
                </Link>
              }
            />
          )
        ) : (
          <HomeList rows={rows} label={t(tab === 'watching' ? 'tabs.watching' : 'tabs.myWork')} />
        )}

        {/* Paging is a LINK, not a fetch — the cursor rides the URL beside
            `?tab=`, so a page is bookmarkable and the server re-reads. There is
            no "previous": a keyset walks forward, and the way back is the tab's
            own href, which is what `Start over` is. */}
        {page.nextCursor ? (
          <div className="flex items-center justify-between gap-3">
            {cursor ? (
              <Link
                href={homeTabHref(tab)}
                className="text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed)"
              >
                {t('pager.startOver')}
              </Link>
            ) : (
              <span />
            )}
            <Link
              href={homeTabHref(tab, page.nextCursor)}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              {t('pager.next')}
            </Link>
          </div>
        ) : cursor ? (
          <div className="flex items-center justify-between gap-3">
            <Link
              href={homeTabHref(tab)}
              className="text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed)"
            >
              {t('pager.startOver')}
            </Link>
            <span className="text-xs text-(--el-text-secondary)">{t('pager.end')}</span>
          </div>
        ) : null}
      </div>

      {/* The quick-view peek — the SAME `?peek=` island /items, /ready and the
          board mount. Opening a row from Home is not a different interaction,
          so it is not a different surface. */}
      <IssueQuickViewController />
    </div>
  );
}
