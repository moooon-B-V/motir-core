'use server';

import { revalidatePath } from 'next/cache';
import type { PlatformOrganizationDetailDTO } from '@/lib/dto/platform';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformOrganizationNotFoundError,
  PlatformOrganizationSuspensionStateError,
} from '@/lib/platform/errors';
import {
  platformOrgLifecycleService,
  type PlatformOrganizationSuspendResultDTO,
} from '@/lib/services/platformOrgLifecycleService';

/**
 * ORGANIZATION SUSPEND / REACTIVATE — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-03, Panel 3 (MOTIR-748; the dialogs are MOTIR-752's).
 *
 * Transport only, exactly as `./actions.ts` is: resolve the platform principal
 * at `superadmin`, call ONE service method, translate typed errors into the
 * discriminated result the dialog maps to its copy. Every rule — who may, the
 * required reason, the lock-and-re-read, the audit row — lives in
 * `platformOrgLifecycleService`.
 *
 * ⚠️ THE TYPED-SLUG CONFIRMATION IS THE DIALOG'S, NOT THIS ACTION'S. The design
 * puts it on Suspend as a guard against a slip of the hand; the server-side guard
 * is the REASON, which the service refuses blank before any row is written.
 *
 * ⚠️ A DISCRIMINATED RESULT, NOT A THROW — a thrown Server Action error reaches
 * the browser as an opaque digest, so a blank reason, a lost race and an outage
 * would look identical.
 */

export type OrgLifecycleFailureCode =
  | 'REASON_REQUIRED'
  | 'NOT_FOUND'
  | 'ALREADY_IN_STATE'
  | 'NOT_PERMITTED'
  | 'FAILED';

export type OrgLifecycleActionResult<T> =
  | { ok: true; result: T }
  | { ok: false; code: OrgLifecycleFailureCode };

function failure(
  orgId: string,
  verb: string,
  err: unknown,
): { ok: false; code: OrgLifecycleFailureCode } {
  if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
  if (err instanceof PlatformOrganizationNotFoundError) return { ok: false, code: 'NOT_FOUND' };
  // A genuine lost race (decided under `FOR UPDATE`), or a stale page.
  if (err instanceof PlatformOrganizationSuspensionStateError) {
    return { ok: false, code: 'ALREADY_IN_STATE' };
  }
  if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
  console.error('[admin] %s failed for organization %s', verb, orgId, err);
  return { ok: false, code: 'FAILED' };
}

/**
 * Suspend the organization. Every member of every workspace under it is refused
 * from their next request; its CI fleet is stopped best-effort after the commit
 * (`result.fleetStop`).
 */
export async function suspendOrganizationAction(
  orgId: string,
  input: { reason: string },
): Promise<OrgLifecycleActionResult<PlatformOrganizationSuspendResultDTO>> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const result = await platformOrgLifecycleService.suspend(principal, orgId, input.reason);
    // The org page is a Server Component (status card, header pill, the trail
    // row this write produced) — the server re-read is the whole page-state ask.
    revalidatePath(`/admin/tenants/${orgId}`);
    return { ok: true, result };
  } catch (err) {
    return failure(orgId, 'suspend', err);
  }
}

/** Reactivate a suspended organization. Its kill-switches keep their state. */
export async function reactivateOrganizationAction(
  orgId: string,
  input: { reason: string },
): Promise<OrgLifecycleActionResult<PlatformOrganizationDetailDTO>> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const result = await platformOrgLifecycleService.reactivate(principal, orgId, input.reason);
    revalidatePath(`/admin/tenants/${orgId}`);
    return { ok: true, result };
  } catch (err) {
    return failure(orgId, 'reactivate', err);
  }
}
