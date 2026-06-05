import { EmptyState } from '@/components/ui/EmptyState';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { toIssueRows } from './issueRows';
import { IssueTreeTable } from './IssueTreeTable';
import { NewIssueButton } from './NewIssueButton';

// The data half of the /issues route (Subtask 2.5.3) — an async Server
// Component the page renders inside a <Suspense> so the tree read streams
// behind the skeleton while the header + toolbar paint immediately.
//
// Loads, in one parallel batch (all through services — the page NEVER touches
// Prisma): the project forest (2.5.1's getProjectTree, the explicit workspace
// gate lives in the service), the workflow (to classify each status → Pill
// tone), and the workspace members (to resolve assignee names). Empty project →
// the drawn EmptyState; otherwise the shaped rows feed the client TreeTable.

export interface IssueTreeSectionProps {
  projectId: string;
  workspaceId: string;
  userId: string;
}

export async function IssueTreeSection({ projectId, workspaceId, userId }: IssueTreeSectionProps) {
  const ctx = { userId, workspaceId };
  const [tree, workflow, members] = await Promise.all([
    workItemsService.getProjectTree(projectId, {}, ctx),
    workflowsService.getWorkflow(projectId, workspaceId),
    workspacesService.listMembers(workspaceId, userId),
  ]);

  if (tree.length === 0) {
    return (
      <EmptyState
        title="No issues yet"
        description="Create your first issue to start tracking work."
        action={<NewIssueButton />}
      />
    );
  }

  return <IssueTreeTable rows={toIssueRows(tree, workflow, members)} />;
}
