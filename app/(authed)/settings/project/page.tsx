import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { ProjectDetailsCard } from './_components/ProjectDetailsCard';
import { BuildInPublicPromoCard } from './_components/BuildInPublicPromoCard';
import { guardSettingsPage } from './_guard';

// Project-settings AREA landing — the registry's `details` entry. Story 6.5 ·
// 6.5.3 shipped this read-only; Story 6.8 · 6.8.4 grows it into the EDITABLE
// surface (name + logo + the guarded change-key flow + previous keys), per
// `design/projects/details.mock.html`. The verified mirror rule: settings opens
// ON Details, and Details owns the editable project identity + the danger zone.
//
// Identity, the logo, and the retired-key history are read via the details-surface
// path (`projectsService.getDetails`) — the DTO that loads `createdAt` and
// `previousKeys` (the hot active-project read deliberately
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

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `details`, never re-declared here.
  const refused = await guardSettingsPage('details', ctx);
  if (refused) return refused;

  const actorCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  // MOTIR-3558 — allocation row 1: THE FRAME ONLY. The two reads below were
  // already one wave, so nothing here becomes concurrent that was not; what
  // changes is that the header no longer waits for them. The gate is done at
  // this line, so the boundary is safe here and would not have been one line up.
  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      {/* REAL, painted from the gate: both strings are `t(...)` with no
          interpolation from a pending read. This is why the frame draws no
          header — a grey bar here would cover text that already exists. */}
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('details.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('details.subtitle')}</p>
      </header>

      <Suspense fallback={<SettingsPaneFrame />}>
        <DetailsPaneBody
          projectId={ctx.projectId}
          projectKey={ctx.project.identifier}
          accessLevel={ctx.project.accessLevel}
          actorCtx={actorCtx}
        />
      </Suspense>
    </div>
  );
}

/** The pane's reads, below the boundary. Already one wave; kept one wave. */
async function DetailsPaneBody({
  projectId,
  projectKey,
  accessLevel,
  actorCtx,
}: {
  projectId: string;
  projectKey: string;
  accessLevel: string;
  actorCtx: { userId: string; workspaceId: string };
}) {
  const [details, caps] = await Promise.all([
    projectsService.getDetails(projectKey, actorCtx),
    projectAccessService.getManageCapabilities(projectId, actorCtx),
  ]);

  const format = await getFormatter();
  const dateOpts = { day: 'numeric', month: 'long', year: 'numeric' } as const;
  const previousKeys = (details.previousKeys ?? []).map((pk) => ({
    identifier: pk.identifier,
    retiredLabel: format.dateTime(new Date(pk.retiredAt), dateOpts),
  }));

  return (
    <>
      <ProjectDetailsCard
        projectId={projectId}
        projectName={details.name}
        projectIdentifier={details.identifier}
        image={details.image}
        previousKeys={previousKeys}
        canManage={caps.canManage}
      />

      {/* The durable build-in-public entry point (Story 6.17 · Subtask 6.17.3 ·
          design Panel 10c) — shown to a project admin while the project is not
          yet public; the confirm goes through the reusable 6.17.2 dialog. */}
      {caps.canManage && accessLevel !== 'public' ? (
        <BuildInPublicPromoCard projectKey={projectKey} />
      ) : null}
    </>
  );
}
