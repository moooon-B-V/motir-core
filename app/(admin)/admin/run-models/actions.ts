'use server';

import { revalidatePath } from 'next/cache';
import { HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  RunModelAlreadyListedError,
  RunModelInUseError,
  RunModelNotListedError,
  RunModelNotOfferedError,
  type RunModelProjectUse,
} from '@/lib/platform/errors';
import { platformRunModelService } from '@/lib/services/platformRunModelService';

/**
 * The HOSTED-RUN MODEL LIST writes — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-04 (Model lists) Panels 5–7 and 12, card MOTIR-7528.
 *
 * Transport only, the `ai-planning/actions.ts` shape: resolve the platform
 * principal, call ONE service method, and translate the typed errors into the
 * discriminated result the page maps to its copy. The gate is asserted here and
 * again in the service; a thrown error would reach the browser as a stripped
 * digest, so every refusal is a result.
 */

export type RunModelActionResult =
  | { ok: true }
  | {
      ok: false;
      code: 'IN_USE';
      projects: RunModelProjectUse[];
      platformLevels: RunModelProjectUse['levels'];
    }
  | {
      ok: false;
      code:
        | 'NOT_OFFERED'
        | 'ALREADY_LISTED'
        | 'NOT_LISTED'
        | 'UNAVAILABLE'
        | 'REASON_REQUIRED'
        | 'NOT_PERMITTED'
        | 'FAILED';
    };

export async function addRunModelAction(
  model: string,
  reason: string,
): Promise<RunModelActionResult> {
  return changeRunList('add', model, reason);
}

export async function removeRunModelAction(
  model: string,
  reason: string,
): Promise<RunModelActionResult> {
  return changeRunList('remove', model, reason);
}

async function changeRunList(
  action: 'add' | 'remove',
  model: string,
  reason: string,
): Promise<RunModelActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    if (action === 'add') await platformRunModelService.addModel(principal, model, reason);
    else await platformRunModelService.removeModel(principal, model, reason);
    // The rows and the addable set are server-rendered props.
    revalidatePath('/admin/run-models');
    return { ok: true };
  } catch (err) {
    if (err instanceof RunModelInUseError) {
      return {
        ok: false,
        code: 'IN_USE',
        projects: err.projects.map((p) => ({ ...p, levels: [...p.levels] })),
        platformLevels: [...err.platformLevels],
      };
    }
    if (err instanceof RunModelNotOfferedError) {
      // The offer moved since the page loaded; re-read it.
      revalidatePath('/admin/run-models');
      return { ok: false, code: 'NOT_OFFERED' };
    }
    if (err instanceof RunModelAlreadyListedError || err instanceof RunModelNotListedError) {
      revalidatePath('/admin/run-models');
      return {
        ok: false,
        code: err instanceof RunModelAlreadyListedError ? 'ALREADY_LISTED' : 'NOT_LISTED',
      };
    }
    if (err instanceof HostedModelsUnavailableError) return { ok: false, code: 'UNAVAILABLE' };
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin] run-model list action failed', { action, model }, err);
    return { ok: false, code: 'FAILED' };
  }
}
