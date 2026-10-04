'use server';

import { revalidatePath } from 'next/cache';
import type {
  PlatformOrgFeatureFlagDTO,
  PlatformOrgFeatureFlagsDTO,
} from '@/lib/dto/platformFeatureFlags';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformFeatureFlagStateError,
  PlatformOrganizationNotFoundError,
  PlatformUnknownFeatureFlagError,
} from '@/lib/platform/errors';
import { featureFlagService } from '@/lib/services/featureFlagService';

/**
 * PER-ORG KILL-SWITCHES — design `platform-admin/design-notes.md` § AMENDMENT
 * 2026-10-03, `ops.switch.*` (MOTIR-750; the panel is MOTIR-752's).
 *
 * Transport only, the `./actions.ts` shape: resolve the principal (`superadmin`
 * to flip, `support` to read), call ONE service method, translate typed errors
 * into a discriminated result. The key registry, the reason, the lock and the
 * audit row live in `featureFlagService`.
 */

export type KillSwitchFailureCode =
  | 'REASON_REQUIRED'
  | 'UNKNOWN_KEY'
  | 'NOT_FOUND'
  | 'ALREADY_IN_STATE'
  | 'NOT_PERMITTED'
  | 'FAILED';

export type KillSwitchActionResult<T> =
  | { ok: true; result: T }
  | { ok: false; code: KillSwitchFailureCode };

function failure(
  orgId: string,
  verb: string,
  err: unknown,
): { ok: false; code: KillSwitchFailureCode } {
  if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
  if (err instanceof PlatformUnknownFeatureFlagError) return { ok: false, code: 'UNKNOWN_KEY' };
  if (err instanceof PlatformOrganizationNotFoundError) return { ok: false, code: 'NOT_FOUND' };
  if (err instanceof PlatformFeatureFlagStateError) return { ok: false, code: 'ALREADY_IN_STATE' };
  if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
  console.error('[admin] kill-switch %s failed for organization %s', verb, orgId, err);
  return { ok: false, code: 'FAILED' };
}

/** Turn one kill-switch off (`enabled: false`) or back on, with a reason. */
export async function setKillSwitchAction(
  orgId: string,
  input: { key: string; enabled: boolean; reason: string },
): Promise<KillSwitchActionResult<PlatformOrgFeatureFlagDTO>> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const result = await featureFlagService.setFlag(
      principal,
      orgId,
      input.key,
      input.enabled,
      input.reason,
    );
    // The org page's switch table and its audit trail are server-rendered.
    revalidatePath(`/admin/tenants/${orgId}`);
    return { ok: true, result };
  } catch (err) {
    return failure(orgId, 'flip', err);
  }
}

/** The switch table for one organization (every registry key). `support` and up. */
export async function loadKillSwitchesAction(
  orgId: string,
): Promise<KillSwitchActionResult<PlatformOrgFeatureFlagsDTO>> {
  try {
    const principal = await requirePlatformStaff('support');
    return { ok: true, result: await featureFlagService.listForOrganization(principal, orgId) };
  } catch (err) {
    return failure(orgId, 'read', err);
  }
}
