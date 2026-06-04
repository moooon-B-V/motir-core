import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { EditIssueForm } from './_components/EditIssueForm';

// The issue edit route (Subtask 2.3.6). Server Component: resolves the active
// project (the shipped active-project model — finding #50, no projects/[key]
// tree), loads the work item by its identifier (the [key] segment, e.g.
// "PROD-7"), the project's workflow, and the workspace members, then hands them
// to the client EditIssueForm. Cross-workspace / missing → 404 (no existence
// leak); unauthenticated → /sign-in; no active project → a hint, not a crash.

export default async function EditIssuePage({ params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState
          title="No project selected"
          description="Pick a project from the switcher to edit its issues."
        />
      </div>
    );
  }

  const { key } = await params;
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  let issue;
  try {
    issue = await workItemsService.getWorkItemByIdentifier(ctx.projectId, key, serviceCtx);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) notFound();
    throw err;
  }

  const [workflow, members] = await Promise.all([
    workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
    workspacesService.listMembers(ctx.workspaceId, ctx.userId),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-serif text-2xl font-semibold text-(--el-text)">Edit issue</h1>
      <EditIssueForm issue={issue} workflow={workflow} members={members} />
    </div>
  );
}
