'use server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { redirect } from 'next/navigation';
import { labelsService } from '@/lib/services/labelsService';
import { componentsService } from '@/lib/services/componentsService';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { isLabelError, labelErrorMessage } from '@/lib/labels/errorMessages';
import { isComponentError, componentErrorMessage } from '@/lib/components/errorMessages';
import { workItemErrorMessage } from '@/lib/workItems/errorMessages';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { LabelDto } from '@/lib/dto/labels';
import type { ComponentDto } from '@/lib/dto/components';

// Server Actions for the detail rail's Labels / Components cards (Story 5.4 ·
// Subtask 5.4.8). One service call each; the success branch returns the
// resulting set — the cards confirm from THIS response and re-render their
// chips locally, with NO `router.refresh()` on success (the inline-edit rule:
// the refresh fan-out is what caused the status-revert bug; the response is
// the authority). A typed 422 comes back as the translated `error` string the
// card renders inline (the mock's field-err grammar).

export type LabelsActionResult = { ok: true; labels: LabelDto[] } | { ok: false; error: string };

export type ComponentsActionResult =
  | { ok: true; components: ComponentDto[] }
  | { ok: false; error: string };

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

async function labelFailure(err: unknown, typedName: string): Promise<LabelsActionResult> {
  const t = await getErrorsTranslator();
  if (isLabelError(err)) return { ok: false, error: labelErrorMessage(err, t, typedName) };
  if (err instanceof WorkItemNotFoundError) {
    return { ok: false, error: workItemErrorMessage(err, t) };
  }
  // The forged-request backstop — read-only actors get the quiet permission
  // line (the card renders read-only chips anyway).
  if (err instanceof ProjectAccessDeniedError) return { ok: false, error: t('labels.READ_ONLY') };
  throw err;
}

export async function addLabelAction(input: {
  workItemId: string;
  name: string;
}): Promise<LabelsActionResult> {
  const ctx = await requireContext();
  try {
    const labels = await labelsService.addLabel(input.workItemId, input.name, ctx);
    return { ok: true, labels };
  } catch (err) {
    return labelFailure(err, input.name);
  }
}

export async function removeLabelAction(input: {
  workItemId: string;
  labelId: string;
}): Promise<LabelsActionResult> {
  const ctx = await requireContext();
  try {
    const labels = await labelsService.removeLabel(input.workItemId, input.labelId, ctx);
    return { ok: true, labels };
  } catch (err) {
    return labelFailure(err, '');
  }
}

async function componentFailure(err: unknown): Promise<ComponentsActionResult> {
  const t = await getErrorsTranslator();
  if (isComponentError(err)) return { ok: false, error: componentErrorMessage(err, t) };
  if (err instanceof WorkItemNotFoundError) {
    return { ok: false, error: workItemErrorMessage(err, t) };
  }
  if (err instanceof ProjectAccessDeniedError) {
    return { ok: false, error: t('components.READ_ONLY') };
  }
  throw err;
}

export async function addComponentAction(input: {
  workItemId: string;
  componentId: string;
}): Promise<ComponentsActionResult> {
  const ctx = await requireContext();
  try {
    const components = await componentsService.addComponent(
      input.workItemId,
      input.componentId,
      ctx,
    );
    return { ok: true, components };
  } catch (err) {
    return componentFailure(err);
  }
}

export async function removeComponentAction(input: {
  workItemId: string;
  componentId: string;
}): Promise<ComponentsActionResult> {
  const ctx = await requireContext();
  try {
    const components = await componentsService.removeComponent(
      input.workItemId,
      input.componentId,
      ctx,
    );
    return { ok: true, components };
  } catch (err) {
    return componentFailure(err);
  }
}
