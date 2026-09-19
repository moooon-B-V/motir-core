import type { MonitorIssue, Prisma } from '@/generated/prisma/client';
import type { MonitorAssigneeSyncNote } from '@/lib/monitors/syncStates';

// Monitor-issue repository — single Prisma operations on the `monitor_issue`
// table (Story MOTIR-4929 · Subtask MOTIR-5576): the link between ONE provider
// issue, as ONE binding has ingested it, and the `bug` work item filed for it.
// The ingestion service owns every decision (file, update, re-file) and the
// transaction; this leaf holds none of that.
//
// ⚠️ CLAIM-OR-LOCK IS TWO OPERATIONS, AND THE ORDER IS THE MECHANISM. A caller
// that is about to decide what to do with an issue runs, inside ONE transaction:
//
//   1. `insertIfAbsent` — `INSERT … ON CONFLICT DO NOTHING` on the
//      `(connection_id, external_issue_id)` unique index. A concurrent claimant's
//      insert BLOCKS on the first one's uncommitted row until it commits, then
//      does nothing — never a unique-violation 500.
//   2. `lockByExternalId` — `SELECT … FOR UPDATE` on the row that now exists,
//      whoever inserted it. The loser waits here for the winner's whole
//      transaction, then reads the row AS THE WINNER LEFT IT.
//
// The lock is what the reconciler holds across the bug's creation, so a second
// reconciler of one issue sees `workItemId` set and takes `updated` rather than
// filing twice. A count-then-write guard with no constraint and no lock behind
// it passes every serial test and fails only under a warm pool.

/** The facts a reconcile writes, from `NormalizedMonitorIssue`. */
export interface MonitorIssueFacts {
  title: string;
  culprit: string | null;
  level: string | null;
  permalink: string | null;
  eventCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /**
   * The latest event's environment and release (MOTIR-5729). OPTIONAL, and
   * `undefined` is load-bearing: a write that carries no context — the read was
   * capped, failed, or answered gone — leaves the stored values exactly as they
   * were, while an explicit `null` records "the latest event carried none".
   */
  environment?: string | null;
  release?: string | null;
}

export interface InsertMonitorIssueInput extends MonitorIssueFacts {
  connectionId: string;
  projectId: string;
  /** Carried on the CHILD so its RLS policy is a column comparison. */
  workspaceId: string;
  /** The provider's own issue id — THE DEDUP KEY. */
  externalIssueId: string;
}

