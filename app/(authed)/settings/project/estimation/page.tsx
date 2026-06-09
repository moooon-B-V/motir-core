import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { workspacesService } from '@/lib/services/workspacesService';
import { estimationService } from '@/lib/services/estimationService';
import { EmptyState } from '@/components/ui/EmptyState';
import { EstimationSettingsEditor } from './_components/EstimationSettingsEditor';

// Estimation settings — server component (Subtask 4.3.6). Reads the active
// project, the caller's role (owner == project admin in v1, finding #36), and
// the project's estimation config, then hands typed serializable data to the
// client editor. The PATCH is re-gated in estimationService (owner-only), so
// `isAdmin` here only governs whether the edit affordances render — a non-admin
// who reaches the page sees it read-only. Sibling of the Workflow + Board
// settings pages (the project-scoped Estimation deviation — see story-4.3.ts).

export default async function ProjectEstimationPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState
          title={t('project.empty.title')}
          description={t('estimation.empty.description')}
        />
      </div>
    );
  }

  const role = await workspacesService.getMemberRole(ctx.userId, ctx.workspaceId);
  const isAdmin = isOwnerRole(role);
  const config = await estimationService.getEstimationConfig(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('estimation.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('estimation.pageDescription')}
        </p>
      </header>

      <EstimationSettingsEditor
        projectKey={ctx.project.identifier}
        config={config}
        isAdmin={isAdmin}
      />
    </div>
  );
}
