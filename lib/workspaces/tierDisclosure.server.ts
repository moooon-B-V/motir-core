import { cookies } from 'next/headers';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { getWorkspaceContext } from '@/lib/workspaces';
import {
  isWorkspaceTierRevealed,
  preferredOrganizationId,
  scopeWorkspacesToActiveOrg,
} from './tierDisclosure';

// The SERVER half of the workspace-tier disclosure rule (MOTIR-3502). Split from
// the pure predicate in `tierDisclosure.ts` because this file reaches for
// `next/headers` and the service layer, and the predicate is shared with two
// `'use client'` components that cannot carry either.

/**
 * The FULL server-side resolution, for a route that does not already hold the
 * shell's data — `app/(authed)/settings/workspace/page.tsx`, which must decide
 * its own existence before the layout's props are of any use to it.
 *
 * The (authed) layout does NOT call this: it already has `listUserWorkspaces`
 * and `resolveActiveOrganization` in flight for other reasons, so it composes
 * the same two helpers directly rather than paying for a second round trip.
 * `tests/navigation/workspace-tier-disclosure.test.ts` asserts the two paths
 * return the same verdict on the same fixture.
 */
export async function resolveWorkspaceTierDisclosure(userId: string): Promise<{
  activeOrgId: string | null;
  workspaceCount: number;
  revealed: boolean;
}> {
  const [ctx, workspaces, cookieStore] = await Promise.all([
    getWorkspaceContext(),
    workspacesService.listUserWorkspaces(userId),
    cookies(),
  ]);
  const activeWorkspace = ctx ? (workspaces.find((w) => w.id === ctx.workspaceId) ?? null) : null;
  const orgCookie = cookieStore.get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const currentOrg = await organizationsService.resolveActiveOrganization(
    userId,
    preferredOrganizationId(activeWorkspace, orgCookie),
  );
  const activeOrgId = currentOrg?.organization.id ?? null;
  const workspaceCount = scopeWorkspacesToActiveOrg(workspaces, activeOrgId).length;
  return { activeOrgId, workspaceCount, revealed: isWorkspaceTierRevealed(workspaceCount) };
}
