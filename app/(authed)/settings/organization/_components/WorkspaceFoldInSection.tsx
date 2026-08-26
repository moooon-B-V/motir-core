import { getTranslations } from 'next-intl/server';
import { workspacesService } from '@/lib/services/workspacesService';
import { NameCard } from '../../workspace/_components/NameCard';
import { MembersCard } from '../../workspace/_components/MembersCard';
import { DangerZoneCard } from '../../workspace/_components/DangerZoneCard';

// §6d's SETTINGS COLLAPSE (MOTIR-3502 · design/org-admin panel 2). Below the
// workspace-tier reveal threshold there is no `/settings/workspace` area — it
// 404s — so this org Settings home HOSTS that area's sections instead.
//
// It is a MOUNT, not a rewrite. These are the same three components
// `/settings/workspace` renders, with the same Server Actions writing to the
// same `Workspace` row underneath — which is exactly what §6 means by "routes
// each edit to its own tier": the tier keeps working, it just stops being a
// place the user has to know about. Redrawing them here would fork the workspace
// settings UI in two, and the design asset says so outright: they "are NOT
// redrawn in this org-admin asset (they're owned by their own design areas); the
// org settings page simply hosts them", "rendered below the org-scoped cards as
// the same `stack` grammar".
//
// This REPLACED `WorkspaceConfigCard`, whose entire content was an explanatory
// note plus an "Open workspace settings" button. That card rendered only at one
// workspace, so the affordance built FOR the collapsed state was the loudest
// thing advertising the surface the collapsed state exists to hide.
export async function WorkspaceFoldInSection({
  workspaceId,
  actorUserId,
  workspaceCount,
}: {
  workspaceId: string;
  actorUserId: string;
  workspaceCount: number;
}) {
  const t = await getTranslations('orgAdmin');

  const [workspace, members] = await Promise.all([
    workspacesService.getWorkspaceSummary(workspaceId, actorUserId),
    workspacesService.listMembers(workspaceId, actorUserId),
  ]);
  // The caller resolved this workspace from the actor's OWN membership list, so
  // a null here means it went away between the two reads. Nothing to host.
  if (!workspace) return null;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="font-sans text-base font-semibold text-(--el-text)">
          {t('settings.workspaceConfig')}
        </h2>
        <p className="text-(--el-text-secondary) font-sans text-sm">
          {t('settings.workspaceConfigSub', { count: workspaceCount })}
        </p>
      </div>

      <NameCard initialName={workspace.name} />

      <MembersCard
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        members={members}
        currentUserId={actorUserId}
      />

      <DangerZoneCard workspaceName={workspace.name} isLastMember={members.length <= 1} />
    </>
  );
}
