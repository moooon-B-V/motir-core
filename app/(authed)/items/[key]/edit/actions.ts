'use server';

import { redirect } from 'next/navigation';
import { getErrorsTranslator, getServerTranslator } from '@/lib/i18n/errorsTranslator';
import { foldersService } from '@/lib/services/foldersService';
import { CrossProjectFolderError, FolderNotFoundError } from '@/lib/folders/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemErrorMessage } from '@/lib/workItems/errorMessages';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import type { ApprovalGatePendingPayloadDTO } from '@/lib/dto/approvalGate';
import {
  ApprovalGatePendingError,
  IllegalParentTypeError,
  IllegalTransitionError,
  StaleWorkItemError,
  UnknownStatusError,
  WorkItemError,
} from '@/lib/workItems/errors';
import type {
  ExecutorDto,
  WorkItemDifficultyDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
  WorkItemExplanationSourceDto,
  WorkItemPlacementDto,
} from '@/lib/dto/workItems';
import { unmappedActionRefusalMessage } from '@/lib/actions/unmappedRefusal';

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
  // DIFFICULTY (Story MOTIR-6016) — set / change / clear from the rail. Leaf-only
  // is the service's rule (DIFFICULTY_NOT_ALLOWED_ON_KIND), surfaced below.
  difficulty?: WorkItemDifficultyDto | null;
}

export type IssueActionResult =
  | { ok: true; updatedAt: string }
  | {
      ok: false;
      error: string;
      field?: 'parent' | 'status';
      stale?: boolean;
      /** Set ONLY for an approval-gate refusal (MOTIR-5526): the status control
       *  renders it in place, with a door into the approval, from `gate`. */
      code?: 'APPROVAL_GATE_PENDING';
      gate?: ApprovalGatePendingPayloadDTO;
    };

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
        difficulty: input.difficulty,
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
    const refused = await unmappedActionRefusalMessage(err, 'updateIssueAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }
}

/**
 * File a work item into a folder, or take it out of one, from the quick view's
 * Folder field (Story MOTIR-5308 · MOTIR-5316). Transport only: the placement
 * rules — filing clears a work-item parent, a subtask may not land at the root —
 * are `fileWorkItem`'s. Answers in the rail's own result shape, and the success
 * arm carries the row's new `updatedAt` so the rail's NEXT edit submits a fresh
 * token (MOTIR-5352).
 */
export async function fileWorkItemAction(input: {
  workItemId: string;
  folderId: string | null;
}): Promise<IssueActionResult> {
  const ctx = await requireContext();
  try {
    const result = await foldersService.fileWorkItem(
      input.workItemId,
      { folderId: input.folderId ?? null },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, updatedAt: result.updatedAt };
  } catch (err) {
    if (err instanceof FolderNotFoundError || err instanceof CrossProjectFolderError) {
      const tf = await getServerTranslator('folders');
      return { ok: false, error: tf('fileRefused') };
    }
    if (err instanceof ProjectAccessDeniedError) {
      const ta = await getServerTranslator('projectAccess');
      return { ok: false, error: ta('readOnlyHint') };
    }
    if (err instanceof WorkItemError) {
      const t = await getErrorsTranslator();
      return { ok: false, error: workItemErrorMessage(err, t) };
    }
    const refused = await unmappedActionRefusalMessage(err, 'fileWorkItemAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }
}

export type WorkItemPlacementActionResult =
  | { ok: true; placement: WorkItemPlacementDto }
  | { ok: false; error: string };

/**
 * Where a work item sits NOW (Story MOTIR-5309 · MOTIR-5381) — the item page's
 * placement channel asks this after the rail's Parent or Folder field moved the
 * item. Transport only over `workItemsService.getWorkItemPlacement`: the same
 * mapper the page's first render reads, the same browse gate, and the same
 * not-found for an item in another project or workspace. A refusal is a result,
 * never a throw — the channel keeps its last value.
 */
export async function getWorkItemPlacementAction(
  workItemId: string,
): Promise<WorkItemPlacementActionResult> {
  const ctx = await requireContext();
  try {
    const placement = await workItemsService.getWorkItemPlacement(ctx.projectId, workItemId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return { ok: true, placement };
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError) {
      const ta = await getServerTranslator('projectAccess');
      return { ok: false, error: ta('readOnlyHint') };
    }
    if (err instanceof WorkItemError) {
      const t = await getErrorsTranslator();
      return { ok: false, error: workItemErrorMessage(err, t) };
    }
    const refused = await unmappedActionRefusalMessage(err, 'getWorkItemPlacementAction');
    if (refused) return { ok: false, error: refused };
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
    // A pending approval owns the target status (MOTIR-5526) — carried with its
    // code and the render payload, so every surface committing through this
    // action can say so on the status control. Every other failure keeps
    // `{ ok: false, error }`.
    if (err instanceof ApprovalGatePendingError) {
      return {
        ok: false,
        error: workItemErrorMessage(err, t),
        field: 'status',
        code: 'APPROVAL_GATE_PENDING',
        gate: await approvalGatesService.describePendingRefusal(err, {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        }),
      };
    }
    if (err instanceof IllegalTransitionError || err instanceof UnknownStatusError)
      return { ok: false, error: workItemErrorMessage(err, t), field: 'status' };
    if (err instanceof WorkItemError) return { ok: false, error: workItemErrorMessage(err, t) };
    const refused = await unmappedActionRefusalMessage(err, 'changeStatusAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }
}
