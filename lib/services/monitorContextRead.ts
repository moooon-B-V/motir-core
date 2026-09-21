import type { Prisma } from '@/generated/prisma/client';
import type { NormalizedMonitorIssueContext } from '@/lib/monitors/types';
import {
  monitorIssueRepository,
  type MonitorIssueEvidence,
  type MonitorIssueFacts,
} from '@/lib/repositories/monitorIssueRepository';

// ONE latest-event context read, as the two writers of a link see it (Story
// MOTIR-5975 · Subtask MOTIR-5979): the reconciling poll's visit and the
// hand-made link. Both used to collapse three different outcomes into one
// `null`; the evidence store has to tell them apart, because a FAILED check is
// what makes the stored evidence stale and a SKIPPED one says nothing at all.
//
// It lives here, beside the services that read and write, and not in
// `lib/monitors/`: that module is the provider seam and holds no store shape.

/**
 * What a context read came to.
 *
 * - `read` — the provider answered; `context` is its answer and `at` the moment.
 * - `failed` — a read was ATTEMPTED and did not answer: a refusal, a timeout, a
 *   gone issue. `at` is when the check failed.
 * - `skipped` — no read was attempted: no credential, or past the poll's
 *   `MONITOR_CONTEXT_READS_PER_POLL` budget. Nothing is learnt, so nothing is
 *   written.
 */
export type MonitorContextRead =
  | { outcome: 'read'; context: NormalizedMonitorIssueContext; at: Date }
  | { outcome: 'failed'; at: Date }
  | { outcome: 'skipped' };

export const MONITOR_CONTEXT_SKIPPED: MonitorContextRead = { outcome: 'skipped' };

/**
 * The part of a visit's facts a context read decides (MOTIR-5729 · MOTIR-5979):
 * `environment` / `release` on a `read`, only `evidenceCheckedAt` on a `failed`,
 * and nothing on a `skipped` — every absent key leaves the stored value
 * standing (`MonitorIssueFacts`'s optional rule). A `read` does NOT put
 * `evidenceCheckedAt` here: it rides the conditional evidence write, so a late
 * read of an older event cannot move it.
 */
export function contextFactsOf(
  read: MonitorContextRead,
): Pick<MonitorIssueFacts, 'environment' | 'release' | 'evidenceCheckedAt'> {
  switch (read.outcome) {
    case 'read':
      return { environment: read.context.environment, release: read.context.release };
    case 'failed':
      return { evidenceCheckedAt: read.at };
    case 'skipped':
      return {};
  }
}

/** A `read`'s evidence in the store's shape, or `null` for any other outcome. */
export function evidenceOf(read: MonitorContextRead): MonitorIssueEvidence | null {
  if (read.outcome !== 'read') return null;
  const { context } = read;
  return {
    exceptionType: context.exception?.type ?? null,
    exceptionMessage: context.exception?.message ?? null,
    frames: context.frames,
    tags: context.tags,
    requestMethod: context.request?.method ?? null,
    requestPath: context.request?.path ?? null,
    eventId: context.eventId,
    eventAt: context.eventAt,
    readAt: read.at,
  };
}

/**
 * Write a visit's facts AND, when the read succeeded, its evidence — the ONE
 * write every writer of a link calls, inside the transaction that already holds
 * the row lock. The facts land unconditionally; the evidence lands only when its
 * event is not older than the stored one (`updateEvidenceIfNotOlder`).
 */
export async function writeLinkFacts(
  rowId: string,
  facts: MonitorIssueFacts,
  read: MonitorContextRead,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await monitorIssueRepository.updateFacts(rowId, facts, tx);
  const evidence = evidenceOf(read);
  if (evidence) await monitorIssueRepository.updateEvidenceIfNotOlder(rowId, evidence, tx);
}
