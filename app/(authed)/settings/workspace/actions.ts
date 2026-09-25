'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext, WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import { workspacesService } from '@/lib/services/workspacesService';
import { LastMemberError } from '@/lib/workspaces/errors';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';

// Server Actions for the workspace settings page. HTTP/transport layer:
// each reads the session + active workspace, calls exactly one service
// method, and translates the result into a return value or a redirect.
// No db.* / $transaction here — the service owns those.

export interface ActionResult {
  ok: boolean;
  error?: string;
}

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/dashboard');
  return { userId: session.user.id, workspaceId: ctx.workspaceId };
}

/**
 * These cards render on TWO routes, not one (MOTIR-3502). `/settings/workspace`
 * is the standalone area, shown once the workspace tier is revealed; below the
 * threshold that route 404s and `/settings/organization` HOSTS the very same
 * `NameCard` / `MembersCard` / `DangerZoneCard` via `WorkspaceFoldInSection`
 * (`docs/decisions/organization-tier.md` §6d).
 *
 * So revalidating only the workspace path leaves the folded-in copy stale after
 * a save — on the exact surface the collapsed state makes the ONLY one the user
 * can reach, which is where the bug would be invisible to anyone testing at two
 * workspaces. Revalidating a path that is currently 404 is a no-op, so both are
 * always safe to send.
 */
function revalidateWorkspaceSettingsSurfaces(): void {
  revalidatePath('/settings/workspace');
  revalidatePath('/settings/organization');
}

export async function renameWorkspaceAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  const name = String(formData.get('name') ?? '').trim();
  if (!name)
    return { ok: false, error: (await getErrorsTranslator())('actions.workspaceNameEmpty') };

  await workspacesService.renameWorkspace({ workspaceId, actorUserId: userId, name });
  // Re-render the settings page + the top-nav switcher (in the shared
  // layout) so the new name shows everywhere without a hard reload.
  revalidateWorkspaceSettingsSurfaces();
  revalidatePath('/', 'layout');
  return { ok: true };
}

/**
 * After leaving or deleting, the user's active workspace is gone. Resolve
 * a remaining membership to switch to; if none remain, clear the cookie
 * so getWorkspaceContext() returns null and the UI shows the
 * create-first-workspace empty state.
 */
async function switchToRemainingOrClear(userId: string): Promise<void> {
  const remaining = await workspacesService.listUserWorkspaces(userId);
  const cookieStore = await cookies();
  if (remaining.length > 0) {
    cookieStore.set(WORKSPACE_COOKIE_NAME, remaining[0]!.id, {
      httpOnly: false,
      sameSite: 'lax',
      secure: shouldUseSecureCookies(),
      path: '/',
    });
  } else {
    cookieStore.delete(WORKSPACE_COOKIE_NAME);
  }
}

/**
 * Remove another member from the active workspace. The actor must be a
 * member (requireContext guarantees a resolved active workspace). Refuses
 * to remove yourself — that's the Leave flow, which has the last-member
 * guard. The last-member guard in the service also applies here, but a
 * self-removal is blocked earlier for a clearer contract.
 */
export async function removeMemberAction(targetUserId: string): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  const t = await getErrorsTranslator();
  if (targetUserId === userId) {
    return { ok: false, error: t('actions.useLeaveToRemoveSelf') };
  }
  try {
    await workspacesService.removeMember({ userId: targetUserId, workspaceId });
  } catch (err) {
    if (err instanceof LastMemberError) {
      return { ok: false, error: t('actions.cannotRemoveLastMember') };
    }
    throw err;
  }
  revalidateWorkspaceSettingsSurfaces();
  return { ok: true };
}

export async function leaveWorkspaceAction(): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  try {
    await workspacesService.removeMember({ userId, workspaceId });
  } catch (err) {
    if (err instanceof LastMemberError) {
      return {
        ok: false,
        error: (await getErrorsTranslator())('actions.cannotLeaveLastMember'),
      };
    }
    throw err;
  }
  await switchToRemainingOrClear(userId);
  redirect('/dashboard');
}

/**
 * Remove the ACTIVE workspace — through the org-Admin door (MOTIR-6309).
 * Removing a workspace is an org Owner's or Admin's act now, not any member's,
 * so this calls `removeWorkspaceAsOrgAdmin` and turns its refusal into a
 * value the dialog shows (a Member, or someone outside the org, is refused).
 *
 * ⚠️ AN INTERIM DOOR. The workspace-tier Delete row this action serves is
 * retired by MOTIR-6312, which moves removal to the org Workspaces section
 * (`/api/organizations/[orgId]/workspaces/[workspaceId]`); this action goes with
 * that row.
 */
export async function removeWorkspaceAction(): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  try {
    await workspacesService.removeWorkspaceAsOrgAdmin({ workspaceId, actorUserId: userId });
  } catch (err) {
    if (err instanceof OrgForbiddenError || err instanceof OrganizationNotFoundError) {
      return {
        ok: false,
        error: (await getErrorsTranslator())('actions.workspaceRemoveForbidden'),
      };
    }
    throw err;
  }
  await switchToRemainingOrClear(userId);
  redirect('/dashboard');
}
