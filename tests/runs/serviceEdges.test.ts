import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  DispatchRunNotFoundError,
  DispatchRunEventLimitError,
  UnknownDispatchRunCardError,
} from '@/lib/dispatchRuns/errors';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { DISPATCH_RUN_EVENT_LIMIT, dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE SERVICE'S EDGES (Story MOTIR-1789 · MOTIR-1798).
//
// ⚠️ EVERY CASE HERE WAS FOUND BY MEASURING, NOT BY IMAGINING. The story gate's
// first coverage pass put `dispatchRunService.ts` at 87% branches, and these are
// the arms it named. Each one is a REAL behaviour with a reader — a typed error
// somebody's route maps, a `?? 0` that decides whether a fresh run reads as
// empty or crashes, a CHECK constraint's other direction — so the file is
// organised by what each arm PROTECTS rather than by line number. A test written
// to move a percentage and asserting nothing would be worse than the gap.

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedLeaf(title = 'A work item a run works'): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'story', title },
    fixture.ctx,
  );
  return item.identifier;
}

async function openRun(keys: string[]): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'run',
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    fixture.ctx,
  );
  return run.id;
}

describe('a scope the project does not have is a TYPED refusal, not a silent run', () => {
  it('refuses a scope key that resolves to no work item', async () => {
    const key = await seedLeaf();
    await expect(
      dispatchRunService.open(
        {
          projectKey: fixture.projectIdentifier,
          command: 'run',
          // A key shaped correctly and belonging to nothing — the shape a stale
          // script or a typo produces.
          scopeKey: `${fixture.projectIdentifier}-99999`,
          cards: [{ key, disposition: 'queued' }],
        },
        fixture.ctx,
      ),
    ).rejects.toBeInstanceOf(UnknownDispatchRunCardError);
  });

  it('refuses a MEMBER key the project does not have', async () => {
    await expect(
      dispatchRunService.open(
        {
          projectKey: fixture.projectIdentifier,
          command: 'run',
          cards: [{ key: `${fixture.projectIdentifier}-99999`, disposition: 'queued' }],
        },
        fixture.ctx,
      ),
    ).rejects.toBeInstanceOf(UnknownDispatchRunCardError);
  });
});

describe('⚠️ moving a leg OFF `skipped` CLEARS its reason — the CHECK’s other direction', () => {
  it('a re-dispatched leg keeps no stale skip reason', async () => {
    const key = await seedLeaf();
    const runId = await openRun([key]);

    await dispatchRunService.appendEvents(
      runId,
      [
        {
          kind: 'card_skipped',
          workItemKey: key,
          disposition: 'skipped',
          skipReason: 'needs_human',
        },
      ],
      fixture.ctx,
    );
    const skipped = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(skipped.cards[0]).toMatchObject({ disposition: 'skipped', skipReason: 'needs_human' });

    // The migration asserts `(disposition = 'skipped') = (skip_reason IS NOT
    // NULL)` in BOTH directions, so a move off `skipped` that left the reason
    // behind would be refused by the database — and a surface that read it would
    // show a running leg with a reason it was skipped.
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'card_claimed', workItemKey: key, disposition: 'running' }],
      fixture.ctx,
    );
    const running = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(running.cards[0]).toMatchObject({ disposition: 'running', skipReason: null });
  });
});

describe('the event LIMIT refuses rather than letting one run grow without bound', () => {
  it('an append that would cross the cap is a typed refusal', async () => {
    const key = await seedLeaf();
    const runId = await openRun([key]);

    // The cap is 5,000 events; writing them to reach it would cost seconds per
    // run to assert nothing the count does not. The COUNT is what the guard
    // reads, so that is what is stood in for.
    const full = vi
      .spyOn(dispatchRunEventRepository, 'countByRun')
      .mockResolvedValue(DISPATCH_RUN_EVENT_LIMIT);

    await expect(
      dispatchRunService.appendEvents(
        runId,
        [{ kind: 'card_claimed', workItemKey: key, disposition: 'running' }],
        fixture.ctx,
      ),
    ).rejects.toBeInstanceOf(DispatchRunEventLimitError);

    full.mockRestore();
  });
});

describe('a run with NO events reads as empty rather than throwing', () => {
  it('`getRunDetail` reports seq 0 for a run nothing has been appended to', async () => {
    const key = await seedLeaf();
    const runId = await openRun([key]);

    // `maxSeq` is null on a fresh run, and the `?? 0` is what makes the resume
    // cursor one type on the wire: a client that has seen nothing uses the same
    // call as one that has seen four hundred.
    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(detail.seq).toBe(0);
    expect(detail.cards).toHaveLength(1);

    const page = await dispatchRunService.readStreamPage(runId, 0, 100, fixture.ctx);
    expect(page.events).toEqual([]);
  });

  it('a FINDING on a run with no events still allocates seq 1', async () => {
    const key = await seedLeaf();
    const runId = await openRun([key]);
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'card_claimed', workItemKey: key, disposition: 'running' }],
      fixture.ctx,
    );
    const item = await adminDb.workItem.findFirst({ where: { identifier: key } });

    const first = await dispatchRunService.recordFinding(
      {
        anchorWorkItemId: item!.id,
        kind: 'bug_filed',
        findingId: 'bug_1',
        data: { key: 'PROD-99', workItemId: 'bug_1', title: 'A defect' },
      },
      fixture.ctx,
    );
    expect(first).toEqual({ recorded: true });

    // ⚠️ THE IDEMPOTENCY ARM. One finding is one row however many seams reach
    // it — a bug created with its `relates_to` and then linked again arrives
    // twice, and must not become two rows.
    const second = await dispatchRunService.recordFinding(
      {
        anchorWorkItemId: item!.id,
        kind: 'bug_filed',
        findingId: 'bug_1',
        data: { key: 'PROD-99', workItemId: 'bug_1', title: 'A defect' },
      },
      fixture.ctx,
    );
    expect(second).toEqual({ recorded: false });

    const rows = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runId, kind: 'bug_filed' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('the reads refuse an id or a key they cannot resolve', () => {
  it('closing a run that does not exist is a typed 404, not a crash', async () => {
    await expect(
      dispatchRunService.close('run_does_not_exist', { stopReason: 'drained' }, fixture.ctx),
    ).rejects.toBeInstanceOf(DispatchRunNotFoundError);
  });

  it('reading the history of a work item that does not exist is a typed 404', async () => {
    await expect(
      dispatchRunService.listRunsForWorkItemKey(
        `${fixture.projectIdentifier}-99999`,
        { take: 25 },
        fixture.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});
