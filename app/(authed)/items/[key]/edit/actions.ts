'use server';

import { redirect } from 'next/navigation';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemErrorMessage } from '@/lib/workItems/errorMessages';
import {
  IllegalParentTypeError,
  IllegalTransitionError,
  StaleWorkItemError,
  UnknownStatusError,
  WorkItemError,
} from '@/lib/workItems/errors';
import type {
  ExecutorDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
  WorkItemExplanationSourceDto,
} from '@/lib/dto/workItems';

// Server Actions for the issue edit form (Subtask 2.3.6). Two DISTINCT paths —
// the whole point of closing finding #46: non-status fields go through
// `updateWorkItem` (status is no longer a patch field), status goes through the
// gated `updateStatus` (2.2.4). Both resolve the active project server-side and
// trust `updateWorkItem`/`updateStatus`'s workspace gating; the edit form
// submits the `updatedAt` it read for optimistic-concurrency.
//
// Neither action revalidates a path. The returned `updatedAt` IS the
// confirmation — callers mark their optimistic value confirmed and move on
// (bug-inline-status-revert-on-second-edit). A `revalidatePath('/items')`
// here made every field update's action response carry a whole-page RSC
// repaint, so two quick inline edits raced multiple full-tree snapshots and a
// stale one could apply last, reverting an unrelated row's display. Surfaces
// that need a re-read after a STALE conflict call `router.refresh()`
// themselves; navigations re-render fresh anyway (dynamic route).

export interface UpdateIssueInput {
  id: string;
  // Optimistic-concurrency token the edit form reads and submits. OPTIONAL so a
  // caller without a freshly-read `updatedAt` can reuse this same field-update
  // path — the board's cross-lane drag-reassign (Subtask 3.3.5) does this: a
  // `BoardCardDto` carries no `updatedAt`, and a board drop is last-write-wins
  // (mirror-faithful — Jira board drags don't concurrency-check). When omitted,
  // `updateWorkItem` skips the stale check (it already treats it as optional).
  expectedUpdatedAt?: string;
  kind?: WorkItemKindDto;
  title?: string;
  descriptionMd?: string | null;
  // The "why this matters" axis. Editing it here routes through updateWorkItem's
  // explanationSource state machine (editing an ai_draft auto-flips it to
  // user_edited; a user_authored one stays user_authored).
  explanationMd?: string | null;
  // Explanation provenance (Subtask 8.8.12). The edit form sends `ai_draft` for
  // an untouched fresh AI draft and `user_edited` once the user edits a draft;
  // it omits the field when the explanation was hand-typed or untouched, so the
  // service's auto-flip rule applies. Explicit values win over the auto-flip.
  explanationSource?: WorkItemExplanationSourceDto;
  parentId?: string | null;
  assigneeId?: string | null;
  priority?: WorkItemPriorityDto;
  dueDate?: string | null;
  estimateMinutes?: number | null;
  // Work-item TYPE + EXECUTOR (Story 2.7). The detail-rail inline picker
  // (2.7.4) sends `type` (seeding `executor` when none is set yet) or
  // `executor` alone (an override). `updateWorkItem` owns the leaf-only +
  // seed-if-absent rules (2.7.3); a `type`/`executor` on a non-leaf kind is
  // rejected there with a typed error the catch below surfaces.
  type?: WorkItemTypeDto | null;
  executor?: ExecutorDto | null;
}

export type IssueActionResult =
  | { ok: true; updatedAt: string }
  | { ok: false; error: string; field?: 'parent' | 'status'; stale?: boolean };

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');
  return ctx;
}

export async function updateIssueAction(input: UpdateIssueInput): Promise<IssueActionResult> {
  const ctx = await requireContext();
  try {
    // Workspace gate: getWorkItem 404s a cross-workspace id before any write
    // (updateWorkItem itself doesn't re-check the tenant).
    await workItemsService.getWorkItem(input.id, ctx);
    const updated = await workItemsService.updateWorkItem(
      input.id,
      {
        kind: input.kind,
        title: input.title,
        descriptionMd: input.descriptionMd,
        explanationMd: input.explanationMd,
        explanationSource: input.explanationSource,
        parentId: input.parentId,
        assigneeId: input.assigneeId,
        priority: input.priority,
        dueDate: input.dueDate,
        estimateMinutes: input.estimateMinutes,
        type: input.type,
        executor: input.executor,
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { expectedUpdatedAt: input.expectedUpdatedAt },
    );
    return { ok: true, updatedAt: updated.updatedAt };
  } catch (err) {
    const t = await getErrorsTranslator();
    if (err instanceof StaleWorkItemError)
      return { ok: false, error: workItemErrorMessage(err, t), stale: true };
    if (err instanceof IllegalParentTypeError)
      return { ok: false, error: workItemErrorMessage(err, t), field: 'parent' };
    if (err instanceof WorkItemError) return { ok: false, error: workItemErrorMessage(err, t) };
    throw err;
  }
}

export async function changeStatusAction(input: {
  id: string;
  toStatusKey: string;
}): Promise<IssueActionResult> {
  const ctx = await requireContext();
  try {
    const updated = await workItemsService.updateStatus(input.id, input.toStatusKey, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return { ok: true, updatedAt: updated.updatedAt };
  } catch (err) {
    const t = await getErrorsTranslator();
    if (err instanceof IllegalTransitionError || err instanceof UnknownStatusError)
      return { ok: false, error: workItemErrorMessage(err, t), field: 'status' };
    if (err instanceof WorkItemError) return { ok: false, error: workItemErrorMessage(err, t) };
    throw err;
  }
}
