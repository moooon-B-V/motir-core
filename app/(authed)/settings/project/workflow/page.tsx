import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkflowEditor } from './_components/WorkflowEditor';

// Workflow settings — server component (Subtask 2.2.5). Reads the active
// project, the caller's role (owner == project admin in v1, finding #36), and
// the project's full workflow, then hands typed serializable data to the client
// editor. Every WRITE is re-gated in the service, so a non-owner who reaches the
// page (read-only) still can't mutate; `isAdmin` here only governs whether the
// edit affordances render.

export default async function ProjectWorkflowPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[48rem]">
        <EmptyState
          title="No project yet"
          description="Create a project from the switcher in the top-left to manage its workflow."
        />
      </div>
    );
  }

  const role = await workspacesService.getMemberRole(ctx.userId, ctx.workspaceId);
  const isAdmin = isOwnerRole(role);
  const workflow = await workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId);

  return (
    <div className="mx-auto flex max-w-[48rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-foreground">Workflow</h1>
        <p className="text-muted-foreground font-sans text-sm">
          The statuses an issue can hold in <strong>{ctx.project.name}</strong>, and the legal moves
          between them. {isAdmin ? 'Edit them here.' : 'Only a project admin can edit these.'}
        </p>
      </header>

      <WorkflowEditor
        statuses={workflow.statuses}
        transitions={workflow.transitions}
        policyMode={workflow.policyMode}
        isAdmin={isAdmin}
      />
    </div>
  );
}
