import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { DispatchRunCardsBusyError } from '@/lib/dispatchRuns/errors';
import { RUN_LIVENESS_SWEEP_CRON } from '@/lib/jobs/definitions/runLivenessSweep';
import { RUN_HEARTBEAT_LAPSE_MS } from '@/lib/runs/runLiveness';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';

// A RUN'S DEATH MOVES THE CARD'S TO FIX REASON (Story MOTIR-6590 · MOTIR-6881), over
// real Postgres.
//
// What is under test: the recompute hangs on the two operations every run passes
// through — `openWithin` and `closeWithin` — so every way a run ends puts `run_died` on
// its cards and every way a new run starts takes it off, without a trigger per caller.
// And the lock order that change needed: a close takes the covered cards BEFORE the
// run, the order the continue claim already takes them in, so the lapse sweep racing a
// claim on one card never deadlocks.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function reasonOf(workItemId: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return { fixReason: row.fixReason, fixDetail: row.fixDetail as Record<string, unknown> | null };
}

async function inProgressCard(fx: WorkItemFixture) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(card.id, 'in_progress');
  return card;
}

/** Open a local `motir run` over `card` that has pushed a branch. */
async function runOn(
  fx: WorkItemFixture,
  card: { identifier: string },
  opts: { origin?: 'local' | 'hosted' } = {},
) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      origin: opts.origin ?? 'local',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'checkout_ready',
        workItemKey: card.identifier,
        disposition: 'running',
        data: { branch: `subtask/${card.identifier}-work` },
      },
    ],
    fx.ctx,
  );
  return run.id;
}

/** Make a local run's last heartbeat older than the lapse window. */
async function lapse(runId: string, agoMs = RUN_HEARTBEAT_LAPSE_MS + 60_000) {
  await adminDb.dispatchRun.update({
    where: { id: runId },
    data: { lastHeartbeatAt: new Date(Date.now() - agoMs) },
  });
}

describe('close — every way a run ends puts run_died on its card', () => {
  it.each([
    ['interrupted', { stopReason: 'interrupted' as const }],
    ['failed', { stopReason: 'halted' as const }],
    ['cancelled', { stopReason: 'gated' as const, status: 'cancelled' as const }],
  ])('a local run closed %s', async (_label, input) => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const runId = await runOn(fx, card);
    expect((await reasonOf(card.id)).fixReason).toBeNull();

    await dispatchRunService.close(runId, input, fx.ctx);

    const stored = await reasonOf(card.id);
    expect(stored.fixReason).toBe('run_died');
    expect(stored.fixDetail).toMatchObject({
      repair: 'continue',
      continueKey: card.identifier,
      branch: `subtask/${card.identifier}-work`,
      pushed: true,
    });
  });

  it('a close that FINISHED the work leaves the card off To fix', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const runId = await runOn(fx, card);

    await dispatchRunService.close(runId, { stopReason: 'completed' }, fx.ctx);

    expect((await reasonOf(card.id)).fixReason).toBeNull();
  });

  it('the lapse sweep closes a silent local run abandoned — its card reads run_died at the first pass after it lapses', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const runId = await runOn(fx, card);
    await lapse(runId, RUN_HEARTBEAT_LAPSE_MS + 60_000);

    const summary = await dispatchRunSweepService.reapLapsed(new Date());

    expect(summary.runsReaped).toBe(1);
    expect(await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    expect(await reasonOf(card.id)).toMatchObject({
      fixReason: 'run_died',
      fixDetail: { diedReason: 'lapsed' },
    });
  });

  it('the age reap closes a run past its hours — its card reads run_died', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const runId = await runOn(fx, card, { origin: 'hosted' });
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { startedAt: new Date(Date.now() - 48 * 60 * 60_000) },
    });

    const summary = await dispatchRunSweepService.sweep(new Date());

    expect(summary.runsReaped).toBe(1);
    expect((await reasonOf(card.id)).fixReason).toBe('run_died');
  });

  it('a hosted run’s end closes it through the same path — its card reads run_died', async () => {
    // The revocations call out; every one of them answering "failed" is still an end.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const runId = await runOn(fx, card, { origin: 'hosted' });

    const ended = await hostedRunService.endHostedRun(runId, 'failed', 'agent exited 1');

    expect(ended.closed).toBe(true);
    expect((await reasonOf(card.id)).fixReason).toBe('run_died');
  });

  it('a PARENT run’s close recomputes the scope card and every leg — a leg continues with its parent', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    await setStatus(story.id, 'in_progress');
    const legs = [];
    for (const title of ['leg one', 'leg two']) {
      const leg = await createTestWorkItem(fx, { kind: 'subtask', title, parentId: story.id });
      await setStatus(leg.id, 'in_progress');
      legs.push(leg);
    }
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        scopeKey: story.identifier,
        cards: legs.map((l) => ({ key: l.identifier, disposition: 'queued' as const })),
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'checkout_ready',
          workItemKey: legs[0]!.identifier,
          disposition: 'running',
          data: { branch: `session/${story.identifier}` },
        },
      ],
      fx.ctx,
    );

    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);

    for (const leg of legs) {
      expect(await reasonOf(leg.id)).toMatchObject({
        fixReason: 'run_died',
        fixDetail: { repair: 'continue', continueKey: story.identifier },
      });
    }
    expect(await reasonOf(story.id)).toMatchObject({
      fixReason: 'run_died',
      fixDetail: { continueKey: story.identifier },
    });
  });
});

