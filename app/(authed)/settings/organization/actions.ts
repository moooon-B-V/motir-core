'use server';

import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import { workspacesService } from '@/lib/services/workspacesService';

/**
 * After the org Workspaces card removes a workspace (MOTIR-6312 ·
 * `design/org-admin/org-admin--workspaces-at-org-tier.mock.html` panel 1g):
 * if the ACTIVE-workspace cookie still names a workspace the actor can no longer
 * reach, re-point it at the first one they can — or clear it when none is left —
 * the way a workspace switch does, so no island keeps the dead workspace's state.
 *
 * It takes no argument: the only workspace it may re-point is the SESSION's
 * own active one, and the target comes from the actor's own workspace list. The
 * removal itself is `DELETE /api/organizations/[orgId]/workspaces/[workspaceId]`
 * (MOTIR-6309), which owns every gate; this action touches only a cookie.
 *
 * Returns whether the active workspace changed, so the card knows to navigate
 * the way a switch does rather than refresh in place.
 */
export async function reconcileActiveWorkspaceAction(): Promise<{ changed: boolean }> {
  const session = await getSession();
  if (!session) return { changed: false };

  const cookieStore = await cookies();
  const active = cookieStore.get(WORKSPACE_COOKIE_NAME)?.value ?? null;
  const reachable = await workspacesService.listUserWorkspaces(session.user.id);
  if (active && reachable.some((w) => w.id === active)) return { changed: false };

  if (reachable.length > 0) {
    cookieStore.set(WORKSPACE_COOKIE_NAME, reachable[0]!.id, {
      httpOnly: false,
      sameSite: 'lax',
      secure: shouldUseSecureCookies(),
      path: '/',
    });
  } else {
    cookieStore.delete(WORKSPACE_COOKIE_NAME);
  }
  return { changed: true };
}
