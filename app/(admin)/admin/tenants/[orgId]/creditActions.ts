'use server';

import { revalidatePath } from 'next/cache';
import type {
  PlatformCreditLedgerPageDTO,
  PlatformCreditWriteDTO,
  PlatformPlanSetDTO,
} from '@/lib/dto/platformCreditOps';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformCreditAmountInvalidError,
  PlatformCreditConflictError,
  PlatformCreditInsufficientBalanceError,
  PlatformCreditRejectedError,
  PlatformCreditServiceUnavailableError,
  PlatformLargeGrantUnconfirmedError,
  PlatformOrganizationNotFoundError,
} from '@/lib/platform/errors';
import { platformCreditOpsService } from '@/lib/services/platformCreditOpsService';

/**
 * The CREDITS & PLAN writes — design `platform-admin/design-notes.md` AMENDMENT
 * 2026-10-03 Panels 1–2, card MOTIR-747. The dialogs that call these are
 * MOTIR-752's.
 *
 * Transport only, the `actions.ts` (classification) shape: resolve the platform
 * principal, call ONE service method, translate typed errors into a
 * discriminated result the dialog maps to its copy. Every rule — who, the
 * reason, the amount, the large-grant confirm, the ordering against motir-ai —
 * lives in `platformCreditOpsService`.
 *
 * ⚠️ The gate is asserted here AND in the service (`platform-staff-auth.md` §2):
 * the layout gates the pages, and a Server Action is a POST it never renders.
 *
 * ⚠️ `requestId` IS THE DIALOG'S, NOT THIS FILE'S. The dialog mints one when it
 * opens and sends the same one on a retry, so "try again" after an unreachable
 * answer can never grant twice (motir-ai is idempotent on it). An action that
 * minted its own per call would make every retry a new grant.
 *
 * ⚠️ PAGE STATE: the writes change the server-rendered org page (balance, plan,
 * the "Platform actions" card), so each calls `revalidatePath`. A client island
 * that holds the LEDGER PAGE in state (Newer / Older) must also refetch from the
 * DTO each write returns — `CLAUDE.md`'s page-state contract, case 3.
 */

export type CreditOpsFailureCode =
  | 'REASON_REQUIRED'
  | 'AMOUNT_INVALID'
  | 'LARGE_GRANT_UNCONFIRMED'
  | 'INSUFFICIENT_BALANCE'
  | 'CONFLICT'
  | 'REJECTED'
  | 'CREDIT_SERVICE_UNREACHABLE'
  | 'NOT_FOUND'
  | 'NOT_PERMITTED'
  | 'FAILED';

export type CreditOpsActionResult<T> =
  | { ok: true; result: T }
  | { ok: false; code: CreditOpsFailureCode; detail?: string };

function toFailure(orgId: string, what: string, err: unknown): CreditOpsActionResult<never> {
  if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
  if (err instanceof PlatformCreditAmountInvalidError) return { ok: false, code: 'AMOUNT_INVALID' };
  if (err instanceof PlatformLargeGrantUnconfirmedError) {
    return { ok: false, code: 'LARGE_GRANT_UNCONFIRMED' };
  }
  if (err instanceof PlatformCreditInsufficientBalanceError) {
    return { ok: false, code: 'INSUFFICIENT_BALANCE' };
  }
  if (err instanceof PlatformCreditConflictError) {
    return { ok: false, code: 'CONFLICT', detail: err.detail };
  }
  if (err instanceof PlatformCreditRejectedError) {
    return { ok: false, code: 'REJECTED', detail: err.detail };
  }
  if (err instanceof PlatformCreditServiceUnavailableError) {
    return { ok: false, code: 'CREDIT_SERVICE_UNREACHABLE' };
  }
  if (err instanceof PlatformOrganizationNotFoundError) return { ok: false, code: 'NOT_FOUND' };
  if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
  console.error('[admin] %s failed for organization %s', what, orgId, err);
  return { ok: false, code: 'FAILED' };
}

/** Grant credits (Panel 2a/2b). `confirmSlug` is required at or above the large-grant threshold. */
export async function grantCreditsAction(
  orgId: string,
  input: { credits: number; reason: string; requestId: string; confirmSlug?: string | null },
): Promise<CreditOpsActionResult<PlatformCreditWriteDTO>> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const result = await platformCreditOpsService.grantCredits(principal, orgId, input);
    revalidatePath(`/admin/tenants/${orgId}`);
    return { ok: true, result };
  } catch (err) {
    return toFailure(orgId, 'credit grant', err);
  }
}

/** Adjust the balance by a signed amount (Panel 2c). */
export async function adjustCreditsAction(
  orgId: string,
  input: { credits: number; reason: string; requestId: string },
): Promise<CreditOpsActionResult<PlatformCreditWriteDTO>> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const result = await platformCreditOpsService.adjustCredits(principal, orgId, input);
    revalidatePath(`/admin/tenants/${orgId}`);
    return { ok: true, result };
  } catch (err) {
    return toFailure(orgId, 'credit adjustment', err);
  }
}

/** Change the org's AI plan tier (Panel 2d). */
export async function setPlanAction(
  orgId: string,
  input: { tierKey: string; reason: string; requestId: string },
): Promise<CreditOpsActionResult<PlatformPlanSetDTO>> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const result = await platformCreditOpsService.setPlan(principal, orgId, input);
    revalidatePath(`/admin/tenants/${orgId}`);
    return { ok: true, result };
  } catch (err) {
    return toFailure(orgId, 'plan change', err);
  }
}

/** One page of the ledger — the card's Newer / Older. Any staff role. */
export async function loadCreditLedgerPageAction(
  orgId: string,
  cursor: string | null,
): Promise<CreditOpsActionResult<PlatformCreditLedgerPageDTO>> {
  try {
    const principal = await requirePlatformStaff('support');
    const result = await platformCreditOpsService.getLedger(principal, orgId, cursor);
    return { ok: true, result };
  } catch (err) {
    return toFailure(orgId, 'credit ledger read', err);
  }
}
