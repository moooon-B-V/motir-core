import { Prisma, type WorkItem, type WorkItemTodo } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemTodoRepository } from '@/lib/repositories/workItemTodoRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { toWorkItemTodoDto, toWorkItemTodoListDto } from '@/lib/mappers/workItemTodoMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { keyBetweenSafe, keyForAppend } from '@/lib/workItems/positioning';
import {
  TODO_COMMAND_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_TEXT_MAX_LENGTH,
} from '@/lib/workItemTodos/limits';
import {
  EmptyTodoTextError,
  TodoCommandTooLongError,
  TodoNotesTooLongError,
  TodoReorderConflictError,
  TodoTextTooLongError,
  WorkItemTodoNotFoundError,
} from '@/lib/workItemTodos/errors';
import type { ExecutorDto } from '@/lib/dto/workItems';
import type {
  TodoProgressDto,
  WorkItemTodoDto,
  WorkItemTodoListDto,
} from '@/lib/dto/workItemTodos';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Work-item to-do service (Story MOTIR-3808 · Subtask MOTIR-3813) — the
// business logic over the MOTIR-3813 repository, built to
// `docs/decisions/work-item-todo-list.md`. Owns the transactions, the
// `work_item:edit` gate, the granularity bar, the fractional-index arithmetic,
// the revision split and the DTO mapping. No route and no Server Action lives
// here — those are MOTIR-3814 (CLAUDE.md's 4-layer contract).
//
// ── THE THREE CONTRACTS THIS FILE EXISTS TO HOLD ──────────────────────────
//
// 1. EVERY WRITE IS `work_item:edit` ON THE PARENT CARD (ADR §4). Add, edit,
//    reorder, tick and delete alike — one key, no split. Ticking changes the
//    item's content, and the shipped permission model is explicit that reading
//    and watching are not editing while writing is.
//
// 2. A TICK STAMPS THE ROW AND WRITES NO REVISION; add / edit / reorder /
//    delete each write one (ADR §4). Add, edit, reorder and delete are
//    STRUCTURAL — they change what the work IS, which is what a revision trail
//    is for. A tick is PROGRESS, and it is the one act that happens six times
//    on a six-step list. A revision per tick turns a short checklist into a
//    wall of history the reader must scroll past to find the edit that
//    mattered, and it degrades the trail for every other consumer of
//    `work_item_revision`.
//
// 3. NOTHING HERE TOUCHES `work_item.status` (ADR §3). Ticking the last to-do
//    does NOT move the card, and neither does anything else in this file. That
//    is not an omission to fill in later: Motir already has two authorities
//    over that column — `childStatusCascadeService`'s rollup and the delivery
//    completion gate — and a checkbox anyone can click would be a third with no
//    defer arm. MOTIR-3229 is what a disagreement between two of them cost. The
//    all-done STATE is rendered; it is not written.
//
// ⚠️ THE REVISION IS WRITTEN INSIDE THE TRANSACTION, and this is where this
// file departs from MOTIR-3813's own body, which asked for it "after the DB
// write commits … must not roll back or fail the to-do write". That is not
// implementable against the shipped API and would break a documented contract:
// `workItemRevisionsService.recordRevision` takes a REQUIRED
// `Prisma.TransactionClient` — the parameter IS the contract, per its own
// header — and all ~20 call sites in `lib/services/**` are inside a
// transaction. Its stated reason is that "the audit trail can never silently
// diverge from the data", enforced by
// `tests/integration/work-items/revisions.test.ts`. The card generalised
// CLAUDE.md's side-effects-outside-the-transaction rule, which is about
// NOTIFICATIONS (`sendEvent`, email) — things that must not fire for a write
// that rolled back — onto an audit row, which is the opposite case: it must not
// SURVIVE a write that rolled back. Amended on the record; planning bug filed.

