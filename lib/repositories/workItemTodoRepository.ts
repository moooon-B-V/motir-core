import { Prisma, type WorkItemTodo } from '@/generated/prisma/client';
import type { WorkItemTodoRow } from '@/lib/mappers/workItemTodoMappers';

/**
 * The `WorkItemTodo` update shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.WorkItemTodoUncheckedUpdateInput` itself is named only here.
 */
export type WorkItemTodoUpdateInput = Prisma.WorkItemTodoUncheckedUpdateInput;

/**
 * The `doneBy` selection every read carries — the two fields the wire DTO
 * needs and nothing else, so a to-do read can never become a door onto a user
 * record.
 */
const DONE_BY_SELECT = { select: { id: true, name: true } } as const;

// Work-item to-do repository — single Prisma operations on the
// `work_item_todo` table (Story MOTIR-3808 · Subtask MOTIR-3813). The
// persistence leaf under `workItemTodosService`, which owns the transactions,
// the `work_item:edit` gate, the granularity bar, the fractional-index
// arithmetic, the revision split and the DTO mapping.
//
// Layer rules (CLAUDE.md): writes REQUIRE `tx` — every to-do write rides a
// transaction, because each one either mints a key from its NEIGHBOURS (create,
// move) or is reported back alongside a count that must be read from the same
// snapshot (tick). Reads used inside those transactions take `tx` too.
//
// ⚠️ EVERY READ HERE TAKES A REQUIRED `tx`, and that is NOT the usual
// "read-only paths may use the `db` singleton" arm. `work_item_todo` carries
// ONE policy — `work_item_todo_active_workspace`, gating on `app.workspace_id`
// — and NO public or system arm, so an UNBOUND read returns an EMPTY LIST and
// raises nothing. A card's to-do section would render as a card with no steps.
// That failure is silent and indistinguishable from the real empty state, which
// is exactly why the binding is a type error rather than a convention here
// (`commentRepository.listPublicByWorkItem`'s MOTIR-2784 reasoning, applied at
// the table's only read).
//
// No error translation: the table has no triggers, and a cross-workspace write
// is caught by the policy's WITH CHECK (42501) for non-bypass roles.

export const workItemTodoRepository = {
  /**
   * One card's whole to-do list, in DISPLAY order.
   *
   * `position` then `id`: `position` alone is not a total order, because two
   * rows can carry the same key (the fractional index makes that unlikely, not
   * impossible — a restore, an import, or a legacy row can collide), and an
   * unbroken tie makes the order non-deterministic between reads. `id` is the
   * tiebreak, the same role it plays in `commentRepository`'s cursor walk.
   *
   * NOT paged, deliberately: the granularity bar makes a to-do list a short,
   * whole-list read — a card with enough steps to need paging has a planning
   * problem, not a paging one.
   */
  async listByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemTodoRow[]> {
    return tx.workItemTodo.findMany({
      where: { workItemId },
      include: { doneBy: DONE_BY_SELECT },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  },

  async findById(id: string, tx: Prisma.TransactionClient): Promise<WorkItemTodo | null> {
    return tx.workItemTodo.findUnique({ where: { id } });
  },

  async create(
    data: Prisma.WorkItemTodoUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemTodoRow> {
    return tx.workItemTodo.create({ data, include: { doneBy: DONE_BY_SELECT } });
  },

  async update(
    id: string,
    patch: WorkItemTodoUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemTodoRow> {
    return tx.workItemTodo.update({
      where: { id },
      data: patch,
      include: { doneBy: DONE_BY_SELECT },
    });
  },

  /**
   * Move one row to a new fractional key.
   *
   * A SEPARATE method from {@link update} even though the Prisma call is the
   * same shape, because it is the one write whose ROW COUNT is a contract:
   * a reorder touches exactly ONE row, and naming the operation is what lets
   * a test assert that without asserting on the resulting order.
   */
  async setPosition(
    id: string,
    position: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemTodoRow> {
    return tx.workItemTodo.update({
      where: { id },
      data: { position },
      include: { doneBy: DONE_BY_SELECT },
    });
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<WorkItemTodo> {
    return tx.workItemTodo.delete({ where: { id } });
  },

  /**
   * How many of a card's to-dos exist and how many are ticked, in ONE query.
   *
   * ⚠️ Read inside the WRITE's transaction, never after it. The tick path
   * returns this count to its caller, and a count taken in a second
   * transaction is a count of a LATER snapshot — the header would then be a
   * true statement about a list the caller was not shown.
   */
  async countByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ total: number; done: number }> {
    const [total, done] = await Promise.all([
      tx.workItemTodo.count({ where: { workItemId } }),
      tx.workItemTodo.count({ where: { workItemId, doneAt: { not: null } } }),
    ]);
    return { total, done };
  },
};
