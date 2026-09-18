import type { MonitorIssue, Prisma } from '@/generated/prisma/client';

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
};
