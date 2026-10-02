'use server';

import { revalidatePath } from 'next/cache';
import {
  MotirAiUnavailableError,
  PlannerModelNotOfferedError,
  PlannerModelUnreachableError,
} from '@/lib/ai/errors';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlannerAudienceUnknownError,
  PlannerModelUnchangedError,
} from '@/lib/platform/errors';
import { platformPlannerModelService } from '@/lib/services/platformPlannerModelService';

/**
 * The PLANNING-MODEL write — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10 (AI planning), card MOTIR-7231.
 *
 * Transport only, the `tenants/[orgId]/actions.ts` shape: resolve the platform
 * principal, call ONE service method, translate the typed errors into the
 * discriminated result the rows map to their copy. Who may do this, the reason
 * rule, the from → to audit row and its ordering live in
 * `platformPlannerModelService.setModel`.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders, so it resolves the principal itself;
 * the service asserts `superadmin` once more. Hiding the picker from an
 * `operator` is presentation; this is the rule.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production, and the page draws a different state for each refusal.
 */

export type PlannerModelActionResult =
  | { ok: true }
  | { ok: false; code: 'NOT_OFFERED' }
  | { ok: false; code: 'UNREACHABLE'; reason: string }
  | {
      ok: false;
      code: 'UNCHANGED' | 'UNAVAILABLE' | 'REASON_REQUIRED' | 'NOT_PERMITTED' | 'FAILED';
    };

export async function setPlannerModelAction(
  audience: string,
  model: string,
  reason: string,
): Promise<PlannerModelActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    await platformPlannerModelService.setModel(principal, audience, model, reason);
    // The rows are server-rendered props: the re-read is what shows the new
    // model and its last-changed line (`CLAUDE.md`'s page-state contract).
    revalidatePath('/admin/ai-planning');
    return { ok: true };
  } catch (err) {
    if (err instanceof PlannerModelNotOfferedError) {
      // The offered list moved since the page loaded; the island re-reads it.
      revalidatePath('/admin/ai-planning');
      return { ok: false, code: 'NOT_OFFERED' };
    }
    if (err instanceof PlannerModelUnreachableError) {
      return { ok: false, code: 'UNREACHABLE', reason: err.reason };
    }
    if (err instanceof PlannerModelUnchangedError) return { ok: false, code: 'UNCHANGED' };
    if (err instanceof MotirAiUnavailableError) return { ok: false, code: 'UNAVAILABLE' };
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    if (err instanceof PlannerAudienceUnknownError) {
      console.error(`[admin] planner-model action got an unknown audience "${audience}"`);
      return { ok: false, code: 'FAILED' };
    }
    console.error(`[admin] planner-model action failed for the ${audience} audience`, err);
    return { ok: false, code: 'FAILED' };
  }
}
