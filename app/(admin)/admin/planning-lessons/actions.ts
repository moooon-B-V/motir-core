'use server';

import { revalidatePath } from 'next/cache';
import { MotirAiBadRequestError, MotirAiError, PlatformLessonNotFoundError } from '@/lib/ai/errors';
import type { PlatformLessonEditInput } from '@/lib/dto/platformLessons';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformLessonInvalidError,
  PlatformLessonUnchangedError,
} from '@/lib/platform/errors';
import { platformLessonsService } from '@/lib/services/platformLessonsService';

/**
 * The PLANNING-LESSON curate writes — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-02 (Planning lessons) Panels 6–9, card MOTIR-1411.
 *
 * Transport only, the `ai-planning/actions.ts` shape: resolve the platform
 * principal, call ONE service method, translate the typed errors into the
 * discriminated result the page maps to its toasts. Who may do what, the reason
 * rule and the audit row live in `platformLessonsService`.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders, so it resolves the principal itself.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production, and the page draws a different answer for each refusal.
 */

export type LessonActionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'GONE'
        | 'UNCHANGED'
        | 'UNAVAILABLE'
        | 'REASON_REQUIRED'
        | 'NOT_PERMITTED'
        | 'INVALID'
        | 'FAILED';
    };

function refused(err: unknown, lessonId: string, act: string): LessonActionResult {
  if (err instanceof PlatformLessonNotFoundError) {
    revalidatePath('/admin/planning-lessons');
    return { ok: false, code: 'GONE' };
  }
  if (err instanceof PlatformLessonUnchangedError) {
    // The page re-reads, so the control shows where the lesson (or the window)
    // actually is.
    revalidatePath(`/admin/planning-lessons/${lessonId}`);
    revalidatePath('/admin/planning-lessons');
    return { ok: false, code: 'UNCHANGED' };
  }
  if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
  if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
  if (err instanceof PlatformLessonInvalidError) return { ok: false, code: 'INVALID' };
  if (err instanceof MotirAiError) {
    console.error(`[admin] lesson ${act} could not reach motir-ai`, { lessonId }, err);
    return { ok: false, code: err instanceof MotirAiBadRequestError ? 'INVALID' : 'UNAVAILABLE' };
  }
  console.error(`[admin] lesson ${act} failed`, { lessonId }, err);
  return { ok: false, code: 'FAILED' };
}

function saved(lessonId: string): LessonActionResult {
  // The detail and the list are server-rendered props: the re-read is what shows
  // the new state and heads "Changes by staff" with this row.
  revalidatePath(`/admin/planning-lessons/${lessonId}`);
  revalidatePath('/admin/planning-lessons');
  return { ok: true };
}

export async function setLessonEnabledAction(
  lessonId: string,
  enabled: boolean,
  reason: string,
): Promise<LessonActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    await platformLessonsService.setEnabled(principal, lessonId, enabled, reason);
    return saved(lessonId);
  } catch (err) {
    return refused(err, lessonId, enabled ? 'enable' : 'disable');
  }
}

export async function editLessonAction(
  lessonId: string,
  input: PlatformLessonEditInput,
  reason: string,
): Promise<LessonActionResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    await platformLessonsService.edit(principal, lessonId, input, reason);
    return saved(lessonId);
  } catch (err) {
    return refused(err, lessonId, 'edit');
  }
}

export async function promoteLessonAction(
  lessonId: string,
  to: 'global' | 'planning_craft',
  reason: string,
): Promise<LessonActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    await platformLessonsService.promote(principal, lessonId, to, reason);
    return saved(lessonId);
  } catch (err) {
    return refused(err, lessonId, 'promote');
  }
}

export async function setLessonRetentionAction(
  days: number,
  reason: string,
): Promise<LessonActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    await platformLessonsService.setRetention(principal, days, reason);
    revalidatePath('/admin/planning-lessons');
    return { ok: true };
  } catch (err) {
    return refused(err, 'lesson-retention', 'retention change');
  }
}

/** The confirm's impact count; `null` when it cannot be read — the confirm still works. */
export async function previewLessonRetentionAction(days: number): Promise<number | null> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    return await platformLessonsService.previewRetention(principal, days);
  } catch (err) {
    if (!(err instanceof PlatformLessonInvalidError)) {
      console.error('[admin] lesson-retention impact could not be read', { days }, err);
    }
    return null;
  }
}