describe('open — a new run on a dead run’s card takes it off To fix', () => {
  it.each(['run', 'fix'] as const)(
    '`motir %s` again clears run_died in the open',
    async (command) => {
      const fx = await makeWorkItemFixture();
      const card = await inProgressCard(fx);
      const dead = await runOn(fx, card);
      await dispatchRunService.close(dead, { stopReason: 'interrupted' }, fx.ctx);
      expect((await reasonOf(card.id)).fixReason).toBe('run_died');

      await dispatchRunService.open(
        {
          projectKey: fx.projectIdentifier,
          command,
          cards: [{ key: card.identifier, disposition: 'queued' }],
        },
        fx.ctx,
      );

      expect((await reasonOf(card.id)).fixReason).toBeNull();
    },
  );

  it('a hosted open clears it too', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const dead = await runOn(fx, card);
    await dispatchRunService.close(dead, { stopReason: 'interrupted' }, fx.ctx);

    await runOn(fx, card, { origin: 'hosted' });

    expect((await reasonOf(card.id)).fixReason).toBeNull();
  });
});

describe('continue — the claim clears it, and a continue run that dies puts it back', () => {
  it('claimContinue on a lapsed run: the reason clears in the claim’s commit, through close and open alone', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const dead = await runOn(fx, card);
    await lapse(dead);
    // The sweep has not run, so the record still says running — and the stored
    // reason has not been written yet. The claim is the first writer.
    expect((await reasonOf(card.id)).fixReason).toBeNull();

    const claimed = await workItemContinueService.claimContinue(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );

    expect(claimed.outcome).toBe('claimed');
    expect((await reasonOf(card.id)).fixReason).toBeNull();
    expect(await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dead } })).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });

    // The continue run dies too: the card is back on To fix.
    await dispatchRunService.close(claimed.runId!, { stopReason: 'interrupted' }, fx.ctx);
    expect(await reasonOf(card.id)).toMatchObject({
      fixReason: 'run_died',
      fixDetail: { continueKey: card.identifier },
    });
  });

  it('claimContinue on a run already recorded dead clears the stored run_died', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const dead = await runOn(fx, card);
    await dispatchRunService.close(dead, { stopReason: 'interrupted' }, fx.ctx);
    expect((await reasonOf(card.id)).fixReason).toBe('run_died');

    const claimed = await workItemContinueService.claimContinue(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );

    expect(claimed.outcome).toBe('claimed');
    expect((await reasonOf(card.id)).fixReason).toBeNull();
  });
});

describe('a heartbeat recomputes nothing', () => {
  it('leaves a stale stored reason exactly as it was', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const runId = await runOn(fx, card);
    // Plant an answer no recompute would give for a live run: if the heartbeat
    // recomputed, it would be cleared.
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { fixReason: 'run_died', fixDetail: { repair: 'continue' } },
    });
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });

    await dispatchRunService.heartbeat(runId, fx.ctx);

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.fixReason).toBe('run_died');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe('the sweeps never wait on a card lock', () => {
  it('a sweep close backs off, typed, when another transaction holds a covered card — and closes nothing', async () => {
    await warmPool();
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const runId = await runOn(fx, card);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
      async (tx) => {
        await workItemRepository.lockById(card.id, tx);
        locked();
        await held;
      },
    );
    await isLocked;

    await expect(
      dispatchRunService.close(runId, { stopReason: 'abandoned' }, fx.ctx, 'skip_if_busy'),
    ).rejects.toBeInstanceOf(DispatchRunCardsBusyError);
    release();
    await holder;

    expect(await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: 'running',
    });
  });
});

describe('the lapse sweep’s schedule', () => {
  it('stays on the :00 / :30 cluster — a silent death reaches To fix within one pass', () => {
    expect(RUN_LIVENESS_SWEEP_CRON).toBe('0,30 * * * *');
  });
});

describe('REAL CONCURRENCY — the lapse sweep and a continue claim race on one card', () => {
  it('every iteration ends with the continue run open, the dead run closed and the reason clear — never a deadlock', async () => {
    await warmPool();
    const fx = await makeWorkItemFixture();
    const outcomes = { claimClosed: 0, sweepClosed: 0 };

    for (let i = 0; i < 20; i += 1) {
      const card = await inProgressCard(fx);
      const dead = await runOn(fx, card);
      await lapse(dead);

      // Two connections, started together. The claim does more reading before its
      // first lock than the sweep does, so an unstaggered start lets the sweep win
      // every time; a stagger that grows across the iterations hands the claim the
      // lead in the later ones, so BOTH orders are exercised, not only one.
      const stagger = (i % 5) * 10;
      const [sweep, claim] = await Promise.all([
        new Promise((resolve) => setTimeout(resolve, stagger)).then(() =>
          dispatchRunSweepService.reapLapsed(new Date()),
        ),
        workItemContinueService.claimContinue(fx.projectId, card.identifier, fx.ctx),
      ]);

      // Neither writer surfaced an error: a deadlock would be a failed reap
      // (`runsFailed`) or a rejected claim.
      expect(sweep.runsFailed).toBe(0);
      expect(claim.outcome).toBe('claimed');
      if (sweep.runsReaped === 1) outcomes.sweepClosed += 1;
      else {
        expect(sweep.runsRacedByClose).toBe(1);
        outcomes.claimClosed += 1;
      }

      expect(await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dead } })).toMatchObject({
        status: 'timed_out',
        stopReason: 'abandoned',
      });
      const open = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: claim.runId! } });
      expect(open).toMatchObject({ status: 'running', command: 'continue' });
      expect((await reasonOf(card.id)).fixReason).toBeNull();
    }

    expect(outcomes.claimClosed + outcomes.sweepClosed).toBe(20);
  });
});
