import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toFixTagState } from '@/components/workItems/ToFixTag';
import { db } from '@/lib/db';
import type { FilterAst } from '@/lib/filters/ast';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { RUN_LEGACY_ALIVE_MS } from '@/lib/runs/runLiveness';
import { boardsService } from '@/lib/services/boardsService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { homeService } from '@/lib/services/homeService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workItemFixReasonBackfillService } from '@/lib/services/workItemFixReasonBackfillService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { setProjectAccess } from '@/tests/helpers/projectAccess';
import { homePageItems } from '../helpers/homePage';

// THE STORY GATE for a dead run on To fix (Story MOTIR-6590 · MOTIR-6883), on a real
// Postgres, through the real services.
//
// Each sibling tests its own link with the others held still: the derivation
// (MOTIR-6880), the recompute on open / close / claim (MOTIR-6881), the row
// (MOTIR-6882). What only this tier sees is a RUN travelling the whole chain — it is
// opened, it dies by one of the ways a run dies, the writer recomputes, the reader's
// Workbench partitions, every projection carries the value, and a continue takes it
// off again. So no case here writes `fixReason` or a run's `status`: every dead run is
// built through `dispatchRunService.open` / `close`, the two sweeps and
// `claimContinue`. The only raw writes are to a run's CLOCK (`lastHeartbeatAt`,
// `startedAt`), which is how time passes in a test, and to who a card is assigned to.
//
// The priority case (§ 31: `run_died` outranks the four pull-request reasons, each
// reached through its own GitHub event) lives with those events, in
// `toFixStoryGate.test.ts`. The hosted continue's clearing path lives with the hosted
// start's fleet stubs, in `tests/hostedRuns/hostedRunStart.test.ts`. The race between
// the lapse sweep and a claim is MOTIR-6881's own real-concurrency test
// (`tests/services/runDeathFixReason.test.ts`) and is not repeated here.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = (fx: WorkItemFixture, userId: string = fx.ownerId) => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
});

async function stored(workItemId: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return { fixReason: row.fixReason, fixDetail: row.fixDetail as Record<string, unknown> | null };
}

