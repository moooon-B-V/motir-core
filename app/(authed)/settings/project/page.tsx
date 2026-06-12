import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workspacesService } from '@/lib/services/workspacesService';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProjectDetailsCard } from './_components/ProjectDetailsCard';

// Project-settings AREA landing — the registry's `details` entry (Story 6.5 ·
// Subtask 6.5.3). The verified mirror rule: settings opens ON Details, and
// Details owns project identity + the danger zone. This route (the retired card
// hub) is now the read-only Details page: identity rows (avatar, name, key,
// workspace, created) with the "editing arrives with project-details editing"
// seam (the 6.8 seam — 6.8 swaps these rows for edit forms + the key-change
// flow), and the re-homed Archive danger zone (admin-only). The area layout
// (`../layout.tsx`) already guards no-project / no-browse for every settings
// page; the defensive empty state here keeps the route self-sufficient.
//
// `createdAt` is read via the details-surface path (`projectsService.getDetails`)
// — the same read Story 6.8 grows this page on — NOT the hot active-project DTO
// (which deliberately omits it). `canManage` gates the danger zone in the UI;
// the archive Server Action is independently admin-gated server-side.

export default async function ProjectSettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    // Defensive — the area layout already renders the no-project empty state, but
    // keep the route self-sufficient so it never 404s on its own.
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('area.noProjectTitle')} description={t('area.noProjectDescription')} />
      </div>
    );
  }

  const actorCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [details, workspace, caps] = await Promise.all([
    projectsService.getDetails(ctx.project.identifier, actorCtx),
    workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId),
    projectAccessService.getManageCapabilities(ctx.projectId, actorCtx),
  ]);

  const format = await getFormatter();
  const createdLabel = details.createdAt
    ? format.dateTime(new Date(details.createdAt), {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('details.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('details.subtitle')}</p>
      </header>

      <ProjectDetailsCard
        projectId={ctx.projectId}
        projectName={details.name}
        projectIdentifier={details.identifier}
        workspaceName={workspace?.name ?? ''}
        createdLabel={createdLabel}
        canManage={caps.canManage}
      />
    </div>
  );
}
