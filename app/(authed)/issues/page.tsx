import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { parsePage, parseSort, parseView, serializeSort } from '@/lib/issues/issueListView';
import { parseIssueFilter, type IssueFilterParams } from '@/lib/issues/issueListFilter';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { IssueListToolbar } from './_components/IssueListToolbar';
import { IssueTreeSection } from './_components/IssueTreeSection';
import { IssueTreeSkeleton } from './_components/IssueTreeSkeleton';
import { IssueQuickView } from './_components/IssueQuickView';
import { IssueQuickViewContent } from './_components/IssueQuickViewContent';
import { IssueQuickViewPanel } from './_components/IssueQuickViewPanel';

// The project issue index (Story 2.5 · Subtask 2.5.3; view switcher in 2.5.8) —
// the surface the sidebar "Issues" link opens. Server Component: resolves the
// active project, reads `?view` + `?sort` from the URL, renders the "Issues"
// header + the [Filter] · [Tree ▾ / List ▾] · [+ New issue] toolbar immediately,
// then streams the matching table (nested Tree or flat sortable List) inside a
// <Suspense> whose fallback is the skeleton (design/work-items/tree.png panels
// 1 + 3, list.mock.html panel 4). The read + row shaping live in
// IssueTreeSection; a project with no issues renders the drawn empty state there.
//
// 4-layer: the page calls only services (via getActiveProject + the section's
// service reads) — never Prisma directly. View/sort are parsed through the
// `issueListView` whitelist so an unknown column never reaches the read. The
// <Suspense> is keyed by view+sort so a switch/sort re-shows the skeleton while
// the new order streams. Unauthenticated → /sign-in; no active project → a hint.

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<
    { view?: string; sort?: string; page?: string; peek?: string } & IssueFilterParams
  >;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('issueViews');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <EmptyState title={t('noProjectTitle')} description={t('noProjectListDescription')} />
      </div>
    );
  }

  // Story 6.4.6 — gate the issue list on canBrowse; a non-browsable active
  // project renders the no-access state, not the list.
  const caps = await projectAccessService.getCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!caps.canBrowse) {
    const ta = await getTranslations('projectAccess');
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <NoAccessState
          title={ta('noAccessTitle')}
          description={ta('noAccessDescription')}
          backHref="/dashboard"
          backLabel={ta('backToProjects')}
        />
      </div>
    );
  }

  const sp = await searchParams;
  const view = parseView(sp.view);
  const sort = parseSort(sp.sort);
  const filter = parseIssueFilter(sp);
  const page = parsePage(sp.page);
  // The quick-view peek (Subtask 2.5.19) — `?peek=<key>` opens the work item in
  // a modal over the list without leaving it. URL-driven so it's shareable /
  // reload-safe; closing clears the param.
  const peek = sp.peek?.trim() || null;

  // The filter facets (workflow statuses + workspace members) are needed by the
  // toolbar's filter bar up front, so they're read here (cheap) and passed to
  // BOTH the toolbar and the streamed section — the section then only awaits the
  // issues read (the heavy one) behind the skeleton. The page calls services
  // only (never Prisma) per the 4-layer rule.
  const [workflow, members] = await Promise.all([
    workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
    // Assignable users scoped by access level (6.4.6): private → project members.
    assignableMembersService.list({
      projectId: ctx.projectId,
      accessLevel: ctx.project.accessLevel,
      ctx: { userId: ctx.userId, workspaceId: ctx.workspaceId },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-muted)">
            {t('allIssuesIn', { project: ctx.project.name })}
          </p>
        </div>
        <IssueListToolbar
          view={view}
          sort={sort}
          filter={filter}
          statuses={workflow.statuses}
          members={members}
        />
      </header>

      <Suspense
        key={`${view}:${serializeSort(sort)}:${JSON.stringify(filter)}:${page}`}
        fallback={<IssueTreeSkeleton flat={view === 'list'} />}
      >
        <IssueTreeSection
          projectId={ctx.projectId}
          workspaceId={ctx.workspaceId}
          userId={ctx.userId}
          view={view}
          sort={sort}
          filter={filter}
          page={page}
          workflow={workflow}
          members={members}
        />
      </Suspense>

      {/* Quick-view peek (Subtask 2.5.19) — the modal frame mounts immediately
          when `?peek` is present (so it opens instantly); the item's fields
          stream behind a <Suspense> whose fallback is the loading skeleton. The
          read reuses getIssueDetail (its workspace gate + not-found path), so a
          stale / cross-workspace key renders the not-found state, never a crash. */}
      {peek ? (
        <IssueQuickView peekKey={peek}>
          <Suspense fallback={<IssueQuickViewPanel state="loading" peekKey={peek} />}>
            <IssueQuickViewContent
              projectId={ctx.projectId}
              ctx={{ userId: ctx.userId, workspaceId: ctx.workspaceId }}
              peekKey={peek}
              members={members}
            />
          </Suspense>
        </IssueQuickView>
      ) : null}
    </div>
  );
}
