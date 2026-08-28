'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { accountDeletionService } from '@/lib/services/accountDeletionService';
import { DATA_PRIVACY_PANE_PATH } from '@/lib/users/dataSubjectRequests';
import {
  AccountDeletionAlreadyCompletedError,
  AccountDeletionAlreadyScheduledError,
  AccountDeletionBlockedError,
  NoOpenAccountDeletionRequestError,
} from '@/lib/users/errors';
import type { AccountDeletionRequestDTO } from '@/lib/dto/accountErasure';

// Server Actions for the account-deletion WRITE (Story 8.4 · Subtask
// MOTIR-3704) — scheduling from the confirmation ledger, and cancelling from
// EITHER of the two doors design DECISION 4 requires.
//
// ── WHY THEY LIVE AT THE SHELL LEVEL, BESIDE `_actions.ts` ──────────────────
// DECISION 4's requirement is that the grace period is REACHABLE: *"a grace
// period is only reachable if the reader can find it"*, so the cancel has two
// doors — the `Data › Data & privacy` pane, and an app-wide banner mounted once
// in the authed shell. One of those doors is a leaf page and the other is the
// layout above every page, so an action module owned by either would be
// imported the wrong way round by the other. This is the same shape
// `_project-actions.ts` already has for the top-nav switcher plus the project
// surfaces, and it is why that file sits here rather than under `projects/`.
//
// TWO DOORS, ONE ACT — deliberately one exported `cancelAccountDeletionAction`
// rather than one per surface. A second copy would be two doors onto two acts,
// which is the thing that drifts.
//
// TRANSPORT ONLY, per CLAUDE.md's 4-layer contract: resolve the session, call
// exactly ONE service method, translate its typed domain error into the
// discriminated result the surface maps to copy. No `db.*` and no
// `$transaction` here — `accountDeletionService` owns the lock, the partial
// unique index and the post-commit sign-out.

export type ScheduleAccountDeletionResult =
  | { ok: true; request: AccountDeletionRequestDTO }
  | { ok: false; code: 'BLOCKED' | 'ALREADY_SCHEDULED' | 'FAILED' };

export type CancelAccountDeletionResult =
  | { ok: true; request: AccountDeletionRequestDTO }
  | { ok: false; code: 'NONE_OPEN' | 'ALREADY_COMPLETED' | 'FAILED' };

/**
 * Close the account now and schedule its erasure — the confirmation ledger's
 * `Delete my account`.
 *
 * ⚠️ THE BLOCK IS STILL A READ, and this action does not become the place it is
 * caught. `scheduleAccountDeletion` asks the impact preview for its verdict
 * before writing anything (DECISION 5: *"a blocked state discovered at submit
 * is a design defect, not an error message"*), and the pane renders that same
 * verdict at rest so the control is disabled long before anybody reaches here.
 * The `BLOCKED` arm below is therefore the RESIDUAL — an organization that lost
 * its second owner between the pane's read and this submit — not the primary
 * path, and it is mapped to copy rather than to a stack trace because that
 * reader is looking at a dialog they were correctly allowed to open.
 *
 * `revalidatePath` re-runs the pane's server read so it repaints as the
 * scheduled state; the caller ALSO calls `router.refresh()`, which is what
 * reaches the app-wide banner in the layout above whatever route the reader is
 * standing on (CLAUDE.md's page-state contract, route 2).
 */
export async function scheduleAccountDeletionAction(): Promise<ScheduleAccountDeletionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  try {
    const request = await accountDeletionService.scheduleAccountDeletion(session.user.id);
    revalidatePath(DATA_PRIVACY_PANE_PATH);
    return { ok: true, request };
  } catch (err) {
    if (err instanceof AccountDeletionBlockedError) return { ok: false, code: 'BLOCKED' };
    if (err instanceof AccountDeletionAlreadyScheduledError) {
      return { ok: false, code: 'ALREADY_SCHEDULED' };
    }
    return { ok: false, code: 'FAILED' };
  }
}

/**
 * Take the deletion back — the pane's `Cancel deletion` AND the app-wide
 * banner's, which are the two doors DECISION 4 asks for.
 *
 * The EXPLICIT act, so it calls `cancelAccountDeletion` (which throws) rather
 * than `cancelAccountDeletionIfScheduled` (which returns `null`): somebody
 * pressed a button, so *"nothing was scheduled"* and *"it has already been
 * erased"* are both answers the surface must be able to render, and they are
 * opposite answers. The sign-in hook is the one that wants the quiet form.
 */
export async function cancelAccountDeletionAction(): Promise<CancelAccountDeletionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  try {
    const request = await accountDeletionService.cancelAccountDeletion(session.user.id);
    revalidatePath(DATA_PRIVACY_PANE_PATH);
    return { ok: true, request };
  } catch (err) {
    if (err instanceof NoOpenAccountDeletionRequestError) return { ok: false, code: 'NONE_OPEN' };
    if (err instanceof AccountDeletionAlreadyCompletedError) {
      return { ok: false, code: 'ALREADY_COMPLETED' };
    }
    return { ok: false, code: 'FAILED' };
  }
}
