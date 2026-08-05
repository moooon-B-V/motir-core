import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import * as motirAiClient from '@/lib/ai/motirAiClient';
import { OFFBOARD_ALL_REPOS } from '@/lib/codeGraph/offboarding';
import {
  codeGraphOffboardSweep,
  CODE_GRAPH_OFFBOARD_SWEEP_CRON,
} from '@/lib/jobs/definitions/codeGraphOffboardSweep';
import { jobFunctions } from '@/lib/jobs/registry';
import { jobSchedules } from '@/lib/jobs/schedules';
import { codeGraphOffboardingRepository } from '@/lib/repositories/codeGraphOffboardingRepository';
import {
  codeGraphOffboardSweepService,
  OFFBOARD_SWEEP_BATCH_SIZE,
} from '@/lib/services/codeGraphOffboardSweepService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateCodeGraphOffboarding, truncateJobRuns } from './helpers/db';

// THE OFFBOARDING SWEEP (MOTIR-2168 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5) — real Postgres for the
// queue, a stubbed motir-ai client for the boundary.
//
// The client is the ONE thing faked: this card is "the clock and the wire", and
// what it must prove is the wire's failure semantics — which row is retired, and
// when. Those are exactly the behaviours a live motir-ai would make untestable.
// The removal itself is proven in motir-ai's own suite (MOTIR-2165).

const NOW = new Date('2026-09-05T00:00:00.000Z');
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);

/** motir-ai's success shape — what `POST /v1/code-graph/offboard` returns. */
function removed(counts: Partial<motirAiClient.CodeGraphOffboardResult> = {}) {
  return {
    projectFound: true,
    repos: [],
    snapshotObjectsDeleted: 0,
    localRootsRemoved: 0,
    coordinationRowsDeleted: 0,
    ...counts,
  } satisfies motirAiClient.CodeGraphOffboardResult;
}

/** Enqueue one row due at `dueAt`, bypassing the trigger paths. */
async function enqueueDueAt(
  coreProjectId: string,
  dueAt: Date,
  repoRef: string = OFFBOARD_ALL_REPOS,
) {
  return withSystemContext((tx) =>
    codeGraphOffboardingRepository.upsert(
      { coreWorkspaceId: 'ws1', coreProjectId, repoRef, dueAt, reason: 'project_archived' },
      tx,
    ),
  );
}

async function allRows() {
  return withSystemContext((tx) =>
    tx.codeGraphOffboarding.findMany({ orderBy: { coreProjectId: 'asc' } }),
  );
}

