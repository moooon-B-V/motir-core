'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext, WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';
import { workspacesService } from '@/lib/services/workspacesService';
import { LastMemberError } from '@/lib/workspaces/errors';

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
  revalidatePath('/settings/workspace');
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
      secure: process.env['NODE_ENV'] === 'production',
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
  revalidatePath('/settings/workspace');
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

export async function deleteWorkspaceAction(): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  await workspacesService.deleteWorkspace({ workspaceId, actorUserId: userId });
  await switchToRemainingOrClear(userId);
  redirect('/dashboard');
}
