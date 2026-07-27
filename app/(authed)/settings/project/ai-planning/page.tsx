import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { EmptyState } from '@/components/ui/EmptyState';
import { AiPlanningSettingsEditor } from './_components/AiPlanningSettingsEditor';

// AI-planning project settings — server component (Story 7.13 · Subtask
// MOTIR-919), the surface `design/ai-settings/` specifies. Mounted in the 6.5
// settings AREA through its own PROJECT_SETTINGS_NAV registry entry
// (`ai-planning`, Automation group), which lights both doors — the rail row and
// the ⌘K deep link.
//
// Browse-gated, NOT admin-gated (unlike Automation): every member SEES the
// project's cadence configuration and a non-admin reads it read-only, matching
// the shipped Estimation panel. The write is re-gated in
// `projectAiSettingsService.updateAiSettings` (assertCanManage), so `isAdmin`
// here only governs whether the edit affordances render.
//
// It reads services only (4-layer, never Prisma) and hands the client editor
// typed serializable data: the MOTIR-915 settings DTO, the admin flag, and the
// shipped `isMotirAiConfigured()` probe — the server-only env check that drives
// the "Motir AI isn't connected" state (there is deliberately NO in-app
// provisioning CTA; that route does not exist).

export default async function ProjectAiPlanningPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState
          title={t('project.empty.title')}
          description={t('aiPlanning.empty.description')}
        />
      </div>
    );
  }

  const [{ canManage }, settings] = await Promise.all([
    projectAccessService.getManageCapabilities(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    projectAiSettingsService.getAiSettings(ctx.project.identifier, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
  ]);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('aiPlanning.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('aiPlanning.pageDescription')}
        </p>
      </header>

      <AiPlanningSettingsEditor
        projectKey={ctx.project.identifier}
        projectName={ctx.project.name}
        settings={settings}
        isAdmin={canManage}
        aiConfigured={isMotirAiConfigured()}
      />
    </div>
  );
}