/**
 * Take the SERIALIZATION LOCK for one card's to-do list, inside the caller's
 * transaction.
 *
 * ⚠️ THE LOCK IS ON THE PARENT CARD'S ROW, NOT ON THE TO-DO ROWS, AND THAT IS
 * THE WHOLE POINT. Both position-minting writes here are read-derived: an
 * append reads the current last key and mints after it, a move reads two
 * neighbours and mints between them. The obvious lock — `SELECT … FOR UPDATE`
 * over the card's to-do rows — is correct for every case except the one that
 * actually bites: **`FOR UPDATE` over an EMPTY SET locks nothing.** A card with
 * no to-dos yet has no rows to lock, so N concurrent first-appends all lock
 * nothing, all read an empty list, and all mint `keyForAppend(null)` — the same
 * key, N times.
 *
 * That is not hypothetical: it is what this service did until
 * `tests/integration/work-items/work-item-todos.test.ts`'s five-way append test
 * returned **two** distinct keys for five rows. A serial test cannot see it,
 * and neither can a two-way race that happens to have a seed row.
 *
 * `work_item.id` is a row that ALWAYS exists — an immutable predicate no
 * concurrent writer can invalidate, the same property `lockById`'s own note
 * gives as its reason — so locking it serializes every to-do write on the card
 * whether the list is empty or not. The list is short by construction (the
 * granularity bar), the lock is held for the length of one small transaction,
 * and it costs no extra round trip on the gated paths because the card has
 * already been resolved.
 */
async function lockTodoList(workItemId: string, tx: Prisma.TransactionClient): Promise<void> {
  await workItemRepository.lockById(workItemId, tx);
}

/**
 * Resolve a work item under the hide-gates and assert the actor may EDIT it.
 * Missing / cross-workspace / non-browsable → `WorkItemNotFoundError` (404 —
 * finding #44, no existence leak); a browser without edit rights keeps the
 * typed `ProjectAccessDeniedError('edit')` (→ 403, read-only viewer). The
 * `labelsService` / `componentsService` helper, which is the shape every
 * work-item-child write in this codebase gates through.
 */
async function resolveEditableWorkItem(
  workItemId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
  try {
    await projectAccessService.assertCanEdit(item.projectId, ctx, tx);
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
      throw new WorkItemNotFoundError(workItemId);
    }
    throw err;
  }
  return item;
}

/**
 * Resolve one to-do AND assert the actor may edit the card it hangs on.
 *
 * The to-do id is resolved FIRST and its card second, so a caller only ever
 * has to hold the to-do's id — and a to-do in another workspace is a 404 by
 * two independent mechanisms: RLS never returns the row, and the card gate
 * would reject it if it somehow did.
 */
async function resolveEditableTodo(
  todoId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<{ todo: WorkItemTodo; item: WorkItem }> {
  const todo = await workItemTodoRepository.findById(todoId, tx);
  if (!todo) throw new WorkItemTodoNotFoundError(todoId);
  const item = await resolveEditableWorkItem(todo.workItemId, ctx, tx);
  return { todo, item };
}

/**
 * Validate a to-do's text against the granularity bar and return it trimmed.
 *
 * REJECTS, never truncates — the difference matters: a truncated step is a
 * step whose second half is silently gone, and the author is the only person
 * who can decide which two steps it should have been.
 */
function requireText(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) throw new EmptyTodoTextError();
  if (text.length > TODO_TEXT_MAX_LENGTH) throw new TodoTextTooLongError(text.length);
  return text;
}

/**
 * Validate the optional INSTRUCTIONS and return them, or `null`.
 *
 * Markdown, unlike `text` — the how of a dashboard flow wants a numbered list
 * and a link, and a plain-text field would strip exactly the part that makes
 * *"go to the dashboard"* actionable. Whitespace-only normalises to `null` so a
 * row cannot render an empty disclosure.
 *
 * ⚠️ THIS CAP IS NOT A GRANULARITY BAR. `text`'s 200 asks *"is this one
 * operation?"*; this 2000 asks *"has the how become a document?"* — and the
 * remedy for hitting it is a card, not a split, which is what its typed error
 * says.
 */
