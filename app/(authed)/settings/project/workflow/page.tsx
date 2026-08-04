import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectStatusAutomationService } from '@/lib/services/projectStatusAutomationService';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkflowEditor } from './_components/WorkflowEditor';
import { StatusAutomationEditor } from './_components/StatusAutomationEditor';

// Workflow settings — server component (Subtask 2.2.5). Reads the active
// project, the caller's role (owner == project admin in v1, finding #36), and
// the project's full workflow, then hands typed serializable data to the client
// editor. Every WRITE is re-gated in the service, so a non-owner who reaches the
// page (read-only) still can't mutate; `isAdmin` here only governs whether the
// edit affordances render.

export default async function ProjectWorkflowPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[48rem]">
        <EmptyState
          title={t('project.empty.title')}
          description={t('workflow.empty.description')}
        />
      </div>
    );
  }

  const role = await workspacesService.getMemberRole(ctx.userId, ctx.workspaceId);
  const isAdmin = isOwnerRole(role);
  const workflow = await workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId);
  // Story MOTIR-1615 · MOTIR-1622 — the two status-derivation switches live on
  // THIS page (design/projects/design-notes.md §1): they govern how a status move
  // propagates along the workflow, and this is where `workflowPolicyMode`, the
  // other "how do status moves behave here" switch, already lives. Browse-gated
  // read, so a member sees the configuration; the write is re-gated in the
  // service.
  const statusAutomation = await projectStatusAutomationService.getStatusAutomation(
    ctx.project.identifier,
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );

  return (
    <div className="mx-auto flex max-w-[48rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('workflow.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t.rich('workflow.pageDescription', {
            projectName: ctx.project.name,
            editHint: isAdmin ? t('workflow.editHintAdmin') : t('workflow.editHintReader'),
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <StatusAutomationEditor
        projectKey={ctx.project.identifier}
        projectName={ctx.project.name}
        settings={statusAutomation}
        isAdmin={isAdmin}
      />

      <WorkflowEditor
        statuses={workflow.statuses}
        transitions={workflow.transitions}
        policyMode={workflow.policyMode}
        isAdmin={isAdmin}
      />
    </div>
  );
}
