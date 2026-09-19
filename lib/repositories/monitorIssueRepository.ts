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

/** A link with the connection and grant it came from — what the work-item
 *  page's Errors section reads (MOTIR-5730). The installation contributes only
 *  its `metadata` (the organisation slug), never a credential column. */
export type MonitorIssueWithConnection = MonitorIssue & {
  connection: {
    id: string;
    externalProjectSlug: string;
    installation: { metadata: Prisma.JsonValue | null };
  };
};

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

  /**
   * Every link pointing at one work item, WITH the connection it came from and
   * that connection's grant metadata — the Errors section's read (Story
   * MOTIR-4932 · Subtask MOTIR-5730). Most recently seen first, `externalIssueId`
   * as the stable tie-break.
   *
   * ⚠️ A SECOND READ BESIDE {@link listByWorkItem}, DELIBERATELY, and not a
   * near-copy of it: that one is the resolve-back's fan-out, which wants bare
   * rows in a stable `id` order and no join; this one is a person's list, which
   * wants recency order and the connection's label. Widening the fan-out's read
   * to carry a join it never uses, or re-ordering it under the sync, would change
   * a shipped consumer for a reader it does not have.
   *
   * The `select` on the installation is the credential boundary: no token column
   * is fetched, so none can reach a DTO by accident. Runs under the CALLER's
   * workspace binding — `monitor_issue`, `monitor_connection` and
   * `monitor_installation` each scope it by policy.
   */
  async listByWorkItemWithConnection(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssueWithConnection[]> {
    return tx.monitorIssue.findMany({
      where: { workItemId },
      include: {
        connection: {
          select: {
            id: true,
            externalProjectSlug: true,
            installation: { select: { metadata: true } },
          },
        },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { externalIssueId: 'asc' }],
    });
  },

  // ── THE HAND-MADE LINK (Story MOTIR-4932 · Subtask MOTIR-5731) ───────────
  // A manual link is an ordinary row, so the reconciler's dedup, the resolve-back
  // and the assignee sync all apply to it with no special case. These leaves are
  // the three single statements the link service needs beyond claim-or-lock.

  /**
   * Which work item — if any — holds each of these provider issues, in ONE
   * query (the picker's *Linked to KEY-n*). Filters on both columns' sets and
   * leaves the exact `(connection, issue)` pairing to the caller: the sets are
   * one search's worth (a few connections × a picker page), so the over-match
   * is small and bounded.
   */
  async listHoldersForIssues(
    connectionIds: readonly string[],
    externalIssueIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{
      connectionId: string;
      externalIssueId: string;
      workItemId: string | null;
      workItem: { identifier: string } | null;
    }>
  > {
    if (connectionIds.length === 0 || externalIssueIds.length === 0) return [];
    return tx.monitorIssue.findMany({
      where: {
        connectionId: { in: [...connectionIds] },
        externalIssueId: { in: [...externalIssueIds] },
      },
      select: {
        connectionId: true,
        externalIssueId: true,
        workItemId: true,
        workItem: { select: { identifier: true } },
      },
    });
  },

  /**
   * MOVE a link to another work item: re-point it and CLEAR the per-link sync
   * record MOTIR-5701 added — the resolve-back and the assignee sync start over
   * for the new card. `resolved_by_motir_at` is deliberately LEFT: it is the loop
   * guard's input (MOTIR-5704), a fact about what Motir did to the ISSUE, which a
   * move does not undo.
   */
  async repoint(
    id: string,
    workItemId: string,
    identifier: string,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorIssue> {
    return tx.monitorIssue.update({
      where: { id },
      data: {
        workItemId,
        filedWorkItemIdentifier: identifier,
        resolveState: null,
        resolveAttemptedAt: null,
        resolveError: null,
        syncedAssigneeExternalId: null,
        assigneeSyncNote: null,
      },
    });
  },

  /**
   * Delete one link — UNLINK. Deleting (not nulling the pointer) is what makes
   * the issue exactly as untracked as one never ingested: a row with a null
   * pointer and a remembered key reads to the reconciler as "its card was
   * deleted" and re-files naming that card, which would be false.
   */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.monitorIssue.deleteMany({ where: { id } });
    return result.count;
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