function normalizeNotes(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const notes = raw.trim();
  if (notes.length === 0) return null;
  if (notes.length > TODO_NOTES_MAX_LENGTH) throw new TodoNotesTooLongError(notes.length);
  return notes;
}

/**
 * Validate an optional command. An empty / whitespace-only string normalises to
 * `null` rather than to `''` — the DTO's contract is that `commandText === null`
 * is exactly "not a command row", and an empty string would make a row that
 * renders a copy button for nothing.
 */
function normalizeCommand(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const command = raw.trim();
  if (command.length === 0) return null;
  if (command.length > TODO_COMMAND_MAX_LENGTH) throw new TodoCommandTooLongError(command.length);
  return command;
}

/**
 * The card's progress, read INSIDE the caller's transaction.
 *
 * ⚠️ Never called after the transaction closes. The number returned to a caller
 * is the number a header renders, so it must describe the list that write
 * produced — a count taken afterwards describes a LATER snapshot, and the
 * header would then be a true statement about a list nobody was shown.
 */
async function progressOf(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<TodoProgressDto> {
  const { done, total } = await workItemTodoRepository.countByWorkItem(workItemId, tx);
  return { done, total };
}

/** Record one structural revision on the parent card (never for a tick). */
async function recordTodoRevision(
  workItemId: string,
  userId: string,
  diff: Record<string, unknown>,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await workItemRevisionsService.recordRevision(
    { workItemId, changedById: userId, changeKind: 'updated', diff },
    tx,
  );
}

/**
 * What every WRITE returns: the row that was written, and the card's progress
 * AS OF THAT WRITE.
 *
 * The progress rides on every write rather than only on the tick, because the
 * header moves for four of the five: an add raises the total, a delete lowers
 * it, and a tick moves the numerator. Returning it here is what lets the
 * section update in place without a follow-up read that would describe a later
 * snapshot.
 */
export interface TodoWriteResult {
  todo: WorkItemTodoDto;
  progress: TodoProgressDto;
}

export interface AddTodoInput {
  text: string;
  /** The INSTRUCTIONS — optional Markdown, the *how* of this one operation. */
  notesMd?: string | null;
  commandText?: string | null;
  /**
   * Who this operation is for. Omitted ⇒ SEEDED from the parent card's own
   * `executor`, and from `human` when the card carries none (ADR §2) — which
   * is what makes "this manual card has three steps the agent can do" a
   * one-click exception on the odd row rather than a field every row makes you
   * fill in.
   */
  executor?: ExecutorDto | null;
}

export interface UpdateTodoInput {
  text?: string;
  notesMd?: string | null;
  commandText?: string | null;
  executor?: ExecutorDto | null;
}

export const workItemTodosService = {
  /**
   * One card's to-do list plus its header counts.
   *
   * Read inside a workspace-bound transaction because the table's only policy
   * gates on `app.workspace_id` and has no public or system arm: an unbound
   * read returns an empty list and raises nothing, which is indistinguishable
   * from a card that genuinely has no steps.
   */
  async listTodos(workItemId: string, ctx: ServiceContext): Promise<WorkItemTodoListDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      // The card is resolved under the BROWSE gate, not the edit gate — a
      // read-only member sees the list and its progress; what they do not get
      // is any of the controls (MOTIR-3815 reads the same permission set the
      // page already resolves).
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(workItemId);
      await projectAccessService.assertCanBrowse(item.projectId, ctx, tx);
      const rows = await workItemTodoRepository.listByWorkItem(workItemId, tx);
      return toWorkItemTodoListDto(rows);
    });
  },

  /**
   * Append one to-do to the end of a card's list.
   *
   * ⚠️ THE KEY IS MINTED FROM A LOCKED READ. Two concurrent appends read the
   * same "current last" row and mint the same key from it — a race that passes
   * every serial test and shows up the first time two people edit one card.
   * The list is locked `FOR UPDATE` and re-read inside this transaction, so the
   * two serialize and the second mints from the first's committed row.
   */
  async addTodo(
    workItemId: string,
    input: AddTodoInput,
    ctx: ServiceContext,
  ): Promise<TodoWriteResult> {
    const text = requireText(input.text);
    const notesMd = normalizeNotes(input.notesMd);
    const commandText = normalizeCommand(input.commandText);

    return withWorkspaceContext(ctx, async (tx) => {
      const item = await resolveEditableWorkItem(workItemId, ctx, tx);
      await lockTodoList(item.id, tx);
      // Read AFTER the lock, never before it — a list read outside the lock
      // that guards it is a snapshot of the past.
      const existing = await workItemTodoRepository.listByWorkItem(item.id, tx);
      const last = existing.at(-1)?.position ?? null;

      const executor =
        input.executor !== undefined ? input.executor : (item.executor ?? ('human' as const));

      const created = await workItemTodoRepository.create(
        {
          workspaceId: ctx.workspaceId,
          workItemId: item.id,
          text,
          notesMd,
          commandText,
          executor,
          position: keyForAppend(last),
        },
        tx,
      );

      await recordTodoRevision(
        item.id,
        ctx.userId,
        { todos: { added: [{ id: created.id, text: created.text }] } },
        tx,
      );

      return { todo: toWorkItemTodoDto(created), progress: await progressOf(item.id, tx) };
    });
  },

  /**
   * Edit one to-do's content — its text, its command, or who it is for.
   *
   * SPARSE: an omitted key is left alone, and an explicit `null` on
   * `commandText` / `executor` CLEARS it. That distinction is why the patch
   * takes `undefined` rather than treating a missing field as a clear — a
   * client that sends only the field the user typed in must not blank the two
   * it did not.
   */
  async updateTodo(
    todoId: string,
    input: UpdateTodoInput,
    ctx: ServiceContext,
  ): Promise<TodoWriteResult> {
    const patch: Prisma.WorkItemTodoUncheckedUpdateInput = {};
    if (input.text !== undefined) patch.text = requireText(input.text);
    if (input.notesMd !== undefined) patch.notesMd = normalizeNotes(input.notesMd);
    if (input.commandText !== undefined) patch.commandText = normalizeCommand(input.commandText);
    if (input.executor !== undefined) patch.executor = input.executor;

    return withWorkspaceContext(ctx, async (tx) => {
      const { todo, item } = await resolveEditableTodo(todoId, ctx, tx);
      if (Object.keys(patch).length === 0) {
        return { todo: toWorkItemTodoDto(todo), progress: await progressOf(item.id, tx) };
      }

      const updated = await workItemTodoRepository.update(todo.id, patch, tx);
      await recordTodoRevision(
        item.id,
        ctx.userId,
        {
          todos: {
            edited: [
              {
                id: todo.id,
                from: {
                  text: todo.text,
                  notesMd: todo.notesMd,
                  commandText: todo.commandText,
                  executor: todo.executor,
                },
                to: {
                  text: updated.text,
                  notesMd: updated.notesMd,
                  commandText: updated.commandText,
                  executor: updated.executor,
                },
              },
            ],
          },
        },
        tx,
      );
      return { todo: toWorkItemTodoDto(updated), progress: await progressOf(item.id, tx) };
    });
  },

  /**
   * Move one to-do to `toIndex` in the card's DISPLAY order.
   *
   * ⚠️ THE DESTINATION IS AN INDEX, NOT A PAIR OF NEIGHBOUR IDS, and that is
   * the concurrency-safe half of the design. Neighbour ids are resolved on the
   * CLIENT, against a list it rendered some seconds ago; an index is resolved
   * HERE, against the list this transaction just locked. If somebody else
   * inserted, moved or deleted a row in between, an index still names a real
   * slot in the current list while a neighbour id may name a row that is no
   * longer adjacent — or no longer there.
   *
   * ⚠️ AND IT WRITES EXACTLY ONE ROW. That is the whole reason `position` is a
   * fractional index rather than an integer rank: a move mints one key between
   * two neighbours instead of renumbering everything below it.
   */
  async moveTodo(todoId: string, toIndex: number, ctx: ServiceContext): Promise<TodoWriteResult> {
    return withWorkspaceContext(ctx, async (tx) => {
      const { todo, item } = await resolveEditableTodo(todoId, ctx, tx);
      await lockTodoList(todo.workItemId, tx);
      const current = await workItemTodoRepository.listByWorkItem(todo.workItemId, tx);

      // The list WITHOUT the moving row — the destination index is read
      // against the order the row will land in, which is the order a drag
      // shows the user.
      const others = current.filter((row) => row.id !== todo.id);
      if (others.length === current.length) {
        // The row was deleted between the gate read and the lock. Reporting it
        // is better than minting a key onto a list the caller is no longer
        // looking at — and better than the raw `P2025` the update would throw.
        throw new TodoReorderConflictError();
      }

      const index = Math.max(0, Math.min(Math.trunc(toIndex), others.length));
      const prev = index > 0 ? (others[index - 1]?.position ?? null) : null;
      const next = index < others.length ? (others[index]?.position ?? null) : null;

      // `keyBetweenSafe`, not `keyBetween`: a stored position that is not a
      // valid fractional key (a legacy row, an import) must not 500 somebody's
      // drag. It treats a bad bound as an open end.
      const position = keyBetweenSafe(prev, next);
      const moved = await workItemTodoRepository.setPosition(todo.id, position, tx);

      await recordTodoRevision(
        item.id,
        ctx.userId,
        { todos: { moved: [{ id: todo.id, text: todo.text, toIndex: index }] } },
        tx,
      );
      return { todo: toWorkItemTodoDto(moved), progress: await progressOf(item.id, tx) };
    });
  },

  /**
   * Tick or un-tick one to-do, and report the card's progress as of the SAME
   * snapshot.
   *
   * ⚠️ NO REVISION ROW — this is contract 2 at the top of the file, and it is
   * the one place in this service where a write deliberately leaves no trail
   * in `work_item_revision`. The record of a tick is `doneAt` + `doneById` ON
   * THE ROW, which answers *who completed this step and when* directly, where
   * the reader is already looking.
   *
   * ⚠️ AND THE COUNT IS READ INSIDE THE WRITE'S TRANSACTION. The number
   * returned here is the number a header renders, so it must describe the list
   * this write produced — a second `count()` afterwards would describe a later
   * snapshot, and the header would be a true statement about a list nobody was
   * shown.
   *
   * The two stamp columns are written and cleared TOGETHER, so no row can be
   * half-ticked. Nothing about the row's `executor` is consulted: a person may
   * tick an agent's step, because they may simply have done it themselves
   * (ADR §2).
   */
  async setTodoDone(todoId: string, done: boolean, ctx: ServiceContext): Promise<TodoWriteResult> {
    return withWorkspaceContext(ctx, async (tx) => {
      const { todo } = await resolveEditableTodo(todoId, ctx, tx);
      const updated = await workItemTodoRepository.update(
        todo.id,
        done ? { doneAt: new Date(), doneById: ctx.userId } : { doneAt: null, doneById: null },
        tx,
      );
      return {
        todo: toWorkItemTodoDto(updated),
        progress: await progressOf(todo.workItemId, tx),
      };
    });
  },

  /**
   * Delete one to-do. Structural, so it records a revision — and it returns the
   * card's progress, because removing a row moves the header's denominator.
   */
  async deleteTodo(todoId: string, ctx: ServiceContext): Promise<TodoProgressDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const { todo, item } = await resolveEditableTodo(todoId, ctx, tx);
      await workItemTodoRepository.delete(todo.id, tx);
      await recordTodoRevision(
        item.id,
        ctx.userId,
        { todos: { removed: [{ id: todo.id, text: todo.text }] } },
        tx,
      );
      return progressOf(item.id, tx);
    });
  },
};
