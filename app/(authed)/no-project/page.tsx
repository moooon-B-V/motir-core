import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { getActiveProject } from '@/lib/projects';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { NoProjectShell } from '../_components/NoProjectShell';

// `/no-project` — the landing for a signed-in reader who can enter none of their
// workspace's projects (Story MOTIR-6169 · MOTIR-6548; `NO_PROJECT_PATH`). Every
// project-scoped page sends a null active project here instead of to `/sign-in`,
// which bounced a signed-in reader straight back.
//
// It is a landing, not a place to be stranded: a reader who DOES resolve a
// project (they were just added, or switched workspace) is sent on to the
// signed-in landing, so a stale tab heals on its next load.
export default async function NoProjectPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/sign-in');

  if (await getActiveProject()) redirect(AUTHED_LANDING_PATH);

  const [workspace, canCreateProject] = await Promise.all([
    workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId),
    projectsService.canOfferCreateProject(ctx.userId, ctx.workspaceId),
  ]);

  return (
    <NoProjectShell workspaceName={workspace?.name ?? ''} canCreateProject={canCreateProject} />
  );
}
