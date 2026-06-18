import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { parsePage, parseSort, parseView, serializeSort } from '@/lib/issues/issueListView';
import { parseIssueFilter, type IssueFilterParams } from '@/lib/issues/issueListFilter';
import { parseAdvancedFilterParam } from '@/lib/issues/issueListAdvancedFilter';
import { collectFilterReferentIds } from '@/lib/filters/registry';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { componentsService } from '@/lib/services/componentsService';
import { labelsService } from '@/lib/services/labelsService';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { AdvancedFilterProvider } from './_components/AdvancedFilterContext';
import { AdvancedFilterSummary } from './_components/AdvancedFilterSummary';
import { SavedFilterSessionProvider } from './_components/SavedFilterContext';
import { IssueAppliedFilterBar } from './_components/IssueAppliedFilterBar';
import { InvalidFilterCallout } from './_components/InvalidFilterCallout';
import { IssueListToolbar } from './_components/IssueListToolbar';
import { IssueTreeSection } from './_components/IssueTreeSection';
import { IssueTreeSkeleton } from './_components/IssueTreeSkeleton';
import { IssueQuickViewController } from './_components/IssueQuickViewController';

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
  // project renders the no-access state, not the list. The same resolve also
  // yields the saved-filter share/admin tiers the 6.2.3 [Saved] dropdown +
  // save dialog gate over (one round-trip — the getSavedFilterCapabilities
  // shape is canBrowse + canShare + isAdmin).
  const caps = await projectAccessService.getSavedFilterCapabilities(ctx.projectId, {
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
  let filter = parseIssueFilter(sp);
  // The advanced builder's `?filter=v1:` param (Subtask 6.1.4): decoded +
  // validated ONCE here. A malformed/forged/foreign param is the typed
  // recoverable state — the callout renders over the UNFILTERED list and the
  // broken param is nulled before threading, so no navigation re-carries it.
  const advanced = parseAdvancedFilterParam(filter.advanced);
  if (advanced.state !== 'active') filter = { ...filter, advanced: null };
  const ast = advanced.state === 'active' ? advanced.ast : null;
  const page = parsePage(sp.page);

  // The filter facets (workflow statuses + workspace members) are needed by the
  // toolbar's filter bar up front, so they're read here (cheap) and passed to
  // BOTH the toolbar and the streamed section — the section then only awaits the
  // issues read (the heavy one) behind the skeleton. The page calls services
  // only (never Prisma) per the 4-layer rule.
  // The advanced builder's Epic-5 value editors (Subtask 6.1.5) need the
  // project's custom-field definitions + components (both BOUNDED reads — the
  // field cap is 50, components are few) and, for a shared/saved URL, the
  // referenced labels resolved to names (the ONLY ids the URL carries — never
  // load-all; finding #57). The label resolve is skipped when the AST carries
  // no label condition. The page calls services only (never Prisma).
  const referencedLabelIds = ast ? collectFilterReferentIds(ast).labelIds : [];
  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [workflow, members, sprints, customFields, components, referencedLabels, archivedCount] =
    await Promise.all([
      workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
      // Assignable users scoped by access level (6.4.6): private → project members.
      assignableMembersService.list({
        projectId: ctx.projectId,
        accessLevel: ctx.project.accessLevel,
        ctx: wsCtx,
      }),
      // The builder's sprint value editor (6.1.4) — a project's sprint list is
      // small by nature (the bounded read its owner ships).
      sprintsService.listByProject(ctx.projectId, wsCtx),
      customFieldsService.listFields({
        key: ctx.project.identifier,
        actorUserId: ctx.userId,
        ctx: wsCtx,
      }),
      componentsService.listComponents(ctx.project.identifier, wsCtx),
      labelsService.resolveByIds(ctx.project.identifier, referencedLabelIds, wsCtx),
      // The [Archived] entry-point's count badge (Story 2.9 · Subtask 2.9.3) —
      // a cheap COUNT(*) of the project's archived items.
      workItemsService.countArchivedWorkItems(ctx.projectId, wsCtx),
    ]);

  // The actor's saved-filter tier (Subtask 6.2.3) — passed to the toolbar's
  // [Saved] dropdown + the applied-filter bar's save dialog.
  const viewer = { userId: ctx.userId, ...caps };

  return (
    <AdvancedFilterProvider>
      <SavedFilterSessionProvider>
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
              ast={ast}
              statuses={workflow.statuses}
              members={members}
              sprints={sprints}
              customFields={customFields}
              components={components}
              referencedLabels={referencedLabels}
              projectKey={ctx.project.identifier}
              viewer={viewer}
              archivedCount={archivedCount}
            />
          </header>

          {/* The invalid `?filter=` recovery callout (6.1.4, mock panel 6) —
            above the UNFILTERED list, never a crash, never a silent drop. */}
          {advanced.state === 'invalid' ? (
            <InvalidFilterCallout view={view} sort={sort} filter={filter} />
          ) : null}

          {/* The applied-filter bar (6.2.3, mock panel 0) — the saved-filter name
            chip + dirty state + Save / Save-as / Discard, prepended to the
            6.1.4 condition-chip readout (panel 5, read-only; any chip reopens
            the builder). The bar renders nothing when no filter is applied and
            the builder is empty. */}
          <IssueAppliedFilterBar
            projectKey={ctx.project.identifier}
            viewer={viewer}
            view={view}
            sort={sort}
            filter={filter}
            ast={ast}
          >
            {ast !== null ? (
              <AdvancedFilterSummary
                ast={ast}
                statuses={workflow.statuses}
                members={members}
                sprints={sprints}
                customFields={customFields}
                components={components}
                referencedLabels={referencedLabels}
              />
            ) : null}
          </IssueAppliedFilterBar>

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
              ast={ast}
              page={page}
              workflow={workflow}
              members={members}
            />
          </Suspense>

          {/* Quick-view peek (Subtask 2.5.19; bug 8.8.2) — a client island that
          watches `?peek` and renders the modal frame + skeleton instantly, then
          client-fetches the item from /api/issues/peek. Decoupled from this
          page's server render, so opening/closing is a pure shallow URL change
          with no underlying-list refetch. */}
          <IssueQuickViewController />
        </div>
      </SavedFilterSessionProvider>
    </AdvancedFilterProvider>
  );
}