export const monitorIssueRepository = {
  /**
   * Insert the issue's row unless one already exists for
   * `(connectionId, externalIssueId)`. Returns whether THIS call inserted it.
   *
   * `createMany({ skipDuplicates })` is Prisma's `ON CONFLICT DO NOTHING`, and
   * it is one statement — so the database, not a guarding read, is what makes a
   * second row impossible. The return value is informational: the reconciler
   * decides from the LOCKED row's state, never from who inserted it, because a
   * row a crashed run inserted and never filed must still be filed.
   */
  async insertIfAbsent(
    input: InsertMonitorIssueInput,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.monitorIssue.createMany({ data: [input], skipDuplicates: true });
    return result.count === 1;
  },

  /**
   * Lock the issue's row `FOR UPDATE` and return its id, or null when there is
   * none (or RLS hides it). Blocks while another transaction holds the row —
   * which is the point: the second reconciler of one issue waits for the first
   * to finish filing. The caller re-reads through {@link findById} in the SAME
   * transaction (the `monitorInstallationRepository.lockById` idiom).
   */
  async lockByExternalId(
    connectionId: string,
    externalIssueId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM monitor_issue
       WHERE connection_id = ${connectionId} AND external_issue_id = ${externalIssueId}
         FOR UPDATE`;
    return rows[0]?.id ?? null;
  },

  /** One issue row by id — the re-read under the lock above. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<MonitorIssue | null> {
    return tx.monitorIssue.findUnique({ where: { id } });
  },

  /**
   * Point the row at the bug just filed for it, and remember that bug's key.
   *
   * The key is KEPT after the work item is deleted (the FK is `SET NULL`, the
   * identifier column is not a foreign key), so a later re-file can name the bug
   * it replaces.
   */
  async markFiled(
    id: string,
    workItemId: string,
    identifier: string,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssue> {
    return tx.monitorIssue.update({
      where: { id },
      data: { workItemId, filedWorkItemIdentifier: identifier },
    });
  },

  /** Write the issue's latest facts — the recurrence update. Nothing on the
   *  work item changes; the facts live here. */
  async updateFacts(
    id: string,
    facts: MonitorIssueFacts,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssue> {
    return tx.monitorIssue.update({ where: { id }, data: facts });
  },

  /**
   * Which of these provider issues already have a row that points at a work
   * item, for ONE binding — ONE query, so the poll can tell a hand-linked issue
   * below the minimum level (which it refreshes) from one it merely skips
   * (MOTIR-5729). The caller re-checks the bug under the row lock before
   * writing; this read only decides who is worth a context read.
   */
  async listLinkedByExternalIds(
    connectionId: string,
    externalIssueIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ externalIssueId: string; workItemId: string }>> {
    if (externalIssueIds.length === 0) return [];
    const rows = await tx.monitorIssue.findMany({
      where: {
        connectionId,
        externalIssueId: { in: [...externalIssueIds] },
        workItemId: { not: null },
      },
      select: { externalIssueId: true, workItemId: true },
    });
    return rows.flatMap((row) =>
      row.workItemId ? [{ externalIssueId: row.externalIssueId, workItemId: row.workItemId }] : [],
    );
  },

  // ── SYNC (Story MOTIR-4931 · Subtask MOTIR-5701) ───────────────────────────
  // The resolve-back record and the assignee sync record. The sync service owns
  // WHEN each is written; these leaves own only the single statements.

  /** Every link pointing at one bug. A bug may carry more than one issue — the
   *  `work_item_id` index is not unique. Ordered by id so a fan-out is stable. */
  async listByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<MonitorIssue[]> {
    return tx.monitorIssue.findMany({ where: { workItemId }, orderBy: { id: 'asc' } });
  },

  /**
   * CLAIM one link's resolve-back — the read-derived write this store owns.
   * Returns whether THIS caller won.
   *
   * ⚠️ ONE CONDITIONAL `UPDATE`, never a read-then-write. The same completion can
   * reach the resolver twice (an at-least-once event plus the backstop sweep),
   * and "resolving twice calls the provider once" is only true if exactly one
   * caller wins. Postgres re-evaluates the `WHERE` against the committed row when
   * a concurrent claimant made it wait, so the loser sees `pending` and matches
   * nothing — it neither throws nor claims.
   *
   * Claimable: never attempted (`NULL`), `failed` (the sweep's retry), or a
   * `pending` taken before `staleBefore` (a crashed attempt). `resolved` and
   * `gone` are terminal and never match.
   */
  async claimResolve(
    id: string,
    now: Date,
    staleBefore: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE monitor_issue
         SET resolve_state = 'pending', resolve_attempted_at = ${now}, updated_at = ${now}
       WHERE id = ${id}
         AND (resolve_state IS NULL
              OR resolve_state = 'failed'
              OR (resolve_state = 'pending' AND resolve_attempted_at < ${staleBefore}))
      RETURNING id`;
    return rows.length === 1;
  },

  /** The provider accepted the resolve: the link is `resolved`, and `at` is the
   *  loop guard's input. */
  async recordResolved(id: string, at: Date, tx: Prisma.TransactionClient): Promise<MonitorIssue> {
    return tx.monitorIssue.update({
      where: { id },
      data: { resolveState: 'resolved', resolvedByMotirAt: at, resolveError: null },
    });
  },

  /** The provider refused: `failed` with its reason verbatim — the sweep retries. */
  async recordResolveFailed(
    id: string,
    reason: string,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssue> {
    return tx.monitorIssue.update({
      where: { id },
      data: { resolveState: 'failed', resolveError: reason },
    });
  },

  /** The provider no longer has the issue: `gone`, terminal, never retried. */
  async recordGone(id: string, tx: Prisma.TransactionClient): Promise<MonitorIssue> {
    return tx.monitorIssue.update({
      where: { id },
      data: { resolveState: 'gone', resolveError: null },
    });
  },

  /**
   * The links the backstop sweep should resolve: the bug is in one of
   * `doneStatusKeys` (the project's OWN done category — the caller reads it from
   * the workflow, exactly as `reconcileIssue` does) and the resolve is claimable
   * by {@link claimResolve}'s rule. Oldest first, capped at `limit`.
   */
  async listResolvableForConnection(
    connectionId: string,
    doneStatusKeys: readonly string[],
    staleBefore: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssue[]> {
    if (doneStatusKeys.length === 0) return [];
    return tx.monitorIssue.findMany({
      where: {
        connectionId,
        workItem: { is: { status: { in: [...doneStatusKeys] } } },
        OR: [
          { resolveState: null },
          { resolveState: 'failed' },
          { resolveState: 'pending', resolveAttemptedAt: { lt: staleBefore } },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /**
   * The links the assignee refresh should re-read: the bug still exists and is
   * NOT in one of `doneStatusKeys`. Oldest `assigneeCheckedAt` first, never-
   * checked (`null`) before all, capped at `limit`.
   */
  async listForAssigneeRefresh(
    connectionId: string,
    doneStatusKeys: readonly string[],
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssue[]> {
    return tx.monitorIssue.findMany({
      where: {
        connectionId,
        workItem: { is: { status: { notIn: [...doneStatusKeys] } } },
      },
      orderBy: [{ assigneeCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: limit,
    });
  },

  /** Record what the assignee sync last took (or declined) from the provider. */
  async recordAssigneeSync(
    id: string,
    input: {
      externalAssigneeId: string | null;
      note: MonitorAssigneeSyncNote | null;
      checkedAt: Date;
    },
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssue> {
    return tx.monitorIssue.update({
      where: { id },
      data: {
        syncedAssigneeExternalId: input.externalAssigneeId,
        assigneeSyncNote: input.note,
        assigneeCheckedAt: input.checkedAt,
      },
    });
  },

  /** Stamp that the refresh read this link, changing nothing else (the issue
   *  came back gone, or unchanged). */
  async markAssigneeChecked(
    id: string,
    checkedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssue> {
    return tx.monitorIssue.update({ where: { id }, data: { assigneeCheckedAt: checkedAt } });
  },

  /** Lock one link by id `FOR UPDATE` — the assignee decision's serialisation
   *  point. Returns null when there is none (or RLS hides it). */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<MonitorIssue | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM monitor_issue WHERE id = ${id} FOR UPDATE`;
    if (rows.length === 0) return null;
    return tx.monitorIssue.findUnique({ where: { id } });
  },
};
