'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workflowsService } from '@/lib/services/workflowsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CannotDeleteInitialStatusError,
  CannotDeleteLastTerminalStatusError,
  InvalidReassignTargetError,
  NotProjectAdminError,
  StatusInUseError,
  StatusKeyConflictError,
  WorkflowStatusNotFoundError,
  WorkflowTransitionNotFoundError,
} from '@/lib/workflows/errors';
import type { StatusCategoryDto, WorkflowPolicyModeDto } from '@/lib/dto/workflows';

// Server Actions for the workflow-management settings page (Subtask 2.2.5).
// Transport only: resolve session + active project, call ONE service method,
// translate the typed error into a UI-friendly result. The service owns the
// transaction, RLS context, and the project-admin gate (so a non-owner POSTing
// these directly still fails server-side). On success the page revalidates so
// the optimistic UI reconciles against the server's source of truth.

const WORKFLOW_PATH = '/settings/project/workflow';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

async function requireProjectContext(): Promise<{
  userId: string;
  workspaceId: string;
  projectId: string;
}> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');
  return { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: ctx.projectId };
}

// A minimal translator shape (satisfied by `getTranslations('errors')`).
type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

/** Map a known workflow/management error to a translated message, or rethrow. */
function toMessage(err: unknown, t: ErrorTranslator): string {
  if (err instanceof NotProjectAdminError) return t('workflow.NOT_PROJECT_ADMIN');
  if (err instanceof ProjectNotFoundError) return t('actions.projectGone');
  if (err instanceof StatusKeyConflictError)
    return t('workflow.STATUS_KEY_CONFLICT', { key: err.key });
  if (err instanceof WorkflowStatusNotFoundError) return t('workflow.WORKFLOW_STATUS_NOT_FOUND');
  if (err instanceof WorkflowTransitionNotFoundError)
    return t('workflow.WORKFLOW_TRANSITION_NOT_FOUND');
  if (err instanceof StatusInUseError)
    return t('workflow.STATUS_IN_USE', { statusKey: err.statusKey, count: err.count });
  if (err instanceof InvalidReassignTargetError) return t('workflow.INVALID_REASSIGN_TARGET');
  if (err instanceof CannotDeleteInitialStatusError)
    return t('workflow.CANNOT_DELETE_INITIAL_STATUS', { statusKey: err.statusKey });
  if (err instanceof CannotDeleteLastTerminalStatusError)
    return t('workflow.CANNOT_DELETE_LAST_TERMINAL_STATUS', { statusKey: err.statusKey });
  throw err;
}

async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
  } catch (err) {
    return { ok: false, error: toMessage(err, await getTranslations('errors')) };
  }
  revalidatePath(WORKFLOW_PATH);
  return { ok: true };
}

export async function createStatusAction(input: {
  key: string;
  label: string;
  category: StatusCategoryDto;
  color?: string | null;
}): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  const key = input.key.trim();
  const label = input.label.trim();
  if (!key || !label)
    return { ok: false, error: (await getTranslations('errors'))('actions.keyLabelRequired') };
  return run(() =>
    workflowsService.createStatus({
      ...ctx,
      key,
      label,
      category: input.category,
      color: input.color ?? null,
    }),
  );
}

export async function updateStatusAction(input: {
  statusId: string;
  label?: string;
  category?: StatusCategoryDto;
  color?: string | null;
  isInitial?: boolean;
}): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  return run(() =>
    workflowsService.updateStatus({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      statusId: input.statusId,
      label: input.label?.trim(),
      category: input.category,
      color: input.color,
      isInitial: input.isInitial,
    }),
  );
}

export async function reorderStatusAction(input: {
  statusId: string;
  position: string;
}): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  return run(() =>
    workflowsService.updateStatus({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      statusId: input.statusId,
      position: input.position,
    }),
  );
}

/** Delete result. On an in-use status with no target, `statusInUse` carries the
 * count so the client can open the delete-with-reassign modal (Subtask 2.3.1). */
export interface DeleteStatusResult extends ActionResult {
  statusInUse?: { count: number };
}

/**
 * Delete a status. Pass `reassignToStatusId` to migrate referencing work items
 * to another status first (delete-with-reassign). Without it, an in-use status
 * returns `{ ok: false, statusInUse: { count } }` instead of a toast-only error,
 * so the editor can re-prompt with the reassign picker.
 */
export async function deleteStatusAction(
  statusId: string,
  reassignToStatusId?: string,
): Promise<DeleteStatusResult> {
  const ctx = await requireProjectContext();
  try {
    await workflowsService.deleteStatus({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      statusId,
      reassignToStatusId,
    });
  } catch (err) {
    const t = await getTranslations('errors');
    if (err instanceof StatusInUseError) {
      return {
        ok: false,
        statusInUse: { count: err.count },
        error: t('workflow.STATUS_IN_USE', { statusKey: err.statusKey, count: err.count }),
      };
    }
    return { ok: false, error: toMessage(err, t) };
  }
  revalidatePath(WORKFLOW_PATH);
  return { ok: true };
}

export async function addTransitionAction(input: {
  fromStatusId: string;
  toStatusId: string;
}): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  return run(() =>
    workflowsService.addTransition({
      ...ctx,
      fromStatusId: input.fromStatusId,
      toStatusId: input.toStatusId,
    }),
  );
}

export async function removeTransitionAction(transitionId: string): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  return run(() =>
    workflowsService.removeTransition({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      transitionId,
    }),
  );
}

export async function setPolicyModeAction(mode: WorkflowPolicyModeDto): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  return run(() => workflowsService.setPolicyMode({ ...ctx, mode }));
}

export async function restoreDefaultTransitionsAction(): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  return run(() => workflowsService.restoreDefaultTransitions(ctx));
}
