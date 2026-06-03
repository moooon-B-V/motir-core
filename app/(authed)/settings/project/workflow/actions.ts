'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workflowsService } from '@/lib/services/workflowsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CannotDeleteInitialStatusError,
  CannotDeleteLastTerminalStatusError,
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

/** Map a known workflow/management error to a friendly message, or rethrow. */
function toMessage(err: unknown): string {
  if (err instanceof NotProjectAdminError) return 'Only a project admin can edit the workflow.';
  if (err instanceof ProjectNotFoundError) return 'That project no longer exists.';
  if (err instanceof StatusKeyConflictError) return err.message;
  if (err instanceof WorkflowStatusNotFoundError) return 'That status no longer exists.';
  if (err instanceof WorkflowTransitionNotFoundError) return 'That transition no longer exists.';
  if (err instanceof StatusInUseError) return err.message;
  if (err instanceof CannotDeleteInitialStatusError) return err.message;
  if (err instanceof CannotDeleteLastTerminalStatusError) return err.message;
  throw err;
}

async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
  } catch (err) {
    return { ok: false, error: toMessage(err) };
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
  if (!key || !label) return { ok: false, error: 'Key and label are required.' };
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

export async function deleteStatusAction(statusId: string): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  return run(() =>
    workflowsService.deleteStatus({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      statusId,
    }),
  );
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

export async function restoreDefaultsAction(): Promise<ActionResult> {
  const ctx = await requireProjectContext();
  return run(() => workflowsService.restoreDefaultWorkflow(ctx));
}
