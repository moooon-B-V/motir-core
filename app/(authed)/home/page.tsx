import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CircleCheck, CircleDot, Star } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { homeService } from '@/lib/services/homeService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { parseHomeTab, homeTabHref } from '@/lib/home/tab';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';
import { HomeTabs } from './_components/HomeTabs';
import { HomeList } from './_components/HomeList';
import { toHomeRowViews } from './_components/homeRows';

// `/home` — the signed-in landing surface (Story MOTIR-2649 · Subtask
// MOTIR-2653), per `design/home/`. A Server Component that resolves the session
// + WORKSPACE and reads `homeService` directly (the server-component 4-layer
// path).
//
// ⚠️ IT RESOLVES NO ACTIVE PROJECT, unlike every other list surface in the
// product. `/items`, `/ready` and `/boards` all call `getActiveProject()` first;
// Home deliberately does not, because "related to me" stops meaning much if it
// hides the projects you are not currently switched into. Switching the active
// project changes nothing here — and MOTIR-2655 asserts it.
//
// ⚠️ AND IT MOUNTS NO NOTIFICATIONS. An earlier shape of this story put a
// "Needs you" widget here — a second mount of the notification stream. It was
// removed (Yue, 2026-08-11) as a duplicate of the bell drawer, which is already
// on every page and carries the unread badge. Two copies of one dataset is two
// things to keep in agreement and a second answer to "where do I read these".
// This page touches nothing about notifications; do not add it back without
// reopening that decision.

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/sign-in');

  const params = await searchParams;
  const tab = parseHomeTab(params['tab']);
  const cursorParam = params['cursor'];
  const cursor = (Array.isArray(cursorParam) ? cursorParam[0] : cursorParam) ?? null;

  const t = await getTranslations('home');

  const [page, counts, members, workspace] = await Promise.all([
    tab === 'watching'
      ? homeService.listWatching(ctx, { cursor })
      : homeService.listMyWork(ctx, { cursor }),
    homeService.tabCounts(ctx),
    workspacesService.listMembers(ctx.workspaceId, ctx.userId),
    workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId),
  ]);

  // One workflow per DISTINCT project ON THE PAGE — not per browsable project.
  // Two projects can label the same lifecycle differently, so a row resolves
  // its status against its own project's workflow (see homeRows.ts); reading
  // only the projects actually rendered keeps that from costing a workflow read
  // per project in the workspace.
  const projectIds = [...new Set(page.items.map((row) => row.project.id))];
  const workflows = await Promise.all(
    projectIds.map(
      async (id): Promise<[string, WorkflowDto]> => [
        id,
        await workflowsService.getWorkflow(id, ctx.workspaceId),
      ],
    ),
  );
  const rows = toHomeRowViews(page.items, new Map(workflows), members, tab);

  const isEmpty = rows.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { workspace: workspace?.name ?? '' })}
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
