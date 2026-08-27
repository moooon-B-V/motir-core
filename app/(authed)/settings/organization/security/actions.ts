'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/auth';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';
import { organizationsService } from '@/lib/services/organizationsService';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import type { RequireTwoFactorSaveResult } from '../_components/RequireTwoFactorCard';

// The org Security pane's write (Story MOTIR-1215 · Subtask MOTIR-3646).
//
// Transport only, per `CLAUDE.md`'s 4-layer rule: read the session, resolve the
// active org the way every sibling pane does, call exactly ONE service method,
// and translate a typed domain error into a return value. No `db.*` and no
// `$transaction` — `twoFactorPolicyService` owns both.
//
// ⚠️ ABSOLUTE, NOT A TOGGLE. The parameter is the DESIRED value, and there is
// deliberately no action that flips one. A toggle is a read-derived write: two
// admins acting at once both invert the value they read, and the state that
// survives is whichever commit landed last. The service's own header carries the
// rule; this is the door that must not reintroduce it.

export async function setOrganizationRequireTwoFactorAction(
  requiresTwoFactor: boolean,
): Promise<RequireTwoFactorSaveResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const orgCookie = (await cookies()).get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const current = await organizationsService.resolveActiveOrganization(session.user.id, orgCookie);
  if (!current) redirect('/dashboard');

  const errors = await getErrorsTranslator();
  try {
    await twoFactorPolicyService.setOrganizationPolicy({
      organizationId: current.organization.id,
      actorUserId: session.user.id,
      requiresTwoFactor,
    });
  } catch (err) {
    // The two the service raises. Anything else is a real fault and rethrows —
    // swallowing it here would report a failed write as a handled refusal.
    if (err instanceof OrgForbiddenError || err instanceof OrganizationNotFoundError) {
      return { ok: false, error: errors('actions.orgSecurityForbidden') };
    }
    throw err;
  }

  // The pane itself re-reads on the next navigation. `/settings/organization` is
  // revalidated too because MOTIR-3647 folds the WORKSPACE control onto that
  // page below the reveal threshold, and its locked state is computed from THIS
  // value — so a save here changes what that page shows. Revalidating a path
  // that is currently 404 is a no-op, which is what makes it safe to send both
  // unconditionally (the same reasoning `settings/workspace/actions.ts` records).
  revalidatePath('/settings/organization/security');
  revalidatePath('/settings/organization');
  return { ok: true };
}
