import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { getActiveProject } from '@/lib/projects';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveActiveOrganizationAsShell } from '@/lib/workspaces/tierDisclosure.server';
import { orgCan } from '@/lib/organizations/capabilities';
import { NoProjectShell } from '../_components/NoProjectShell';

const NO_WORKSPACE_ADMIN_LANDING = '/settings/organization';
const NO_WORKSPACE_MEMBER_LANDING = '/settings/account';

// `/no-project` — the landing for a signed-in reader who can enter none of their
// workspace's projects (Story MOTIR-6169 · MOTIR-6548; `NO_PROJECT_PATH`). Every
// project-scoped page sends a null active project here instead of to `/sign-in`,
// which bounced a signed-in reader straight back.
//
// It is a landing, not a place to be stranded: a reader who DOES resolve a
// project (they were just added, or switched workspace) is sent on to the
// signed-in landing, so a stale tab heals on its next load.
//
// It is also where every project page sends a reader with NO active workspace —
// the active org has none (MOTIR-8777): a freshly created org, or one switched
// to that holds no workspace yet. They land on that ORG: its settings, whose
// Workspaces card is the door to its first workspace, when they may administer
// it; their account settings otherwise. Never `/sign-in`, which would bounce a
// signed-in reader straight back here.
export default async function NoProjectPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  // A separate path, not one more serial read: on it the page reads only the
  // session, the context and the org.
  if (!ctx) return landInTheActiveOrganization(session.user.id);

  if (await getActiveProject()) redirect(AUTHED_LANDING_PATH);

  const [workspace, canCreateProject] = await Promise.all([
    workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId),
    projectsService.canOfferCreateProject(ctx.userId, ctx.workspaceId),
  ]);

  return (
    <NoProjectShell workspaceName={workspace?.name ?? ''} canCreateProject={canCreateProject} />
  );
}

/** No active workspace: send the reader to the active org (see the note above). */
async function landInTheActiveOrganization(userId: string): Promise<never> {
  const { currentOrg } = await resolveActiveOrganizationAsShell(userId);
  redirect(
    currentOrg && orgCan(currentOrg.role, 'manageOrgSettings')
      ? NO_WORKSPACE_ADMIN_LANDING
      : NO_WORKSPACE_MEMBER_LANDING,
  );
}
