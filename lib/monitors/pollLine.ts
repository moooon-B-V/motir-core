import type { MonitorConnectionDto } from '@/lib/dto/monitors';

// WHAT ONE MONITORED-PROJECT ROW SAYS ABOUT INGESTION (Story MOTIR-4929 ·
// Subtask MOTIR-5582) — the decision behind the Monitoring room's poll line,
// `design/monitoring/design-notes.md` §12's state table.
//
// A PURE function of the DTO, the grant's health, a clock and the overdue
// threshold, so every row of that table is one assertion. It takes the
// threshold as an argument rather than importing it, because the constant lives
// beside the cron in the job definition (`MONITOR_ISSUE_RECONCILE_OVERDUE_MS`,
// MOTIR-5581) — a server-only module the client room must not bundle. The page
// passes it in, so there is still exactly one declaration of the number.

export type PollLineState =
  /** Bound recently and never polled — quiet. */
  | { kind: 'waiting' }
  /** The last poll succeeded and is recent — quiet, with the filed count. */
  | { kind: 'ok'; checkedAt: Date; filedCount: number }
  /** No poll for two missed ticks: measured from the last poll, or from the
   *  binding when it was never polled — a scheduler that never reached a new
   *  binding must not read as "waiting". */
  | { kind: 'overdue'; since: Date }
  /** The last poll failed (or the grant is degraded) — the reason verbatim. */
  | { kind: 'failed'; reason: string; lastSucceededAt: Date | null };

export interface PollLineInputs {
  now: Date;
  /** `MONITOR_ISSUE_RECONCILE_OVERDUE_MS`, handed in by the server page. */
  overdueMs: number;
  /** The GRANT's health — a degraded grant reads every row as failed beneath
   *  its banner (§12: grant health and poll health answer different questions). */
  grantDegraded: boolean;
  /** The provider's own reason for the degraded verdict, when the row has none. */
  grantReason: string | null;
}

const parse = (iso: string | null): Date | null => (iso === null ? null : new Date(iso));

/**
 * Decide one row's poll line. The ORDER is §12's, and it is the contract:
 *
 * 1. OVERDUE first — an `ok` or `failed` row that has stopped being polled
 *    reads overdue, because "the scheduler stopped" is the more fundamental
 *    fact and the one this epic exists to surface (MOTIR-4918).
 * 2. A DEGRADED grant — every row reads failed beneath the grant's banner.
 * 3. Never polled (and not yet overdue) — waiting.
 * 4. The stored status — failed with its reason verbatim, or ok.
 */
export function pollLineState(
  connection: MonitorConnectionDto,
  { now, overdueMs, grantDegraded, grantReason }: PollLineInputs,
): PollLineState {
  const lastPolledAt = parse(connection.lastPolledAt);
  const since = lastPolledAt ?? new Date(connection.createdAt);
  if (now.getTime() - since.getTime() >= overdueMs) return { kind: 'overdue', since };

  const lastSucceededAt = parse(connection.lastPollSucceededAt);
  if (grantDegraded) {
    const reason =
      (connection.lastPollStatus === 'failed' ? connection.lastPollError : null) ??
      grantReason ??
      '';
    return { kind: 'failed', reason, lastSucceededAt };
  }

  if (lastPolledAt === null) return { kind: 'waiting' };
  if (connection.lastPollStatus === 'failed') {
    return { kind: 'failed', reason: connection.lastPollError ?? '', lastSucceededAt };
  }
  return { kind: 'ok', checkedAt: lastPolledAt, filedCount: connection.lastPollFiledCount ?? 0 };
}
