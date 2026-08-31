import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// `dispatchRunSweepService` (Story MOTIR-1789 · MOTIR-1792) — the two
// obligations `docs/decisions/dispatch-run-record.md` Q4.2 assigns to this card:
// the 30-day log-body retention window, and the reap that closes a run nothing
// is holding.
//
// ⚠️ THE TENANCY SHAPE IS THE THING UNDER TEST, not just the arithmetic. Both
// halves DISCOVER across workspaces and WRITE within each, so every case here
// seeds TWO tenants and asserts the sweep reached both — a sweep that silently
// only ever cleared the first workspace it saw would pass a single-tenant test
// and leave every other customer's bodies standing for ever.

let a: WorkItemFixture;
let b: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  a = await makeWorkItemFixture({ name: 'Alpha', identifier: 'ALFA' });
  b = await makeWorkItemFixture({ name: 'Bravo', identifier: 'BRVO' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Open a run in one tenant, with one card. */
async function openRun(fixture: WorkItemFixture, command: 'auto' | 'run_scope' = 'auto') {
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title: 'a card' },
    fixture.ctx,
  );
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command,
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    fixture.ctx,
  );
  return { runId: run.id, key: item.identifier };
}

/** Backdate a run's `startedAt` — the only thing the reap reads. */
async function backdateRun(runId: string, days: number): Promise<void> {
  await adminDb.dispatchRun.update({
    where: { id: runId },
    data: { startedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
  });
}

describe('the retention sweep — bodies expire, events do not', () => {
  it('clears expired bodies in EVERY workspace, and leaves the events standing', async () => {
    for (const fixture of [a, b]) {
      const { runId, key } = await openRun(fixture);
      await dispatchRunService.appendEvents(
        runId,
        [
          { kind: 'log', workItemKey: key, body: 'old private output' },
          { kind: 'log', workItemKey: key, body: 'recent private output' },
          { kind: 'agent_exited', workItemKey: key },
        ],
        fixture.ctx,
      );
      // Backdate the FIRST body past the window; the second and the body-less
      // event stay inside it.
      const rows = await adminDb.dispatchRunEvent.findMany({
        where: { dispatchRunId: runId },
        orderBy: { seq: 'asc' },
      });
      await adminDb.dispatchRunEvent.update({
        where: { id: rows[0]!.id },
        data: { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
      });
      await adminDb.dispatchRunEvent.update({
        where: { id: rows[2]!.id },
        data: { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
      });
    }

    const summary = await dispatchRunSweepService.sweep();

    // BOTH tenants — the cross-tenant discovery is the property, not the count.
    expect(summary.workspacesSwept).toBe(2);
    expect(summary.bodiesCleared).toBe(2);

    const events = await adminDb.dispatchRunEvent.findMany({ orderBy: { createdAt: 'asc' } });
    // ⚠️ SIX EVENTS STILL, three per tenant. The sweep nulls BODIES; deleting the
    // rows would put holes in a stream whose readers resume by cursor, and a
    // reader handed 3 after asking for everything past 1 cannot tell a deleted
    // event from one that has not happened yet.
    expect(events).toHaveLength(6);
    expect(events.filter((e) => e.body !== null)).toHaveLength(2);
    expect(events.filter((e) => e.body === 'recent private output')).toHaveLength(2);
  });

  it('is idempotent — a second pass finds strictly less and does nothing', async () => {
    const { runId, key } = await openRun(a);
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'log', workItemKey: key, body: 'x' }],
      a.ctx,
    );
    await adminDb.dispatchRunEvent.updateMany({
      where: { dispatchRunId: runId },
      data: { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    expect((await dispatchRunSweepService.sweep()).bodiesCleared).toBe(1);
    const second = await dispatchRunSweepService.sweep();
    expect(second.workspacesSwept).toBe(0);
    expect(second.bodiesCleared).toBe(0);
  });
});

describe('the abandoned-run reap — a dead run stops reading `running`', () => {
  it('closes stale runs in EVERY workspace as `timed_out` / `abandoned`', async () => {
    const stale = [];
    for (const fixture of [a, b]) {
      const { runId } = await openRun(fixture);
      await backdateRun(runId, 2);
      stale.push(runId);
    }
    // A run inside the threshold is NOT reaped — the twelve hours are what stop
    // the sweep replacing a true `running` with a false `abandoned`, which is a
    // terminal answer nobody re-examines.
    const { runId: fresh } = await openRun(a);

    const summary = await dispatchRunSweepService.sweep();

    expect(summary.runsReaped).toBe(2);
    expect(summary.runsRacedByClose).toBe(0);
    expect(summary.runsFailed).toBe(0);

    for (const runId of stale) {
      const row = await adminDb.dispatchRun.findUnique({ where: { id: runId } });
      expect(row).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });
      expect(row!.endedAt).not.toBeNull();
    }
    expect((await adminDb.dispatchRun.findUnique({ where: { id: fresh } }))!.status).toBe(
      'running',
    );
  });

  it('settles the legs a reaped run left in flight', async () => {
    const { runId, key } = await openRun(a);
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'card_claimed', workItemKey: key, disposition: 'running' }],
      a.ctx,
    );
    await backdateRun(runId, 2);

    await dispatchRunSweepService.sweep();

    const leg = await adminDb.dispatchRunCard.findFirst({ where: { dispatchRunId: runId } });
    // The run died while an agent was on this card and nothing ever reported an
    // outcome. `failed` is the only terminal member that does not claim work
    // landed, which is the safe direction for a card somebody now has to look at.
    expect(leg).toMatchObject({ disposition: 'failed' });
  });

  it('COUNTS a run the CLI closed first rather than calling it reaped', async () => {
    const { runId } = await openRun(a);
    await backdateRun(runId, 2);
    // The CLI's own close, before the sweep runs. On the real path this is the
    // seconds between the sweep's discovery read and its close; here it is
    // deterministic, and the assertion is about the ACCOUNTING: a summary that
    // conflated the two would report the reap doing work it did not do, on
    // exactly the nights a fleet of runs finished normally.
    await dispatchRunService.close(runId, { stopReason: 'drained' }, a.ctx);

    const summary = await dispatchRunSweepService.sweep();
    expect(summary.runsReaped).toBe(0);
    expect(summary.runsRacedByClose).toBe(0);

    // …and the clean close STANDS. This is the property the shared lock exists
    // for: the reap goes through `dispatchRunService.close`, so it meets the same
    // already-terminal refusal a second CLI close would.
    const row = await adminDb.dispatchRun.findUnique({ where: { id: runId } });
    expect(row).toMatchObject({ status: 'succeeded', stopReason: 'drained' });
  });

  it('writes NO work-item status when it reaps', async () => {
    const { runId, key } = await openRun(a);
    await backdateRun(runId, 2);
    const before = await adminDb.workItem.findFirst({
      where: { identifier: key },
      select: { status: true, sessionBranch: true, updatedAt: true },
    });

    await dispatchRunSweepService.sweep();

    const after = await adminDb.workItem.findFirst({
      where: { identifier: key },
      select: { status: true, sessionBranch: true, updatedAt: true },
    });
    expect(after).toEqual(before);
  });
});
