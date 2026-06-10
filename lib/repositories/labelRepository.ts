import { Prisma, type Label } from '@prisma/client';
import { db } from '@/lib/db';

// Label repository — single Prisma operations on the `label` table (Story
// 5.4 · Subtask 5.4.1). The persistence leaf under labelsService (5.4.2),
// which owns the folksonomy mechanics: no-spaces / length / per-issue-cap
// validation, case-insensitive find-or-create (match `nameLower`, create
// with first-typed display casing — in the SAME transaction as the join
// write), delete-on-last-use (a label row dies when its last
// `work_item_label` join goes), permission gating, and DTO mapping.
//
// Layer rules (CLAUDE.md): writes REQUIRE `tx` (a label row is only ever
// created/deleted alongside a join write — find-or-create and
// delete-on-last-use are single transactions). Pure read paths use the `db`
// singleton. No business logic, no transactions, no DTO mapping here.

export const labelRepository = {
  /**
   * The case-insensitive find half of find-or-create (5.4.2): match on
   * `nameLower` within the project (the `@@unique([projectId, nameLower])`
   * key). Optional `tx` — the service calls this INSIDE the find-or-create
   * transaction (a guard read: a miss is followed by a create; the unique
   * constraint backstops the concurrent-create race, so no FOR UPDATE is
   * needed on this path).
   */
  async findByNameLower(
    projectId: string,
    nameLower: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Label | null> {
    const client = tx ?? db;
    return client.label.findUnique({
      where: { projectId_nameLower: { projectId, nameLower } },
    });
  },

  /**
   * The autocomplete read (5.4.2's `searchLabels`): case-insensitive PREFIX
   * match over the project's labels, bounded (`take`, default 20 — never a
   * load-all, finding #57), display-name order. An empty prefix is valid by
   * design: opening the picker before typing lists the first `take` existing
   * labels (the Jira field's behaviour). Walks the `[projectId, nameLower]`
   * unique index. Read-only path → `db` singleton.
   */
  async searchByPrefix(projectId: string, q: string, take = 20): Promise<Label[]> {
    return db.label.findMany({
      where: { projectId, nameLower: { startsWith: q.toLowerCase() } },
      orderBy: { nameLower: 'asc' },
      take,
    });
  },

  /**
   * The labels riding an issue's detail read (5.4.2 slots this into
   * `getIssueDetail`'s parallel fetch — one bounded query, no N+1; bounded
   * in practice by the service's per-issue cap). Relation filter, name
   * order. Read-only path → `db` singleton.
   */
  async listByWorkItem(workItemId: string, tx?: Prisma.TransactionClient): Promise<Label[]> {
    const client = tx ?? db;
    return client.label.findMany({
      where: { workItems: { some: { workItemId } } },
      orderBy: { nameLower: 'asc' },
    });
  },

  /**
   * Lock one label row `FOR UPDATE` inside a transaction — the
   * delete-on-last-use guard (5.4.2, the lock-before-read-derived-update
   * rule): two concurrent "remove this label from an issue" transactions
   * serialize on the label row, so the second sees the first's deleted join
   * row in `countByLabel` and exactly one of them observes zero and deletes
   * the label. `tx` REQUIRED. Returns the locked row's id, or null if the
   * label is already gone (the concurrent path). Mirrors
   * `workItemRepository.lockById`.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "label" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Insert one label (the create half of find-or-create — `name` carries the
   * first-typed display casing, `nameLower` the uniqueness key). Required
   * `tx`: the join row persists in the SAME transaction (5.4.2). Unchecked
   * input: the service already holds the scalar FKs.
   */
  async create(
    data: Prisma.LabelUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Label> {
    return tx.label.create({ data });
  },

  /**
   * Hard-delete one label — the delete-on-last-use path (5.4.2 calls this
   * after `lockById` + a zero `countByLabel` inside the same transaction).
   * Folksonomy semantics: unused labels disappear; no orphan-label GC exists
   * by design.
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<Label> {
    return tx.label.delete({ where: { id } });
  },
};
