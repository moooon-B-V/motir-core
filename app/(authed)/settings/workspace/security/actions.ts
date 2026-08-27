'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/auth';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getWorkspaceContext } from '@/lib/workspaces';
import { NotAMemberError, WorkspaceForbiddenError } from '@/lib/workspaces/errors';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import type { RequireTwoFactorSaveResult } from '../../organization/_components/RequireTwoFactorCard';

// The workspace Security control's write (Story MOTIR-1215 · Subtask MOTIR-3647).
//
// Transport only, mirroring `../actions.ts`: read the session and the active
// workspace, call exactly ONE service method, translate a typed domain error.
//
// ⚠️ THE SERVICE IS THE GATE, NOT THE UI. The control renders read-only for a
// `member` / `viewer`, but that is a courtesy to the reader — this action is a
// public entry point, and a member invoking it directly is refused by
// `setWorkspacePolicy`'s own `isWorkspaceManager` check. The refusal is asserted
// in `tests/twoFactorPolicy.test.ts` rather than inferred from the switch being
// disabled.
//
// ⚠️ ABSOLUTE, NOT A TOGGLE — the same rule the org action carries, for the same
// reason: two admins flipping at once would otherwise land on a policy nobody
// chose.

export async function setWorkspaceRequireTwoFactorAction(
  requiresTwoFactor: boolean,
): Promise<RequireTwoFactorSaveResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/dashboard');

  const errors = await getErrorsTranslator();
  try {
    await twoFactorPolicyService.setWorkspacePolicy({
      workspaceId: ctx.workspaceId,
      actorUserId: session.user.id,
      requiresTwoFactor,
    });
  } catch (err) {
    if (err instanceof WorkspaceForbiddenError || err instanceof NotAMemberError) {
      return { ok: false, error: errors('actions.workspaceSecurityForbidden') };
    }
    throw err;
  }

  // BOTH homes, because the control has two (`organization-tier.md` §6d): the
  // standalone pane above the workspace-tier reveal threshold, and the fold-in
  // on `/settings/organization` below it. Only one of them exists at a time, and
  // revalidating a path that is currently 404 is a no-op — which is what makes
  // sending both unconditionally the correct thing rather than a hedge.
  revalidatePath('/settings/workspace/security');
  revalidatePath('/settings/organization');
  return { ok: true };
}
