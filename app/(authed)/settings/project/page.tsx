import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProjectDetailsCard } from './_components/ProjectDetailsCard';
import { BuildInPublicPromoCard } from './_components/BuildInPublicPromoCard';

// Project-settings AREA landing — the registry's `details` entry. Story 6.5 ·
// 6.5.3 shipped this read-only; Story 6.8 · 6.8.4 grows it into the EDITABLE
// surface (name + avatar + the guarded change-key flow + previous keys), per
// `design/projects/details.mock.html`. The verified mirror rule: settings opens
// ON Details, and Details owns the editable project identity + the danger zone.
//
// Identity, avatar, and the retired-key history are read via the details-surface
// path (`projectsService.getDetails`) — the DTO that loads `avatarIcon`,
// `avatarColor`, and `previousKeys` (the hot active-project read deliberately
// omits the alias join). `canManage` gates the editable affordances in the UI;
// the update / change-key / release Server Actions are independently
// admin-gated server-side.

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
  const [details, caps] = await Promise.all([
    projectsService.getDetails(ctx.project.identifier, actorCtx),
    projectAccessService.getManageCapabilities(ctx.projectId, actorCtx),
  ]);

  const format = await getFormatter();
  const dateOpts = { day: 'numeric', month: 'long', year: 'numeric' } as const;
  const previousKeys = (details.previousKeys ?? []).map((pk) => ({
    identifier: pk.identifier,
    retiredLabel: format.dateTime(new Date(pk.retiredAt), dateOpts),
  }));

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
        avatarIcon={details.avatarIcon}
        avatarColor={details.avatarColor}
        previousKeys={previousKeys}
        canManage={caps.canManage}
      />

      {/* The durable build-in-public entry point (Story 6.17 · Subtask 6.17.3 ·
          design Panel 10c) — shown to a project admin while the project is not
          yet public; the confirm goes through the reusable 6.17.2 dialog. */}
      {caps.canManage && ctx.project.accessLevel !== 'public' ? (
        <BuildInPublicPromoCard projectKey={ctx.project.identifier} />
      ) : null}
    </div>
  );
}
