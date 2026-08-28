'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  EmptyTodoTextError,
  TodoCommandTooLongError,
  TodoReorderConflictError,
  TodoTextTooLongError,
  WorkItemTodoNotFoundError,
} from '@/lib/workItemTodos/errors';
import type { ExecutorDto } from '@/lib/dto/workItems';
import type { TodoProgressDto, WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// Server Actions for the work item page's To-do list section (Story
// MOTIR-3808 · MOTIR-3814). Thin transports over `workItemTodosService` (the
// MOTIR-3813 business-logic core): ONE service call each, typed store errors
// translated to user-facing copy from the `workItemTodos` catalog namespace.
// The section is a client island that owns its loaded list, so each action
// returns the written DTO for an in-place update; `revalidatePath` keeps the
// server-rendered page fresh for the next navigation. This is
// `commentActions.ts`'s contract, unchanged — the house pattern for a per-item
// collection edited in place on the detail page.
//
// ⚠️ THE PERMISSION IS RE-CHECKED SERVER-SIDE ON EVERY ACTION, and it is the
// SERVICE that checks it (`work_item:edit`, per the ADR's §4 — one key for add,
// edit, reorder, tick and delete alike). A Server Action is a public HTTP
// endpoint: the section hiding a control from a viewer is a rendering decision,
// and a hidden control is not an authorization. Nothing here introduces a
// `todo:*` key — the page already resolves `work_item:edit` in the permission
// set it reads, and a second vocabulary for one permission is how the two drift.
//
// ⚠️ AND NOTHING HERE MOVES THE CARD'S STATUS. Ticking the last to-do returns
// `progress: { done: n, total: n }` and nothing else happens (ADR §3).

const ISSUES_PATH = '/items';

export type TodoActionResult =
  | { ok: true; todo: WorkItemTodoDto; progress: TodoProgressDto }
  | { ok: false; error: string };

export type DeleteTodoActionResult =
  | { ok: true; progress: TodoProgressDto }
  | { ok: false; error: string };

/**
 * Translate a typed store error to user-facing copy, or return `null` for
 * anything this layer does not recognise — which the callers RETHROW rather
 * than flatten into a generic message. An unrecognised error is a bug, and a
 * bug that returns `{ ok: false, error: 'Something went wrong' }` is a bug
 * nobody will ever see reported.
 */
async function todoErrorMessage(err: unknown): Promise<string | null> {
  const t = await getTranslations('workItemTodos');
  if (
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError ||
    err instanceof WorkItemTodoNotFoundError
  ) {
    return t('errors.notFound');
  }
  // A read-only actor. The service throws the work item's own edit denial —
  // this layer names it in to-do terms without inventing a permission for it.
  if (err instanceof ProjectAccessDeniedError) return t('errors.forbidden');
  if (err instanceof EmptyTodoTextError) return t('errors.empty');
  // The cap is a granularity bar, so its message asks for a SPLIT rather than
  // for brevity — the error carries the number, and the copy carries the point.
  if (err instanceof TodoTextTooLongError) return t('errors.textTooLong', { limit: err.limit });
  if (err instanceof TodoCommandTooLongError) {
    return t('errors.commandTooLong', { limit: err.limit });
  }
  if (err instanceof TodoReorderConflictError) return t('errors.reorderConflict');
  return null;
}

async function genericError(): Promise<string> {
  return (await getTranslations('workItemTodos'))('errors.generic');
}

export async function addTodoAction(input: {
  workItemId: string;
  text: string;
  commandText?: string | null;
  executor?: ExecutorDto | null;
}): Promise<TodoActionResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: await genericError() };
  try {
    const { todo, progress } = await workItemTodosService.addTodo(
      input.workItemId,
      { text: input.text, commandText: input.commandText, executor: input.executor },
      ctx,
    );
    revalidatePath(ISSUES_PATH);
    return { ok: true, todo, progress };
  } catch (err) {
    const message = await todoErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export async function updateTodoAction(input: {
  todoId: string;
  text?: string;
  commandText?: string | null;
  executor?: ExecutorDto | null;
}): Promise<TodoActionResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: await genericError() };
  try {
    // The patch is SPARSE end to end: a key the caller omitted is omitted here
    // too, so editing the text cannot blank a command the user did not touch.
    const patch: { text?: string; commandText?: string | null; executor?: ExecutorDto | null } = {};
    if (input.text !== undefined) patch.text = input.text;
    if (input.commandText !== undefined) patch.commandText = input.commandText;
    if (input.executor !== undefined) patch.executor = input.executor;

    const { todo, progress } = await workItemTodosService.updateTodo(input.todoId, patch, ctx);
    revalidatePath(ISSUES_PATH);
    return { ok: true, todo, progress };
  } catch (err) {
    const message = await todoErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export async function moveTodoAction(input: {
  todoId: string;
  toIndex: number;
}): Promise<TodoActionResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: await genericError() };
  try {
    const { todo, progress } = await workItemTodosService.moveTodo(
      input.todoId,
      input.toIndex,
      ctx,
    );
    revalidatePath(ISSUES_PATH);
    return { ok: true, todo, progress };
  } catch (err) {
    const message = await todoErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export async function setTodoDoneAction(input: {
  todoId: string;
  done: boolean;
}): Promise<TodoActionResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: await genericError() };
  try {
    const { todo, progress } = await workItemTodosService.setTodoDone(
      input.todoId,
      input.done,
      ctx,
    );
    revalidatePath(ISSUES_PATH);
    return { ok: true, todo, progress };
  } catch (err) {
    const message = await todoErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export async function deleteTodoAction(input: { todoId: string }): Promise<DeleteTodoActionResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: await genericError() };
  try {
    const progress = await workItemTodosService.deleteTodo(input.todoId, ctx);
    revalidatePath(ISSUES_PATH);
    return { ok: true, progress };
  } catch (err) {
    const message = await todoErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}
