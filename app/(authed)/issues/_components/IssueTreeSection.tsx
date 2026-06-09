import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Locale } from '@/lib/i18n/locales';
import { workItemsService } from '@/lib/services/workItemsService';
import { estimationService } from '@/lib/services/estimationService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { type IssueListView, type IssueSort, serializeSort } from '@/lib/issues/issueListView';
import {
  toProjectTreeFilter,
  isFilterActive,
  type IssueFilter,
} from '@/lib/issues/issueListFilter';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { toIssueRows, toIssueListRows } from './issueRows';
import { IssueTreeTable } from './IssueTreeTable';
import { IssueTreeStaticTable } from './IssueTreeStaticTable';
import { IssueListTable } from './IssueListTable';
import { NewIssueButton } from './NewIssueButton';

// The data half of the /issues route (Subtask 2.5.3; the List view added in
// 2.5.8) — an async Server Component the page renders inside a <Suspense> so the
// read streams behind the skeleton while the header + toolbar paint immediately.
//
// Loads, in one parallel batch (all through services — the page NEVER touches
// Prisma): the issues for the active `view` (the nested forest via getProjectTree
// for `tree`, or the flat sorted list via getProjectIssuesList for `list` — both
// carry the explicit workspace gate in the service), the workflow (to classify
// each status → Pill tone), and the workspace members (to resolve assignee /
// reporter names). Empty project → the drawn EmptyState; otherwise the shaped
// rows feed the matching client table.

export interface IssueTreeSectionProps {
  projectId: string;
  workspaceId: string;
  userId: string;
  view: IssueListView;
  sort: IssueSort;
  /** The active filter (Subtask 2.5.4); applied to BOTH views. */
  filter: IssueFilter;
  /** The requested List page (Subtask 2.5.12); the service clamps out-of-range. Tree ignores it. */
  page: number;
  /** Pre-read by the page (the toolbar's filter facets need them up front). */
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
}

export async function IssueTreeSection({
  projectId,
  workspaceId,
  userId,
  view,
  sort,
  filter,
  page,
  workflow,
  members,
}: IssueTreeSectionProps) {
  const ctx = { userId, workspaceId };
  const repoFilter = toProjectTreeFilter(filter);
  const filtered = isFilterActive(filter);
  const t = await getTranslations('issueViews');
  const locale = (await getLocale()) as Locale;

  // The estimation config (Subtask 4.3.4) + edit capability for the inline
  // EstimateBadge in the Points column — read once, shared across every row.
  const [estimationConfig, caps] = await Promise.all([
    estimationService.getEstimationConfig(projectId, ctx),
    projectAccessService.getCapabilities(projectId, ctx),
  ]);
  const withEstimation = (node: ReactNode) => (
    <EstimationConfigProvider config={estimationConfig} canEdit={caps.canEdit}>
      {node}
    </EstimationConfigProvider>
  );

  // A filter that matches nothing is distinct from an empty project: don't tell
  // the user to "create your first issue" when they've simply over-narrowed.
  const empty = filtered ? (
    <EmptyState title={t('noMatchingTitle')} description={t('noMatchingDescription')} />
  ) : (
    <EmptyState
      title={t('noIssuesTitle')}
      description={t('noIssuesDescription')}
      action={<NewIssueButton />}
    />
  );

  if (view === 'list') {
    const {
      items,
      total,
      page: clampedPage,
      pageSize,
    } = await workItemsService.getProjectIssuesList(
      projectId,
      { sort, filter: repoFilter, page },
      ctx,
    );
    if (items.length === 0) return empty;
    return withEstimation(
      <IssueListTable
        rows={toIssueListRows(items, workflow, members, locale)}
        sort={sort}
        filter={filter}
        pagination={{ total, page: clampedPage, pageSize }}
        workflow={workflow}
        members={members}
      />,
    );
  }

  // FILTERED tree → the context-preserving whole-forest read (already bounded by
  // the filter; matched nodes keep their ancestors). Rendered with the static
  // tree — lazy-loading a context-preserving filter is an Epic-6 problem.
  if (filtered) {
    const tree = await workItemsService.getProjectTree(projectId, repoFilter, ctx);
    if (tree.length === 0) return empty;
    return withEstimation(
      <IssueTreeStaticTable
        rows={toIssueRows(tree, workflow, members, locale)}
        workflow={workflow}
        members={members}
      />,
    );
  }

  // UNFILTERED tree → the LAZY path (finding #57): load only the first page of
  // ROOTS; children stream in on expand. Keyed by sort so a header-sort remounts
  // the tree against freshly-sorted roots.
  const initialLevel = await workItemsService.listRootIssues(projectId, { sort }, ctx);
  if (initialLevel.total === 0) return empty;
  return withEstimation(
    <IssueTreeTable
      key={serializeSort(sort)}
      initialLevel={initialLevel}
      sort={sort}
      filter={filter}
      workflow={workflow}
      members={members}
    />,
  );
}
