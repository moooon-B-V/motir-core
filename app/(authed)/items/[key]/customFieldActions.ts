'use server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { redirect } from 'next/navigation';
import { customFieldValuesService } from '@/lib/services/customFieldValuesService';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { customFieldValueErrorMessage } from '@/lib/customFields/valueErrorMessages';
import { CustomFieldValueError } from '@/lib/customFields/valueErrors';
import { workItemErrorMessage } from '@/lib/workItems/errorMessages';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { SetCustomFieldValueInput } from '@/lib/dto/customFieldValues';

// Server Action for the detail rail's custom-field editors (Story 5.3 ·
// Subtask 5.3.3) — the rail pattern: action → ONE service call →
// router.refresh() client-side on success. DEDICATED action, not a new field
// on `updateIssueAction`: custom values live in their own table behind their
// own per-type validation surface, so the seams stay clean (the card's
// explicit boundary). The 5.3.7 rail editors render the `error` string inline
// as their 422 state.

export type SetCustomFieldValueResult = { ok: true } | { ok: false; error: string };

export async function setCustomFieldValueAction(input: {
  workItemId: string;
  fieldId: string;
  value: SetCustomFieldValueInput;
}): Promise<SetCustomFieldValueResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');

  try {
    await customFieldValuesService.setValue(input.workItemId, input.fieldId, input.value, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return { ok: true };
  } catch (err) {
    const t = await getErrorsTranslator();
    if (err instanceof CustomFieldValueError) {
      return { ok: false, error: customFieldValueErrorMessage(err, t) };
    }
    if (err instanceof WorkItemNotFoundError) {
      return { ok: false, error: workItemErrorMessage(err, t) };
    }
    // The viewer / hidden-project gate — read-only actors get the quiet
    // permission line, never a crash (the rail hides editors anyway; this is
    // the forged-request backstop).
    if (err instanceof ProjectAccessDeniedError) {
      return { ok: false, error: t('customFields.READ_ONLY') };
    }
    throw err;
  }
}
