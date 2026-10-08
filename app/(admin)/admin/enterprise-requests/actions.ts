'use server';

import { revalidatePath } from 'next/cache';
import type {
  EnterpriseRequestStatusValue,
  PlatformEnterpriseRequestDetailDTO,
  PlatformEnterpriseRequestPageDTO,
} from '@/lib/dto/platformEnterpriseRequest';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  EnterpriseRequestIllegalTransitionError,
  EnterpriseRequestStaleError,
  NotPlatformStaffError,
  PlatformEnterpriseRequestNotFoundError,
  PlatformEnterpriseRequestQueryInvalidError,
} from '@/lib/platform/errors';
import { platformEnterpriseRequestService } from '@/lib/services/platformEnterpriseRequestService';

/**
 * The ENTERPRISE REQUESTS console's doors — Story MOTIR-7602 · MOTIR-7608, for
 * the page MOTIR-7609 builds (design `platform-admin/design-notes.md`
 * § Enterprise requests).
 *
 * Transport only, the `run-models/actions.ts` shape: resolve the platform
 * principal, call ONE service method, and translate the typed errors into the
 * discriminated result the page maps to its copy. A thrown error would reach the
 * browser as a stripped digest, so every refusal is a result.
 */

type Refusal<C extends string> = { ok: false; code: C };

export type EnterpriseRequestListResult =
  | { ok: true; page: PlatformEnterpriseRequestPageDTO }
  | Refusal<'INVALID_QUERY' | 'NOT_PERMITTED' | 'FAILED'>;

export type EnterpriseRequestGetResult =
  | { ok: true; detail: PlatformEnterpriseRequestDetailDTO }
  | Refusal<'NOT_FOUND' | 'NOT_PERMITTED' | 'FAILED'>;

export type EnterpriseRequestTransitionResult =
  | { ok: true }
  | {
      ok: false;
      code: 'STALE';
      currentStatus: string;
      movedBy: { userId: string; email: string } | null;
    }
  | Refusal<'ILLEGAL_TRANSITION' | 'NOT_FOUND' | 'NOT_PERMITTED' | 'FAILED'>;

export async function listEnterpriseRequestsAction(
  status: string | null,
  cursor: string | null,
): Promise<EnterpriseRequestListResult> {
  try {
    const principal = await requirePlatformStaff('support');
    const page = await platformEnterpriseRequestService.list(principal, { status, cursor });
    return { ok: true, page };
  } catch (err) {
    if (err instanceof PlatformEnterpriseRequestQueryInvalidError) {
      return { ok: false, code: 'INVALID_QUERY' };
    }
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin] enterprise-request list failed', { status, cursor }, err);
    return { ok: false, code: 'FAILED' };
  }
}

export async function getEnterpriseRequestAction(id: string): Promise<EnterpriseRequestGetResult> {
  try {
    const principal = await requirePlatformStaff('support');
    const detail = await platformEnterpriseRequestService.get(principal, id);
    return { ok: true, detail };
  } catch (err) {
    if (err instanceof PlatformEnterpriseRequestNotFoundError) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin] enterprise-request read failed', { id }, err);
    return { ok: false, code: 'FAILED' };
  }
}

export async function transitionEnterpriseRequestAction(
  id: string,
  organizationId: string,
  from: EnterpriseRequestStatusValue,
  to: EnterpriseRequestStatusValue,
): Promise<EnterpriseRequestTransitionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    await platformEnterpriseRequestService.transition(principal, id, { organizationId, from, to });
    revalidateRequest(id);
    return { ok: true };
  } catch (err) {
    if (err instanceof EnterpriseRequestStaleError) {
      // The page re-reads, so the pill, the moves and the History show the
      // state that won.
      revalidateRequest(id);
      return {
        ok: false,
        code: 'STALE',
        currentStatus: err.currentStatus,
        movedBy: err.movedBy,
      };
    }
    if (err instanceof EnterpriseRequestIllegalTransitionError) {
      return { ok: false, code: 'ILLEGAL_TRANSITION' };
    }
    if (err instanceof PlatformEnterpriseRequestNotFoundError) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin] enterprise-request move failed', { id, from, to }, err);
    return { ok: false, code: 'FAILED' };
  }
}

/** The list and the detail are server-rendered; both change on a move. */
function revalidateRequest(id: string) {
  revalidatePath('/admin/enterprise-requests');
  revalidatePath(`/admin/enterprise-requests/${id}`);
}
