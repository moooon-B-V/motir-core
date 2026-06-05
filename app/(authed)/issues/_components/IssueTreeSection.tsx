import { EmptyState } from '@/components/ui/EmptyState';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { IssueListView, IssueSort } from '@/lib/issues/issueListView';
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
}

export async function IssueTreeSection({
  projectId,
  workspaceId,
  userId,
  view,
  sort,
}: IssueTreeSectionProps) {
  const ctx = { userId, workspaceId };

  const emptyState = (
    <EmptyState
      title="No issues yet"
      description="Create your first issue to start tracking work."
      action={<NewIssueButton />}
    />
  );

  if (view === 'list') {
    const [items, workflow, members] = await Promise.all([
      workItemsService.getProjectIssuesList(projectId, { sort }, ctx),
      workflowsService.getWorkflow(projectId, workspaceId),
      workspacesService.listMembers(workspaceId, userId),
    ]);
    if (items.length === 0) return emptyState;
    return <IssueListTable rows={toIssueListRows(items, workflow, members)} sort={sort} />;
  }

  const [tree, workflow, members] = await Promise.all([
    workItemsService.getProjectTree(projectId, {}, ctx),
    workflowsService.getWorkflow(projectId, workspaceId),
    workspacesService.listMembers(workspaceId, userId),
  ]);
  if (tree.length === 0) return emptyState;
  return <IssueTreeTable rows={toIssueRows(tree, workflow, members)} />;
}