beforeEach(async () => {
  await truncateCodeGraphOffboarding();
  await truncateJobRuns();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.$disconnect());

// ── 1. registration ──────────────────────────────────────────────────────────

describe('system.code-graph-offboard-sweep is a registered cron sweep', () => {
  it('is served by the Inngest handler and self-registered in the schedule table', () => {
    // `jobFunctions` is what `app/api/inngest/route.ts` serves — a job absent
    // from it is a cron nobody runs, which for THIS job means a retention window
    // the product states and never enforces.
    expect(jobFunctions).toContain(codeGraphOffboardSweep);

    // The schedule table self-registers from inside `defineJob`, so appearing
    // here proves the job actually declared a cron (MOTIR-1970) rather than
    // merely exporting a constant that looks like one.
    expect(jobSchedules()).toContainEqual({
      functionId: 'system.code-graph-offboard-sweep',
      cron: CODE_GRAPH_OFFBOARD_SWEEP_CRON,
    });
  });

  it('runs daily, off-peak, and clear of the other sweeps', () => {
    expect(CODE_GRAPH_OFFBOARD_SWEEP_CRON).toBe('45 4 * * *');
    // And on a slot of its own. This assertion has already earned its place: the
    // first choice was 04:15, which `system.automation-retention-sweep` already
    // holds. Three table-walking sweeps on one minute is not a correctness bug,
    // which is exactly why nobody would notice it.
    const crons = jobSchedules().map((s) => s.cron);
    expect(crons.filter((c) => c === CODE_GRAPH_OFFBOARD_SWEEP_CRON)).toHaveLength(1);
  });
});

// ── 2. the due boundary ──────────────────────────────────────────────────────

describe('what a tick drains', () => {
  it('sweeps a row whose dueAt has passed and LEAVES one still in its window', async () => {
    // The retention window, observed: a graph inside its 30 days is not touched.
    // This is the difference between a window and a delayed delete.
    const offboard = vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(removed());
    await enqueueDueAt('due', PAST);
    await enqueueDueAt('not-yet', FUTURE);

    const result = await codeGraphOffboardSweepService.sweep(NOW);

    expect(result).toMatchObject({ due: 1, offboarded: 1, failed: 0, remaining: 0 });
    expect(offboard).toHaveBeenCalledTimes(1);
    expect(offboard).toHaveBeenCalledWith({ coreWorkspaceId: 'ws1', coreProjectId: 'due' });
    expect((await allRows()).map((r) => r.coreProjectId)).toEqual(['not-yet']);
  });

  it('an empty queue is a clean no-op that calls motir-ai not at all', async () => {
    const offboard = vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(removed());

    const result = await codeGraphOffboardSweepService.sweep(NOW);

    expect(result).toEqual({
      due: 0,
      offboarded: 0,
      failed: 0,
      snapshotObjectsDeleted: 0,
      localRootsRemoved: 0,
      coordinationRowsDeleted: 0,
      remaining: 0,
    });
    expect(offboard).not.toHaveBeenCalled();
  });

  it('translates the project-wide SENTINEL by OMITTING repoRef, and passes a real one through', async () => {
    // The one place motir-core's `*` and motir-ai's "field absent" meet. Sending
    // `repoRef: '*'` would scope the removal to a repo literally named `*` —
    // nothing would be deleted, and the sweep would retire the row saying it was.
    const offboard = vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(removed());
    await enqueueDueAt('whole', PAST, OFFBOARD_ALL_REPOS);
    await enqueueDueAt('one-repo', PAST, 'acme/api');

    await codeGraphOffboardSweepService.sweep(NOW);

    expect(offboard).toHaveBeenCalledWith({ coreWorkspaceId: 'ws1', coreProjectId: 'whole' });
    expect(offboard).toHaveBeenCalledWith({
      coreWorkspaceId: 'ws1',
      coreProjectId: 'one-repo',
      repoRef: 'acme/api',
    });
  });

  it('sums motir-ai’s counts into the job output', async () => {
    // So "what did we actually delete for this tenant" is answerable from the
    // ledger without reading the bucket.
    vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(
      removed({ snapshotObjectsDeleted: 3, localRootsRemoved: 1, coordinationRowsDeleted: 2 }),
    );
    await enqueueDueAt('p1', PAST);
    await enqueueDueAt('p2', PAST);

    const result = await codeGraphOffboardSweepService.sweep(NOW);

    expect(result).toMatchObject({
      offboarded: 2,
      snapshotObjectsDeleted: 6,
      localRootsRemoved: 2,
      coordinationRowsDeleted: 4,
    });
  });
});

// ── 3. ⚠️ the retry design — the row is retired ONLY on success ──────────────

describe('the queue IS the retry (§14.5)', () => {
  it('a FAILING call leaves the row due, and the next tick retries it', async () => {
    // THE assertion of this card. Deleting the row before the removal is
    // confirmed would convert a transient motir-ai outage into permanent
    // retention with no record that anything was owed — the same shape as
    // §14.1's cascade destroying its own inventory.
    const offboard = vi
      .spyOn(motirAiClient, 'offboardCodeGraph')
      .mockRejectedValueOnce(new Error('motir-ai is down'))
      .mockResolvedValueOnce(removed({ coordinationRowsDeleted: 1 }));
    await enqueueDueAt('p1', PAST);

    const first = await codeGraphOffboardSweepService.sweep(NOW);
    expect(first).toMatchObject({ due: 1, offboarded: 0, failed: 1, remaining: 1 });
    expect(await allRows()).toHaveLength(1);

    // The next tick — no bespoke retry state, just the row still being due.
    const second = await codeGraphOffboardSweepService.sweep(NOW);
    expect(second).toMatchObject({ due: 1, offboarded: 1, failed: 0, remaining: 0 });
    expect(await allRows()).toEqual([]);
    expect(offboard).toHaveBeenCalledTimes(2);
  });

  it('one tenant’s failure does not abandon the rest of the batch', async () => {
    // Quiet PER ROW, not per tick. A single unreachable tenant must not hold up
    // every other tenant's retention window.
    vi.spyOn(motirAiClient, 'offboardCodeGraph').mockImplementation(async (input) => {
      if (input.coreProjectId === 'bad') throw new Error('nope');
      return removed({ coordinationRowsDeleted: 1 });
    });
    await enqueueDueAt('aaa', PAST);
    await enqueueDueAt('bad', PAST);
    await enqueueDueAt('zzz', PAST);

    const result = await codeGraphOffboardSweepService.sweep(NOW);

    expect(result).toMatchObject({ due: 3, offboarded: 2, failed: 1, remaining: 1 });
    expect((await allRows()).map((r) => r.coreProjectId)).toEqual(['bad']);
  });

  it('a successful call deletes the row EXACTLY once', async () => {
    vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(removed());
    await enqueueDueAt('p1', PAST);

    await codeGraphOffboardSweepService.sweep(NOW);
    expect(await allRows()).toEqual([]);

    // A second tick finds nothing — idempotency observed, not claimed.
    const again = await codeGraphOffboardSweepService.sweep(NOW);
    expect(again).toMatchObject({ due: 0, offboarded: 0 });
  });

  it('a "nothing was there" response is a SUCCESS and retires the row', async () => {
    // motir-ai answers 200 with zero counts for an unknown project — and the
    // sweep depends on that. Its rows deliberately outlive the projects they
    // name, so "not here" is the expected steady state on a re-run, not a
    // failure to retry forever.
    vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(
      removed({ projectFound: false }),
    );
    await enqueueDueAt('gone', PAST);

    const result = await codeGraphOffboardSweepService.sweep(NOW);

    expect(result).toMatchObject({ offboarded: 1, failed: 0 });
    expect(await allRows()).toEqual([]);
  });
});

// ── 4. the cap, reported rather than hidden ──────────────────────────────────

describe('a capped tick reports the remainder', () => {
  it('drains at most the batch size and says how much is still due', async () => {
    // A silent cap is how a backlog becomes invisible: "offboarded: 50" reads as
    // "everything was offboarded". The queue depth is the honest signal.
    vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(removed());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const overflow = OFFBOARD_SWEEP_BATCH_SIZE + 3;
    for (let i = 0; i < overflow; i++) {
      await enqueueDueAt(`p${String(i).padStart(3, '0')}`, PAST);
    }

    const result = await codeGraphOffboardSweepService.sweep(NOW);

    expect(result.due).toBe(OFFBOARD_SWEEP_BATCH_SIZE);
    expect(result.offboarded).toBe(OFFBOARD_SWEEP_BATCH_SIZE);
    expect(result.remaining).toBe(3);
    expect(await allRows()).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(
      '[code-graph-offboard-sweep] tick ended with work still due',
      expect.objectContaining({ remaining: 3 }),
    );
  });

  it('takes the OLDEST-due rows first, so nothing starves behind a backlog', async () => {
    vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(removed());
    const oldest = new Date(NOW.getTime() - 10 * 60_000);
    await enqueueDueAt('newer', PAST);
    await enqueueDueAt('older', oldest);

    const due = await withSystemContext((tx) => codeGraphOffboardingRepository.findDue(NOW, 1, tx));
    expect(due.map((r) => r.coreProjectId)).toEqual(['older']);
  });
});

// ── 5. the wire the sweep rides ──────────────────────────────────────────────

describe('the queue and the sweep compose end to end', () => {
  it('a trigger’s enqueue becomes a motir-ai call once its window elapses', async () => {
    // The seam MOTIR-2166 and this card meet at, without either's internals: an
    // ordinary windowed enqueue is invisible to the sweep until its due date,
    // then becomes exactly one call with exactly that scope.
    const offboard = vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(removed());
    const enqueuedAt = new Date('2026-08-05T00:00:00.000Z');
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      repoRefs: ['acme/api'],
      reason: 'repo_disconnected',
      now: enqueuedAt,
    });

    // One day in — still inside the 30-day window.
    const dayLater = new Date(enqueuedAt.getTime() + 24 * 60 * 60 * 1000);
    expect(await codeGraphOffboardSweepService.sweep(dayLater)).toMatchObject({ due: 0 });
    expect(offboard).not.toHaveBeenCalled();

    // Thirty-one days in — due.
    const past = new Date(enqueuedAt.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await codeGraphOffboardSweepService.sweep(past)).toMatchObject({ offboarded: 1 });
    expect(offboard).toHaveBeenCalledWith({
      coreWorkspaceId: 'ws1',
      coreProjectId: 'p1',
      repoRef: 'acme/api',
    });
  });

  it('a CANCEL before the due date means the sweep never calls at all', async () => {
    // The grace period, end to end. This is the property that makes the window
    // worth having rather than a scheduled bill.
    const offboard = vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(removed());
    const enqueuedAt = new Date('2026-08-05T00:00:00.000Z');
    await codeGraphOffboardingService.enqueue({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      repoRefs: ['acme/api'],
      reason: 'repo_disconnected',
      now: enqueuedAt,
    });
    await codeGraphOffboardingService.cancel({
      coreWorkspaceId: 'ws1',
      coreProjectIds: ['p1'],
      repoRefs: ['acme/api'],
    });

    const past = new Date(enqueuedAt.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await codeGraphOffboardSweepService.sweep(past)).toMatchObject({ due: 0 });
    expect(offboard).not.toHaveBeenCalled();
  });
});