/** A second workspace member — the card's assignee, while the owner reported it. */
async function member(fx: WorkItemFixture, name = 'Mara S.', role: 'member' | 'viewer' = 'member') {
  const user = await createTestUser({
    email: `${name.replace(/\W/g, '').toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    name,
  });
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: fx.workspaceId,
    workspaceRole: role,
  });
  return user;
}

/** A card created the way the product creates one — in its workflow's initial status. */
const newCard = (
  fx: WorkItemFixture,
  input: { kind: 'task' | 'story'; title: string; parentId?: string },
) => workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx);

/** A card of the reader's, moved to In Progress by the product's own transition. */
async function inProgressCard(fx: WorkItemFixture, title: string, assigneeId?: string) {
  const card = await newCard(fx, { kind: 'task', title });
  await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
  if (assigneeId) {
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId } });
  }
  return card;
}

/** Open a local `motir run` over `card`; `pushed` checks out a branch first. */
async function runOn(
  fx: WorkItemFixture,
  card: { identifier: string },
  opts: { pushed?: boolean; ctx?: WorkItemFixture['ctx'] } = {},
) {
  const ctx = opts.ctx ?? fx.ctx;
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    ctx,
  );
  if (opts.pushed ?? true) {
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
      ctx,
    );
  }
  return run.id;
}

/** Let a run's clock run on: its last heartbeat, or its start, `agoMs` ago. */
const age = (runId: string, data: { lastHeartbeatAt?: Date | null; startedAt?: Date }) =>
  adminDb.dispatchRun.update({ where: { id: runId }, data });

/**
 * The `fixDetail` the continue VIEW implies for this card — the marker's own read,
 * so the row and the marker can be held to one answer (design § 31, *The row's
 * facts*).
 */
async function detailFromView(fx: WorkItemFixture, card: { id: string; identifier: string }) {
  const view = await workItemContinueService.getContinueView(card.id, fx.ctx);
  if (view.state !== 'died') throw new Error(`expected a died view, got ${view.state}`);
  const nothingPushed = view.refusal === 'no_branch';
  return {
    repair: nothingPushed ? 'none' : 'continue',
    lastHeardAt: view.deadRun.lastHeardAt,
    ranByName: view.deadRun.dispatcher?.name ?? null,
    branch: view.branch,
    branches: view.branches.map((b) => ({ repository: b.repository, branch: b.branch })),
    pushed: !nothingPushed,
    continueKey: nothingPushed ? null : (view.parentKey ?? card.identifier),
    diedReason: view.reason,
  };
}

const onToFix = async (fx: WorkItemFixture, cardId: string, userId?: string) =>
  (await homeService.listToFix(hctx(fx, userId))).items.find((r) => r.id === cardId) ?? null;
const onInProgress = async (fx: WorkItemFixture, cardId: string, userId?: string) =>
  homePageItems(await homeService.listInProgress(hctx(fx, userId))).some((r) => r.id === cardId);

describe('case 1 — every way a run dies puts its card on To fix', () => {
  const ENDINGS = [
    ['interrupted', { stopReason: 'interrupted' as const }, 'interrupted'],
    ['failed', { stopReason: 'halted' as const }, 'failed'],
    ['cancelled', { stopReason: 'gated' as const, status: 'cancelled' as const }, 'cancelled'],
    ['timed out', { stopReason: 'halted' as const, status: 'timed_out' as const }, null],
  ] as const;

  it.each(ENDINGS)(
    'a run closed %s → run_died, listed for the assignee AND the reporter, off In progress, detail = the continue view',
    async (_label, input, diedReason) => {
      const fx = await makeWorkItemFixture();
      const mara = await member(fx);
      const card = await inProgressCard(fx, 'the card', mara.id);
      const runId = await runOn(fx, card, { ctx: { ...fx.ctx, userId: mara.id } });
      const before = await homeService.tabCounts(hctx(fx, mara.id));
      expect(await onInProgress(fx, card.id, mara.id)).toBe(true);

      await dispatchRunService.close(runId, input, { ...fx.ctx, userId: mara.id });

      for (const reader of [mara.id, fx.ownerId]) {
        const row = await onToFix(fx, card.id, reader);
        expect(row?.fixReason, `listed for ${reader}`).toBe('run_died');
        expect(await onInProgress(fx, card.id, reader)).toBe(false);
      }
      const after = await homeService.tabCounts(hctx(fx, mara.id));
      expect(after.toFix).toBe(before.toFix + 1);
      expect(after.inProgress).toBe(before.inProgress - 1);

      const want = await detailFromView(fx, card);
      const { fixDetail } = await stored(card.id);
      expect(fixDetail).toMatchObject({ ...want, repair: 'continue', ranByName: 'Mara S.' });
      if (diedReason) expect(fixDetail?.['diedReason']).toBe(diedReason);
    },
  );

  it('the lapse sweep closes a silent run abandoned → run_died, diedReason lapsed', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx, 'silent');
    const runId = await runOn(fx, card);
    await age(runId, { lastHeartbeatAt: new Date(Date.now() - 30 * 60_000) });
    // Before the sweep the stored reason has not moved: nothing wrote it.
    expect((await stored(card.id)).fixReason).toBeNull();

    const summary = await dispatchRunSweepService.reapLapsed(new Date());

    expect(summary.runsReaped).toBe(1);
    expect((await onToFix(fx, card.id))?.fixReason).toBe('run_died');
    expect(await onInProgress(fx, card.id)).toBe(false);
    expect((await stored(card.id)).fixDetail).toMatchObject({
      ...(await detailFromView(fx, card)),
      diedReason: 'lapsed',
    });
  });
});

describe('case 2 — every clearing path takes it off To fix', () => {
  async function deadCard(fx: WorkItemFixture, title = 'dead') {
    const card = await inProgressCard(fx, title);
    const runId = await runOn(fx, card);
    await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);
    expect((await onToFix(fx, card.id))?.fixReason).toBe('run_died');
    return card;
  }

  it('claimContinue', async () => {
    const fx = await makeWorkItemFixture();
    const card = await deadCard(fx);
    const claim = await workItemContinueService.claimContinue(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(claim.outcome).toBe('claimed');
    expect(await onToFix(fx, card.id)).toBeNull();
    expect((await stored(card.id)).fixReason).toBeNull();
  });

  it('a new `motir run` opening on the card', async () => {
    const fx = await makeWorkItemFixture();
    const card = await deadCard(fx);
    await runOn(fx, card);
    expect(await onToFix(fx, card.id)).toBeNull();
    expect(await onInProgress(fx, card.id)).toBe(true);
  });

  it.each(['todo', 'implemented'])('a move to %s through the status transition', async (to) => {
    const fx = await makeWorkItemFixture();
    const card = await deadCard(fx);
    await workItemsService.updateStatus(card.id, to, fx.ctx);
    expect(await onToFix(fx, card.id)).toBeNull();
    expect((await stored(card.id)).fixReason).toBeNull();
  });

  it('archive', async () => {
    const fx = await makeWorkItemFixture();
    const card = await deadCard(fx);
    await workItemsService.archiveWorkItem(card.id, fx.ctx);
    expect(await onToFix(fx, card.id)).toBeNull();
    expect((await stored(card.id)).fixReason).toBeNull();
  });
});

describe('case 3 — a continue that dies puts the card back', () => {
  it('names the CONTINUING run’s dispatcher, not the first run’s', async () => {
    const fx = await makeWorkItemFixture();
    const lee = await member(fx, 'Lee K.');
    const card = await inProgressCard(fx, 'died twice');
    const first = await runOn(fx, card);
    await dispatchRunService.close(first, { stopReason: 'interrupted' }, fx.ctx);
    const leeCtx = { ...fx.ctx, userId: lee.id };

    const claim = await workItemContinueService.claimContinue(
      fx.projectId,
      card.identifier,
      leeCtx,
    );
    expect(claim.outcome).toBe('claimed');
    expect(await onToFix(fx, card.id, lee.id)).toBeNull();

    await dispatchRunService.close(claim.runId!, { stopReason: 'interrupted' }, leeCtx);

    const row = await onToFix(fx, card.id, lee.id);
    expect(row?.fixReason).toBe('run_died');
    expect(row?.fixDetail).toMatchObject({ ranByName: 'Lee K.', continueKey: card.identifier });
  });
});

describe('case 4 — the stored reason agrees with what claimContinue answers', () => {
  // run_died exactly when the claim would take the card (`claimed`) or refuse it only
  // because there is nothing pushed (`no_branch`) or the parent is the thing to
  // continue (`continue_the_parent`) — never on `run_alive`, `no_dead_run`,
  // `use_fix`, `not_in_progress`, or a continue somebody else already holds.
  type Setup = (fx: WorkItemFixture) => Promise<{ id: string; identifier: string }>;

  async function diedAt(fx: WorkItemFixture, path: string[]) {
    const card = await inProgressCard(fx, `died then ${path.join(' → ')}`);
    const runId = await runOn(fx, card);
    await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);
    for (const status of path) await workItemsService.updateStatus(card.id, status, fx.ctx);
    return card;
  }

  const MATRIX: Array<[string, Setup, 'run_died' | null, string]> = [
    [
      'alive',
      async (fx) => {
        const card = await inProgressCard(fx, 'alive');
        await runOn(fx, card);
        return card;
      },
      null,
      'run_alive',
    ],
    [
      'continuing (held by someone else)',
      async (fx) => {
        const card = await inProgressCard(fx, 'continuing');
        const runId = await runOn(fx, card);
        await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);
        const other = await member(fx, 'Lee K.');
        await workItemContinueService.claimContinue(fx.projectId, card.identifier, {
          ...fx.ctx,
          userId: other.id,
        });
        return card;
      },
      null,
      'taken',
    ],
    [
      'succeeded',
      async (fx) => {
        const card = await inProgressCard(fx, 'succeeded');
        const runId = await runOn(fx, card);
        await dispatchRunService.close(runId, { stopReason: 'completed' }, fx.ctx);
        return card;
      },
      null,
      'no_dead_run',
    ],
    ['never run', (fx) => inProgressCard(fx, 'never run'), null, 'no_dead_run'],
    ['died, pushed', (fx) => diedAt(fx, []), 'run_died', 'claimed'],
    [
      'died, nothing pushed',
      async (fx) => {
        const card = await inProgressCard(fx, 'nothing pushed');
        const runId = await runOn(fx, card, { pushed: false });
        await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);
        return card;
      },
      'run_died',
      'no_branch',
    ],
    [
      'a leg of a parent run',
      async (fx) => (await parentRun(fx)).legs[0]!,
      'run_died',
      'continue_the_parent',
    ],
    ['died, then Implemented', (fx) => diedAt(fx, ['implemented']), null, 'use_fix'],
    ['died, then In Review', (fx) => diedAt(fx, ['implemented', 'in_review']), null, 'use_fix'],
    [
      'died, then Approved',
      (fx) => diedAt(fx, ['implemented', 'in_review', 'approved']),
      null,
      'use_fix',
    ],
    ['died, then Planning', (fx) => diedAt(fx, ['planning']), null, 'not_in_progress'],
  ];

  it.each(MATRIX)('%s', async (_label, setup, reason, answer) => {
    const fx = await makeWorkItemFixture();
    const card = await setup(fx);
    expect((await stored(card.id)).fixReason).toBe(reason);

    const claim = await workItemContinueService.claimContinue(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(claim.outcome === 'not_continuable' ? claim.reason : claim.outcome).toBe(answer);
  });
});

/** A `motir run` over a story's two legs, both checked out on its session branch, then halted. */
async function parentRun(fx: WorkItemFixture) {
  const story = await newCard(fx, { kind: 'story', title: 'the story' });
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  const legs = [];
  for (const title of ['leg one', 'leg two']) {
    const leg = await newCard(fx, { kind: 'task', title, parentId: story.id });
    await workItemsService.updateStatus(leg.id, 'in_progress', fx.ctx);
    legs.push(leg);
  }
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run_scope',
      reportedBy: 'cli',
      scopeKey: story.identifier,
      cards: legs.map((l) => ({ key: l.identifier, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    legs.map((leg) => ({
      kind: 'checkout_ready' as const,
      workItemKey: leg.identifier,
      disposition: 'running' as const,
      data: { branch: `session/${story.identifier}` },
    })),
    fx.ctx,
  );
  await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);
  return { story, legs };
}

describe('case 6 — the 12-hour legacy window', () => {
  it('a local run that never heartbeat is alive at 11 h 59 m, and run_died once the age reap closes it at 12 h', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx, 'legacy CLI');
    const runId = await runOn(fx, card);
    const now = Date.now();
    await age(runId, {
      lastHeartbeatAt: null,
      startedAt: new Date(now - RUN_LEGACY_ALIVE_MS + 60_000),
    });

    // Neither sweep closes it, and the backfill — the recompute over every card —
    // finds nothing to fix: the claim would still answer `run_alive`.
    await dispatchRunSweepService.reapLapsed(new Date(now));
    await dispatchRunSweepService.sweep(new Date(now));
    const dry = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: true,
      workspaceId: fx.workspaceId,
    });
    expect(dry.byReason.run_died).toBe(0);
    expect(await onToFix(fx, card.id)).toBeNull();
    expect(await onInProgress(fx, card.id)).toBe(true);

    // Two minutes later it is past twelve hours: the age reap closes it.
    const summary = await dispatchRunSweepService.sweep(new Date(now + 2 * 60_000));
    expect(summary.runsReaped).toBe(1);
    expect((await onToFix(fx, card.id))?.fixReason).toBe('run_died');
  });
});

describe('case 7 — a parent run’s legs continue with the parent', () => {
  it('each unfinished leg is run_died with continueKey = the parent, carried by the parent’s ONE entry', async () => {
    const fx = await makeWorkItemFixture();
    const { story, legs } = await parentRun(fx);
    const page = await homeService.listToFix(hctx(fx));
    // ONE ENTRY PER DEAD RUN (MOTIR-7589; workbench § 34 retires § 31 state 3): the story
    // heads it, and every leg is a member under it rather than a row of its own.
    const entry = page.items.find((r) => r.id === story.id);
    expect(entry?.fixGroupKind).toBe('run');
    expect(page.items.filter((r) => legs.some((l) => l.id === r.id))).toEqual([]);
    for (const leg of legs) {
      const member = entry?.fixMembers.find((r) => r.id === leg.id);
      expect(member?.fixReason).toBe('run_died');
      expect(member?.fixDetail).toMatchObject({
        repair: 'continue',
        continueKey: story.identifier,
        groupKey: entry?.fixDetail?.groupKey,
      });
    }
  });
});

describe('case 8 — every projection carries the same run_died', () => {
  const runDied: FilterAst = {
    combinator: 'and',
    conditions: [{ field: 'fixReason', operator: 'is_any_of', value: ['run_died'] }],
  };

  it('the list, tree, lazy level, board, quick view, item page and the filter agree', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx, 'dead');
    const healthy = await inProgressCard(fx, 'healthy');
    const runId = await runOn(fx, card);
    await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);

    const [board, list, forest, root, filtered] = await Promise.all([
      boardsService.getBoard(fx.projectId, fx.ctx),
      workItemsService.getProjectIssuesList(fx.projectId, { sort: DEFAULT_SORT }, fx.ctx),
      workItemsService.getProjectTree(fx.projectId, {}, fx.ctx),
      workItemsService.listRootIssues(fx.projectId, { sort: DEFAULT_SORT }, fx.ctx),
      workItemsService.getProjectIssuesList(
        fx.projectId,
        { sort: DEFAULT_SORT, filter: { ast: runDied } },
        fx.ctx,
      ),
    ]);
    const peek = await workItemsService.getQuickView(
      fx.projectId,
      card.identifier,
      'workspace',
      fx.ctx,
      'en',
    );
    const detail = await workItemsService.getIssueDetail(fx.projectId, card.identifier, fx.ctx);

    expect((await stored(card.id)).fixReason).toBe('run_died');
    const boardCard = board.columns.flatMap((c) => c.cards).find((c) => c.id === card.id);
    expect(boardCard?.fixReason, 'board').toBe('run_died');
    expect(list.items.find((r) => r.id === card.id)?.fixReason, '/items list').toBe('run_died');
    expect(forest.find((n) => n.id === card.id)?.fixReason, '/items tree').toBe('run_died');
    const level = root.rows.find((r) => 'id' in r && r.id === card.id) as
      | { fixReason?: string | null }
      | undefined;
    expect(level?.fixReason, 'lazy tree level').toBe('run_died');
    expect(peek.fixReason, 'quick view').toBe('run_died');
    expect(detail.fixReason, 'item page').toBe('run_died');
    expect(detail.fixDetail).toMatchObject({ repair: 'continue', continueKey: card.identifier });
    expect(filtered.items.map((r) => r.id)).toEqual([card.id]);
    expect(filtered.items.some((r) => r.id === healthy.id)).toBe(false);
  });

  it('a done card draws nothing — the move clears the reason, and the drawing rule would too', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx, 'finished after dying');
    const runId = await runOn(fx, card);
    await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);

    await workItemsService.updateStatus(card.id, 'done', fx.ctx);

    const peek = await workItemsService.getQuickView(
      fx.projectId,
      card.identifier,
      'workspace',
      fx.ctx,
      'en',
    );
    expect(peek.fixReason).toBeNull();
    expect(toFixTagState(peek.fixReason, peek.statusCategory)).toBeNull();
    // The drawing rule holds even for a stale value on a done card.
    expect(toFixTagState('run_died', 'done')).toBeNull();
  });
});

describe('case 9 — the backfill converges', () => {
  it('a card whose run died before the deploy is counted, written once, and then left alone', async () => {
    // A run that went silent and was never swept: nothing has recomputed the card,
    // exactly the state of a card whose run died before this story deployed.
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx, 'died before deploy');
    const runId = await runOn(fx, card);
    await age(runId, { lastHeartbeatAt: new Date(Date.now() - 30 * 60_000) });
    expect((await stored(card.id)).fixReason).toBeNull();
    expect((await homeService.tabCounts(hctx(fx))).toFix).toBe(0);

    const dry = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: true,
      workspaceId: fx.workspaceId,
    });
    expect(dry.byReason.run_died).toBe(1);
    expect((await stored(card.id)).fixReason).toBeNull();

    const first = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: false,
      workspaceId: fx.workspaceId,
    });
    expect(first.failed).toEqual([]);
    expect(first.changed).toHaveLength(1);
    expect((await onToFix(fx, card.id))?.fixReason).toBe('run_died');

    const second = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: false,
      workspaceId: fx.workspaceId,
    });
    expect(second.changed).toEqual([]);
  });
});

describe('case 10 — canContinueHosted', () => {
  it('true only for a reader who may edit, and only on a dead run with a branch to continue', async () => {
    const fx = await makeWorkItemFixture();
    const viewer = await member(fx, 'Vi Ewer', 'viewer');
    const pushed = await inProgressCard(fx, 'pushed', viewer.id);
    const nothing = await inProgressCard(fx, 'nothing pushed', viewer.id);
    for (const [card, isPushed] of [
      [pushed, true],
      [nothing, false],
    ] as const) {
      const runId = await runOn(fx, card, { pushed: isPushed });
      await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);
    }

    // The owner (an editor) reported both; the viewer is assigned both. One page each.
    const editor = await homeService.listToFix(hctx(fx));
    const browser = await homeService.listToFix(hctx(fx, viewer.id));
    const flag = (page: typeof editor, id: string) =>
      page.items.find((r) => r.id === id)?.canContinueHosted;

    expect(flag(editor, pushed.id)).toBe(true);
    expect(flag(editor, nothing.id)).toBe(false);
    expect(browser.total).toBe(2);
    expect(flag(browser, pushed.id)).toBe(false);
    expect(flag(browser, nothing.id)).toBe(false);
  });
});

describe('case 11 — tenant isolation', () => {
  it('another workspace’s dead-run card is never listed, counted or found by the filter', async () => {
    const mine = await makeWorkItemFixture({ identifier: 'MIN' });
    const theirs = await makeWorkItemFixture({ identifier: 'THR' });
    const card = await inProgressCard(theirs, 'theirs');
    const runId = await runOn(theirs, card);
    await dispatchRunService.close(runId, { stopReason: 'interrupted' }, theirs.ctx);
    // Positive control: its own reader sees it.
    expect((await onToFix(theirs, card.id))?.fixReason).toBe('run_died');

    const foreign = { ...mine.ctx, projectId: theirs.projectId };
    expect((await homeService.listToFix(foreign)).total).toBe(0);
    expect((await homeService.tabCounts(foreign)).toFix).toBe(0);
    expect((await homeService.listToFix(hctx(mine))).total).toBe(0);
    const filtered = await workItemsService.getProjectIssuesList(
      mine.projectId,
      {
        sort: DEFAULT_SORT,
        filter: {
          ast: {
            combinator: 'and',
            conditions: [{ field: 'fixReason', operator: 'is_any_of', value: ['run_died'] }],
          },
        },
      },
      mine.ctx,
    );
    expect(filtered.items).toEqual([]);
  });

  it('a reader outside a private project sees no row for a dead run in it', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await member(fx, 'Out Sider');
    const card = await inProgressCard(fx, 'private', outsider.id);
    const runId = await runOn(fx, card);
    await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);
    // Positive control: while the project is open, the outsider sees their card.
    expect((await onToFix(fx, card.id, outsider.id))?.fixReason).toBe('run_died');

    await setProjectAccess(adminDb, fx.projectId, 'members');

    expect((await homeService.listToFix(hctx(fx, outsider.id))).total).toBe(0);
    expect((await homeService.tabCounts(hctx(fx, outsider.id))).toFix).toBe(0);
  });
});
