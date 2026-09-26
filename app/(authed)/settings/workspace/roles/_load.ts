import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceRoleDefinitionService } from '@/lib/services/workspaceRoleDefinitionService';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';

// The one read every workspace Roles page makes (Story MOTIR-6168 · MOTIR-6466):
// the session, the active workspace, its name for the crumbs, and the role
// catalog with whether the reader may author roles — decided by the SERVICE, so
// no page restates who is a Manager.
//
// ⚠️ NO REVEAL GATE, and that is the design's one carve-out (MOTIR-6456 panel
// 4b, recorded in `design/workspaces/design-notes.md`): the Roles room has no
// other home below the reveal, and `organization-tier.md` §6d forbids stranding
// a capability, so these routes answer at EVERY workspace count. Its RAIL row is
// reveal-gated like its siblings; below the reveal the org page's fold-in carries
// the door.
export async function loadRolesPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/dashboard');
  const [workspace, page] = await allSettledOrThrow([
    workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId),
    workspaceRoleDefinitionService.getRolesPageCatalog(ctx.workspaceId, ctx),
  ]);
  if (!workspace) redirect('/dashboard');
  return { ctx, workspace, ...page };
}
