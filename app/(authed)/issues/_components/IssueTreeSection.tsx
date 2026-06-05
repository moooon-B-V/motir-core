import { EmptyState } from '@/components/ui/EmptyState';
import { workItemsService } from '@/lib/services/workItemsService';
import type { IssueListView, IssueSort } from '@/lib/issues/issueListView';
import {
  toProjectTreeFilter,
  isFilterActive,
  type IssueFilter,
} from '@/lib/issues/issueListFilter';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { toIssueRows, toIssueListRows } from './issueRows';
import { IssueTreeTable } from './IssueTreeTable';
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
  workflow,
  members,
}: IssueTreeSectionProps) {
  const ctx = { userId, workspaceId };
  const repoFilter = toProjectTreeFilter(filter);
  const filtered = isFilterActive(filter);

  // A filter that matches nothing is distinct from an empty project: don't tell
  // the user to "create your first issue" when they've simply over-narrowed.
  const empty = filtered ? (
    <EmptyState
      title="No matching issues"
      description="No issues match the current filters. Try adjusting or clearing them."
    />
  ) : (
    <EmptyState
      title="No issues yet"
      description="Create your first issue to start tracking work."
      action={<NewIssueButton />}
    />
  );

  if (view === 'list') {
    const items = await workItemsService.getProjectIssuesList(
      projectId,
      { sort, filter: repoFilter },
      ctx,
    );
    if (items.length === 0) return empty;
    return (
      <IssueListTable
        rows={toIssueListRows(items, workflow, members)}
        sort={sort}
        filter={filter}
      />
    );
  }

  const tree = await workItemsService.getProjectTree(projectId, repoFilter, ctx);
  if (tree.length === 0) return empty;
  return <IssueTreeTable rows={toIssueRows(tree, workflow, members)} />;
}
