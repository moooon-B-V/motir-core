import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectStatusAutomationService } from '@/lib/services/projectStatusAutomationService';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { WorkflowEditor } from './_components/WorkflowEditor';
import { StatusAutomationEditor } from './_components/StatusAutomationEditor';
import { guardSettingsPage } from '../_guard';

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

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `workflow`, never re-declared here.
  const refused = await guardSettingsPage('workflow', ctx);
  if (refused) return refused;

  // MOTIR-2473 retired the private admin derivation that used to sit here — a
  // WORKSPACE-OWNER check (`isOwnerRole`) standing in for "may configure this",
  // which was both a second policy and a tighter one than the key the service
  // actually asserts. The page is reached only by an actor who holds its registry
  // key (the guard above), so the edit affordances are simply on.
  const isAdmin = true;

  // MOTIR-3558 — allocation row 3: SERIAL → CONCURRENT, plus the frame. The two
  // reads below are independent (one takes the project id, the other the key)
  // and were written one after the other for no reason. The gate is done at this
  // line, so the boundary is safe here and would not have been one line up.
  return (
    <div className="mx-auto flex max-w-[48rem] flex-col gap-6">
      {/* REAL, painted from the gate: the title is a plain `t(...)` and the
          subtitle interpolates only `ctx.project.name`, which the gate already
          resolved. Neither waits on the reads below. */}
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

      <Suspense fallback={<SettingsPaneFrame />}>
        <WorkflowPaneBody
          projectId={ctx.projectId}
          projectKey={ctx.project.identifier}
          projectName={ctx.project.name}
          workspaceId={ctx.workspaceId}
          userId={ctx.userId}
          isAdmin={isAdmin}
        />
      </Suspense>
    </div>
  );
}

/**
 * The pane's two reads, below the boundary and now in ONE wave.
 *
 * Story MOTIR-1615 · MOTIR-1622 — the two status-derivation switches live on
 * THIS page (design/projects/design-notes.md §1): they govern how a status move
 * propagates along the workflow, and this is where `workflowPolicyMode`, the
 * other "how do status moves behave here" switch, already lives. Browse-gated
 * read, so a member sees the configuration; the write is re-gated in the
 * service.
 *
 * `allSettledOrThrow` rather than a bare `Promise.all`: both arms open a
 * transaction, so a rejection on one must not leave the other running
 * unobserved (MOTIR-3066).
 */
async function WorkflowPaneBody({
  projectId,
  projectKey,
  projectName,
  workspaceId,
  userId,
  isAdmin,
}: {
  projectId: string;
  projectKey: string;
  projectName: string;
  workspaceId: string;
  userId: string;
  isAdmin: boolean;
}) {
  const [workflow, statusAutomation] = await allSettledOrThrow([
    workflowsService.getWorkflow(projectId, workspaceId),
    projectStatusAutomationService.getStatusAutomation(projectKey, { userId, workspaceId }),
  ]);

  return (
    <>
      <StatusAutomationEditor
        projectKey={projectKey}
        projectName={projectName}
        settings={statusAutomation}
        isAdmin={isAdmin}
      />

      <WorkflowEditor
        statuses={workflow.statuses}
        transitions={workflow.transitions}
        policyMode={workflow.policyMode}
        isAdmin={isAdmin}
      />
    </>
  );
}
