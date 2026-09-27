import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { endedHow, workItemContinueService } from '@/lib/services/workItemContinueService';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { setStatus } from '../helpers/repairFixtures';

// HOW A RUN DIED, IN WORDS (Story MOTIR-6526 · MOTIR-6537) — the reason the *run
// died* marker's first line gives (`diedReason`, design D3) and the sentence the
// CONTINUE prompt hands the next agent (`endedHow`), for every way a run ends
// without succeeding. Both read the SAME row; the view is exercised over real
// Postgres because a hosted `timed_out` is split by its closing log line.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Ending = {
  status: 'running' | 'failed' | 'cancelled' | 'timed_out';
  stopReason: 'interrupted' | 'abandoned' | 'halted' | null;
  origin: 'local' | 'hosted';
  log?: string;
};

async function viewAfter(ending: Ending) {
  const fx = await makeWorkItemFixture();
  const card = await createTestWorkItem(fx, { kind: 'task', title: 'a card whose run ended' });
  await setStatus(card.id, 'in_progress');
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  if (ending.log) {
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'log', data: { message: ending.log } }],
      fx.ctx,
    );
  }
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: {
      status: ending.status,
      stopReason: ending.stopReason,
      origin: ending.origin,
      endedAt: ending.status === 'running' ? null : new Date(),
      // A running row is read as lapsed only once its heartbeat is old.
      lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
    },
  });
  return workItemContinueService.getContinueView(card.id, fx.ctx);
}

describe('the died reason (the marker’s first line)', () => {
  it.each<[string, Ending, string]>([
    [
      'a lapsed local run, not yet swept',
      { status: 'running', stopReason: null, origin: 'local' },
      'lapsed',
    ],
    ['a swept one', { status: 'timed_out', stopReason: 'abandoned', origin: 'local' }, 'lapsed'],
    ['Ctrl-C', { status: 'cancelled', stopReason: 'interrupted', origin: 'local' }, 'interrupted'],
    ['an agent error', { status: 'failed', stopReason: 'halted', origin: 'local' }, 'failed'],
    ['a cancel', { status: 'cancelled', stopReason: null, origin: 'local' }, 'cancelled'],
    [
      'the hosted 12-hour backstop',
      {
        status: 'timed_out',
        stopReason: null,
        origin: 'hosted',
        log: 'reached its 12-hour backstop',
      },
      'backstop',
    ],
    [
      'the hosted stall watchdog',
      { status: 'timed_out', stopReason: null, origin: 'hosted', log: 'no output for 15 minutes' },
      'stalled',
    ],
    [
      'a local timed_out with no reason',
      { status: 'timed_out', stopReason: null, origin: 'local' },
      'lapsed',
    ],
  ])('%s → %s', async (_label, ending, reason) => {
    const view = await viewAfter(ending);
    expect(view).toMatchObject({ state: 'died', reason });
  });
});

describe('endedHow (the CONTINUE prompt’s sentence)', () => {
  it.each<[Ending, RegExp]>([
    [{ status: 'running', stopReason: null, origin: 'local' }, /stopped reporting/],
    [{ status: 'timed_out', stopReason: 'abandoned', origin: 'local' }, /stopped reporting/],
    [
      { status: 'cancelled', stopReason: 'interrupted', origin: 'local' },
      /stopped from its terminal/,
    ],
    [{ status: 'failed', stopReason: null, origin: 'local' }, /exited with an error/],
    [{ status: 'cancelled', stopReason: null, origin: 'local' }, /was cancelled/],
    [{ status: 'timed_out', stopReason: null, origin: 'hosted' }, /hosted run stalled/],
    [{ status: 'timed_out', stopReason: null, origin: 'local' }, /ended timed_out/],
  ])('%o', (ending, sentence) => {
    expect(endedHow(ending)).toMatch(sentence);
  });
});

describe('where the work is, when no checkout was recorded (the fallbacks)', () => {
  it('a card’s leg that recorded only its SESSION branch names that branch', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'a leg of a session' });
    await setStatus(card.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'log', workItemKey: card.identifier, sessionBranch: 'motir/auto-20260927-1000' }],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    const view = await workItemContinueService.getContinueView(card.id, fx.ctx);
    expect(view).toMatchObject({ state: 'died', branch: 'motir/auto-20260927-1000' });
  });

  it('a CONTAINER, which holds no leg of its own, names the session branch its legs recorded', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'a story run as one' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'its child',
      parentId: story.id,
    });
    await setStatus(story.id, 'in_progress');
    await setStatus(child.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        scopeKey: story.identifier,
        cards: [{ key: child.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'log', workItemKey: child.identifier, sessionBranch: 'motir/auto-20260927-1100' }],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    const view = await workItemContinueService.getContinueView(story.id, fx.ctx);
    expect(view).toMatchObject({
      state: 'died',
      branch: 'motir/auto-20260927-1100',
      refusal: null,
    });
  });
});

describe('the edges', () => {
  it('a hosted timed_out with no closing log line reads as the stall watchdog', async () => {
    const view = await viewAfter({ status: 'timed_out', stopReason: null, origin: 'hosted' });
    expect(view).toMatchObject({ state: 'died', reason: 'stalled' });
  });

  it('a claim on a card nobody was assigned to names no previous assignee', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'unassigned' });
    await setStatus(card.id, 'in_progress');
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: null } });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'checkout_ready', workItemKey: card.identifier, data: { branch: 'subtask/x' } }],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    const claim = await workItemContinueService.claimContinue(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(claim).toMatchObject({ outcome: 'claimed', previousAssignee: null });
  });

  it('a view of an id that is not a work item is the ordinary not-found', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemContinueService.getContinueView('not-a-work-item', fx.ctx),
    ).rejects.toThrow();
  });
});
