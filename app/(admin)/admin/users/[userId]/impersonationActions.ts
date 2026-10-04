'use server';

import { cookies } from 'next/headers';
import { getOperatorSession, requirePlatformStaff } from '@/lib/platform/auth';
import {
  ImpersonationInvalidRequestError,
  ImpersonationTargetIneligibleError,
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformUserNotFoundError,
} from '@/lib/platform/errors';
import { STAFF_SESSION_COOKIE, staffSessionCookieOptions } from '@/lib/platform/staffSession';
import { impersonationService } from '@/lib/services/impersonationService';

/**
 * START a staff "View as" session — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-03, Panel 4 (Story 10.3 · MOTIR-749), the `superadmin`
 * row of ADR §7.
 *
 * Transport only: resolve the principal and the operator's OWN sign-in (the
 * session the staff session is bound to), call ONE service method, set the
 * staff-session cookie from the token it returns, translate typed errors into
 * the discriminated result the dialog maps to copy. Who may, the time-box, the
 * reason, the eligibility rules and the audit rows all live in the service.
 *
 * The browser then does a FULL navigation into the tenant (`location.assign`),
 * so the first page of the session renders with the cookie — a Server Action
 * redirect would render that page from the action's own request, which still
 * carries the cookie header it was sent with.
 */

export type StartStaffSessionResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      code: 'REASON_REQUIRED' | 'NOT_FOUND' | 'INELIGIBLE' | 'INVALID' | 'NOT_PERMITTED' | 'FAILED';
    };

export async function startStaffSessionAction(input: {
  userId: string;
  mode: string;
  durationMinutes: number;
  reason: string;
  workspaceId?: string | null;
}): Promise<StartStaffSessionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const signIn = await getOperatorSession();
    if (!signIn) return { ok: false, code: 'NOT_PERMITTED' };
    const started = await impersonationService.start(principal, {
      targetUserId: input.userId,
      mode: input.mode,
      durationMinutes: input.durationMinutes,
      reason: input.reason,
      workspaceId: input.workspaceId ?? null,
      operator: { userId: signIn.user.id, sessionId: signIn.session.id },
    });
    (await cookies()).set(
      STAFF_SESSION_COOKIE,
      started.token,
      staffSessionCookieOptions(new Date(started.session.expiresAt)),
    );
    return { ok: true, sessionId: started.session.id };
  } catch (err) {
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof PlatformUserNotFoundError) return { ok: false, code: 'NOT_FOUND' };
    if (err instanceof ImpersonationTargetIneligibleError) return { ok: false, code: 'INELIGIBLE' };
    if (err instanceof ImpersonationInvalidRequestError) return { ok: false, code: 'INVALID' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    // A constant format string: the target id is an argument, never the format.
    console.error('[admin] staff session start failed for user %s', input.userId, err);
    return { ok: false, code: 'FAILED' };
  }
}
