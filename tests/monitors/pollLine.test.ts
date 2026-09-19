import { describe, expect, it } from 'vitest';
import { MONITOR_ISSUE_RECONCILE_OVERDUE_MS } from '@/lib/jobs/definitions/monitorIssueReconcile';
import type { MonitorConnectionDto } from '@/lib/dto/monitors';
import { pollLineState, type PollLineInputs } from '@/lib/monitors/pollLine';

// THE POLL-LINE DECISION (Story MOTIR-4929 · Subtask MOTIR-5582) — §12's state
// table as a pure function, and the overdue threshold read from the
// reconciler's OWN constant rather than re-declared.

const NOW = new Date('2026-09-18T12:00:00.000Z');
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function connection(overrides: Partial<MonitorConnectionDto> = {}): MonitorConnectionDto {
  return {
    id: 'conn-1',
    provider: 'sentry',
    externalProjectId: 'ext-1',
    externalProjectSlug: 'web',
    health: 'connected',
    healthReason: null,
    healthCheckedAt: null,
    orgSlug: 'acme-inc',
    createdAt: ago(5 * MINUTE),
    minimumLevel: null,
    lastPolledAt: null,
    lastPollStatus: null,
    lastPollError: null,
    lastPollFiledCount: null,
    lastPollSucceededAt: null,
    resolveOnDone: true,
    syncAssignee: true,
    lastSyncError: null,
    lastSyncErrorAt: null,
    lastSyncErrorWorkItemIdentifier: null,
    ...overrides,
  };
}

const inputs = (overrides: Partial<PollLineInputs> = {}): PollLineInputs => ({
  now: NOW,
  overdueMs: MONITOR_ISSUE_RECONCILE_OVERDUE_MS,
  grantDegraded: false,
  grantReason: null,
  ...overrides,
});

describe('pollLineState', () => {
  it('uses the reconciler’s own threshold — two missed half-hourly ticks', () => {
    expect(MONITOR_ISSUE_RECONCILE_OVERDUE_MS).toBe(60 * MINUTE);
  });

  it('flips to overdue exactly at the threshold: one minute either side of it', () => {
    const before = connection({
      lastPolledAt: ago(MONITOR_ISSUE_RECONCILE_OVERDUE_MS - MINUTE),
      lastPollStatus: 'ok',
      lastPollFiledCount: 0,
    });
    const after = connection({
      lastPolledAt: ago(MONITOR_ISSUE_RECONCILE_OVERDUE_MS + MINUTE),
      lastPollStatus: 'ok',
      lastPollFiledCount: 0,
    });
    expect(pollLineState(before, inputs()).kind).toBe('ok');
    expect(pollLineState(after, inputs())).toEqual({
      kind: 'overdue',
      since: new Date(after.lastPolledAt!),
    });
  });

  it('never polled and bound recently: waiting', () => {
    expect(pollLineState(connection(), inputs())).toEqual({ kind: 'waiting' });
  });

  it('never polled and bound an hour or more ago: overdue from the BINDING time, never "waiting"', () => {
    const c = connection({ createdAt: ago(MONITOR_ISSUE_RECONCILE_OVERDUE_MS + MINUTE) });
    expect(pollLineState(c, inputs())).toEqual({ kind: 'overdue', since: new Date(c.createdAt) });
  });

  it('recent ok: the check time and the filed count (0 when unrecorded)', () => {
    const c = connection({
      lastPolledAt: ago(4 * MINUTE),
      lastPollStatus: 'ok',
      lastPollFiledCount: 3,
    });
    expect(pollLineState(c, inputs())).toEqual({
      kind: 'ok',
      checkedAt: new Date(c.lastPolledAt!),
      filedCount: 3,
    });
    expect(pollLineState({ ...c, lastPollFiledCount: null }, inputs())).toMatchObject({
      filedCount: 0,
    });
  });

  it('failed: the stored reason verbatim, and the last success when there was one', () => {
    const c = connection({
      lastPolledAt: ago(2 * MINUTE),
      lastPollStatus: 'failed',
      lastPollError: 'Sentry returned 429.',
      lastPollSucceededAt: ago(30 * MINUTE),
    });
    expect(pollLineState(c, inputs())).toEqual({
      kind: 'failed',
      reason: 'Sentry returned 429.',
      lastSucceededAt: new Date(c.lastPollSucceededAt!),
    });
  });

  it('OVERDUE is checked BEFORE the stored status — a failed row that stopped being polled reads overdue', () => {
    const c = connection({
      lastPolledAt: ago(2 * MONITOR_ISSUE_RECONCILE_OVERDUE_MS),
      lastPollStatus: 'failed',
      lastPollError: 'x',
    });
    expect(pollLineState(c, inputs()).kind).toBe('overdue');
  });

  it('a DEGRADED grant reads every row as failed — the row’s own reason first, else the grant’s', () => {
    const okRow = connection({ lastPolledAt: ago(3 * MINUTE), lastPollStatus: 'ok' });
    expect(pollLineState(okRow, inputs({ grantDegraded: true, grantReason: 'Revoked.' }))).toEqual({
      kind: 'failed',
      reason: 'Revoked.',
      lastSucceededAt: null,
    });

    const failedRow = connection({
      lastPolledAt: ago(3 * MINUTE),
      lastPollStatus: 'failed',
      lastPollError: 'Sentry refused this connection.',
    });
    expect(
      pollLineState(failedRow, inputs({ grantDegraded: true, grantReason: 'Revoked.' })),
    ).toMatchObject({ reason: 'Sentry refused this connection.' });

    // Never polled, degraded grant: failed too, never "waiting".
    expect(pollLineState(connection(), inputs({ grantDegraded: true, grantReason: null }))).toEqual(
      {
        kind: 'failed',
        reason: '',
        lastSucceededAt: null,
      },
    );
  });
});
