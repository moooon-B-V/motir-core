'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformClassificationStateError,
  PlatformOrganizationNotFoundError,
} from '@/lib/platform/errors';
import type { FleetStopPreviewDTO, FleetStopResultDTO } from '@/lib/dto/platformFleetStop';
import { platformBillingClassificationService } from '@/lib/services/platformBillingClassificationService';
import { platformFleetStopService } from '@/lib/services/platformFleetStopService';

/**
 * The INTERNAL-BILLING classification write — design
 * `platform-admin/design-notes.md` **Panel 12**, card MOTIR-4568, the one
 * control Story MOTIR-4337 is named for.
 *
 * Transport only, exactly as `app/(admin)/admin/users/[userId]/actions.ts` is
 * and for the same reasons: resolve the platform principal, call ONE service
 * method, translate typed errors into the discriminated result the island maps
 * to its copy. Every rule about WHO may do this, whether a reason is required,
 * what gets written and in what order lives in
 * `platformBillingClassificationService`.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE, and neither is
 * redundant. The `(admin)` layout gates the PAGES; a Server Action is a POST to
 * a route the layout never renders, so it must resolve the principal itself —
 * and the service asserts once more because it is reachable from a job or a
 * route handler that has no layout at all (`platform-staff-auth.md` §2).
 *
 * ⚠️ AND IT ASKS FOR `superadmin`, ONE DEGREE ABOVE THE TWO DAY-1 SUPPORT
 * WRITES. Those act on one person's account and their blast radius is an email
 * or a session set; this changes what an ORGANIZATION IS BILLED, which is the
 * class §7's allocation table puts at `superadmin` for every other member
 * (credit grants, tier assignment, per-org flags). MOTIR-4565's own body was
 * amended on the record for this; the degree here and the degree in the service
 * are the same by construction, because both name it.
 *
 * ⚠️ AND THE FAILURE SHAPE IS A DISCRIMINATED RESULT, NOT A THROW. A throw out
 * of a Server Action reaches the browser as a generic digest with the message
 * stripped in production — so an operator who typed no reason, one who lost a
 * race with a colleague, and a database outage would all look identical. These
 * codes are what let the dialog say which it was.
 */

export type ClassificationActionResult =
  | { ok: true }
  | {
      ok: false;
      code: 'REASON_REQUIRED' | 'NOT_FOUND' | 'ALREADY_IN_STATE' | 'NOT_PERMITTED' | 'FAILED';
    };

/**
 * Classify an organization internal-billing, or remove the classification.
 *
 * ONE action for both directions, because they are one toggle in the design and
 * one invariant in the service — the same argument `setSuspendedAction` makes.
 */
export async function setInternalBillingAction(
  orgId: string,
  internalBilling: boolean,
  reason: string,
): Promise<ClassificationActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    await platformBillingClassificationService.setInternalBilling(
      principal,
      orgId,
      internalBilling,
      reason,
    );
    // ⚠️ PART OF THE ACTION, not a nicety. The write changes the org page's own
    // server-rendered surfaces — the two classification chips and the note under
    // the header — and the design is explicit that the write and its record are
    // ONE surface: *"an operator can never perform an action and wonder whether
    // it was recorded."* The page is a Server Component with no client island
    // seeding `useState` from props, so this server re-read is the whole of what
    // `CLAUDE.md`'s page-state contract asks for — there is no tick to bump.
    revalidatePath(`/admin/tenants/${orgId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof PlatformOrganizationNotFoundError) return { ok: false, code: 'NOT_FOUND' };
    // A genuine lost race between two operators on one org, not a stale page:
    // the service re-reads under a `FOR UPDATE` lock inside the transaction.
    if (err instanceof PlatformClassificationStateError) {
      return { ok: false, code: 'ALREADY_IN_STATE' };
    }
    // A principal below `superadmin` — or none at all. Translated rather than
    // rethrown so the island can say "your account cannot do this" instead of
    // rendering a crash; it says nothing about `/admin`, because this caller has
    // already passed the layout's gate and there is nothing left to leak.
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    // Anything else is real and unexplained. LOGGED rather than swallowed: the
    // operator's screen can only say "it failed", and somebody has to be able to
    // find out why.
    console.error(`[admin] classification action failed for organization ${orgId}`, err);
    return { ok: false, code: 'FAILED' };
  }
}

/**
 * STOP CONTAINERS — design `platform-admin/design-notes.md` § _AMENDMENT
 * 2026-10-02 — Org page · Fleet card and Stop containers_ (MOTIR-7315), card
 * MOTIR-7320. Two actions, the same transport shape as the classification above:
 * resolve the principal, call ONE `platformFleetStopService` method, translate
 * its typed errors into a discriminated result the dialog maps to its copy.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE, for the reason the
 * header gives. The preview is a READ (`support`, as the service asks); the stop
 * is `superadmin`, and a forged call from anyone below answers `NOT_PERMITTED`
 * before any effect. The dialog's disabled button decides nothing.
 */

export type FleetStopFailureCode = 'REASON_REQUIRED' | 'NOT_FOUND' | 'NOT_PERMITTED' | 'FAILED';

export type PreviewStopActionResult =
  | { ok: true; preview: FleetStopPreviewDTO; countedAt: string }
  | { ok: false; code: Exclude<FleetStopFailureCode, 'REASON_REQUIRED'> };

export type StopContainersActionResult =
  | { ok: true; result: FleetStopResultDTO }
  | { ok: false; code: FleetStopFailureCode };

/** What a stop WOULD do now — the confirmation's counts (design S3 e–g). */
export async function previewStopAction(orgId: string): Promise<PreviewStopActionResult> {
  try {
    const principal = await requirePlatformStaff('support');
    const preview = await platformFleetStopService.preview(principal, orgId);
    return { ok: true, preview, countedAt: new Date().toISOString() };
  } catch (err) {
    if (err instanceof PlatformOrganizationNotFoundError) return { ok: false, code: 'NOT_FOUND' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error(`[admin] fleet stop preview failed for organization ${orgId}`, err);
    return { ok: false, code: 'FAILED' };
  }
}

/**
 * Stop the org's charged containers (design S3 → S4).
 *
 * ⚠️ THE PAGE RE-READS ON EVERY OUTCOME BUT A REFUSED REASON. A stop is three
 * stop paths, not one transaction: after `FAILED` some containers may already
 * be gone, and after `NOT_PERMITTED` the foot must show the role it now has. So
 * the Fleet card's tiles and its last-stop row, and the action log beneath it —
 * all server-rendered — re-read here. The result itself is held by the dialog's
 * island, which the refresh does not remount.
 */
export async function stopContainersAction(
  orgId: string,
  reason: string,
): Promise<StopContainersActionResult> {
  let outcome: StopContainersActionResult;
  try {
    const principal = await requirePlatformStaff('superadmin');
    const result = await platformFleetStopService.stop(principal, orgId, reason);
    outcome = { ok: true, result };
  } catch (err) {
    // Refused before any effect, so there is nothing to re-read.
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof PlatformOrganizationNotFoundError) return { ok: false, code: 'NOT_FOUND' };
    if (err instanceof NotPlatformStaffError) {
      outcome = { ok: false, code: 'NOT_PERMITTED' };
    } else {
      console.error(`[admin] fleet stop failed for organization ${orgId}`, err);
      outcome = { ok: false, code: 'FAILED' };
    }
  }
  revalidatePath(`/admin/tenants/${orgId}`);
  return outcome;
}
