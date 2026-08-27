'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformSuspensionStateError,
  PlatformUserNotFoundError,
} from '@/lib/platform/errors';
import { platformSupportService } from '@/lib/services/platformSupportService';

/**
 * The two day-1 support WRITES — design `platform-admin/design-notes.md`
 * **Panel 9**, card MOTIR-1167, the `operator` tier of the ADR's §7 table.
 *
 * Transport only, exactly as `CLAUDE.md` says a Server Action must be (they are
 * the route layer's equivalent): resolve the platform principal, call ONE
 * service method, translate typed errors into the discriminated result the pane
 * maps to its copy. Every rule about WHO may do this, whether a reason is
 * required, what gets written and in what order lives in the service.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE, and neither is
 * redundant. The `(admin)` layout gates the PAGES; a Server Action is a POST to
 * a route the layout never renders, so it must resolve the principal itself —
 * and the service asserts once more because it is reachable from a job or a
 * route handler that has no layout at all (ADR §2's two-layer rule).
 *
 * ⚠️ AND THE FAILURE SHAPE IS A DISCRIMINATED RESULT, NOT A THROW. A throw out
 * of a Server Action reaches the browser as a generic "an error occurred" digest
 * with the message stripped in production — so an operator who typed no reason,
 * or who lost a race with a colleague, would see the same opaque failure as a
 * database outage. These codes are what let the dialog say which it was.
 */

export type SupportActionResult =
  | { ok: true }
  | {
      ok: false;
      code: 'REASON_REQUIRED' | 'NOT_FOUND' | 'ALREADY_IN_STATE' | 'NOT_PERMITTED' | 'FAILED';
    };

/** Send the account holder a password-reset link. */
export async function sendPasswordResetAction(
  userId: string,
  reason: string,
): Promise<SupportActionResult> {
  return run(userId, async (principal) => {
    await platformSupportService.sendPasswordReset(principal, userId, reason);
  });
}

/** Suspend or unsuspend one account. */
export async function setSuspendedAction(
  userId: string,
  suspended: boolean,
  reason: string,
): Promise<SupportActionResult> {
  return run(userId, async (principal) => {
    await platformSupportService.setSuspended(principal, userId, suspended, reason);
  });
}

/**
 * The shared transport: gate, act, translate, refresh.
 *
 * ⚠️ `revalidatePath` IS PART OF THE ACTION, not a nicety. Both writes change
 * the drill-down's own server-rendered surfaces — the identity header's status
 * chip, the session count, and the "Support actions" log that must show the row
 * the write just produced. The design is explicit that the write and its record
 * are ONE surface: *"an operator can never perform an action and wonder whether
 * it was recorded."* The page is a Server Component with no client island
 * seeding `useState` from props, so the server re-read is the whole of what
 * `CLAUDE.md`'s page-state contract asks for here — there is no tick to bump.
 */
async function run(
  userId: string,
  act: (principal: Awaited<ReturnType<typeof requirePlatformStaff>>) => Promise<void>,
): Promise<SupportActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    await act(principal);
    revalidatePath(`/admin/users/${userId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof PlatformUserNotFoundError) return { ok: false, code: 'NOT_FOUND' };
    if (err instanceof PlatformSuspensionStateError) {
      return { ok: false, code: 'ALREADY_IN_STATE' };
    }
    // A principal below `operator` — or none at all. It is translated rather
    // than rethrown so the pane can say "your account cannot do this" instead of
    // rendering a crash, and the message says nothing about `/admin`: this
    // caller has already passed the layout's gate, so there is no existence to
    // leak, but there is also nothing useful to add.
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    // Anything else — a database fault, a rejected email send — is real and
    // unexplained. It is LOGGED rather than swallowed silently, because the
    // operator's screen can only say "it failed" and somebody has to be able to
    // find out why.
    console.error(`[admin] support action failed for user ${userId}`, err);
    return { ok: false, code: 'FAILED' };
  }
}