// ── 6. the JOB, driven in-process ────────────────────────────────────────────

describe('the scheduled job (in-process Inngest run)', () => {
  it('drains the queue and persists its counts on the job_run ledger row', async () => {
    // The handler itself, not just the service under it: a sweep whose job never
    // runs is a retention window the product states and never enforces, and the
    // ledger `output` is how an operator answers "what did we delete for this
    // tenant" without reading the bucket.
    vi.spyOn(motirAiClient, 'offboardCodeGraph').mockResolvedValue(
      removed({ snapshotObjectsDeleted: 2, localRootsRemoved: 1, coordinationRowsDeleted: 1 }),
    );
    // Due relative to the REAL clock: the job handler calls `sweep()` with no
    // argument, so this is the one case that cannot pin `now`.
    await enqueueDueAt('p1', new Date(Date.now() - 60_000));

    const engine = new InngestTestEngine({ function: codeGraphOffboardSweep });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      due: 1,
      offboarded: 1,
      failed: 0,
      snapshotObjectsDeleted: 2,
      localRootsRemoved: 1,
      coordinationRowsDeleted: 1,
      remaining: 0,
    });
    expect(await allRows()).toEqual([]);

    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.functionId).toBe('system.code-graph-offboard-sweep');
    expect(run.eventName).toBe('scheduled.system.code-graph-offboard-sweep');
    expect(run.status).toBe('succeeded');
    // Untenanted, like every `system.*` job — and necessarily so here: the queue
    // spans workspaces, including ones that no longer exist.
    expect(run.workspaceId).toBeNull();
    expect(run.output).toMatchObject({ offboarded: 1, remaining: 0 });
  });
});
