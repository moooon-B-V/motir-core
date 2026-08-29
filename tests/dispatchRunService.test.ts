import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  DispatchRunEventBodyTooLargeError,
  DispatchRunNotFoundError,
  DispatchRunTerminalError,
  UnknownDispatchRunCardError,
} from '@/lib/dispatchRuns/errors';
import {
  DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES,
  dispatchRunService,
} from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// `dispatchRunService` (Story MOTIR-1789 · MOTIR-1792) — the WRITE half of the
// run seam, against a real Postgres.
//
// The file is organised by the ACCEPTANCE CRITERIA rather than by method,
// because three of them are about a property no single method owns: the SET
// arrives whole, the close cannot be raced, and nothing here writes a work-item
// status.

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A leaf under a fresh container, created through the real service. */
async function seedItems(count: number): Promise<string[]> {
  const parent = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'story', title: 'A story a run works' },
    fixture.ctx,
  );
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const child = await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'subtask',
        parentId: parent.id,
        title: `Card ${i + 1}`,
      },
      fixture.ctx,
    );
    keys.push(child.identifier);
  }
  return keys;
}

describe('open — the SET arrives whole, at the one moment it exists', () => {
  it('persists the ordered set, including the cards it has ALREADY decided to skip', async () => {
    const [a, b, c] = await seedItems(3);

    const { run, created } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'batch',
        cards: [
          { key: a!, disposition: 'queued' },
          { key: b!, disposition: 'skipped', skipReason: 'needs_human' },
          { key: c!, disposition: 'queued' },
        ],
      },
      fixture.ctx,
    );

    expect(created).toBe(true);
    expect(run.status).toBe('running');
    expect(run.origin).toBe('local');
    expect(run.seq).toBe(0);

    // The ORDER is the run's own, stored — position 0, 1, 2 as sent.
    expect(run.cards.map((card) => [card.position, card.key])).toEqual([
      [0, a],
      [1, b],
      [2, c],
    ]);
    // ⚠️ THE SKIP AND ITS REASON. This is the fact that exists nowhere else in
    // the product: reconstructed later from per-card events it would simply be
    // absent, because nothing ever happened to this card.
    expect(run.cards[1]).toMatchObject({
      disposition: 'skipped',
      skipReason: 'needs_human',
    });
    expect(run.cards[0]!.skipReason).toBeNull();
  });

  it('handles the DEGENERATE case — one card is a set of one', async () => {
    const [only] = await seedItems(1);

    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'next',
        cards: [{ key: only!, disposition: 'queued' }],
      },
      fixture.ctx,
    );

    expect(run.command).toBe('next');
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0]).toMatchObject({ position: 0, key: only, disposition: 'queued' });
  });

  it('records the scope, its label and the agent that ran it', async () => {
    const [a] = await seedItems(1);

    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run_scope',
        scopeKey: a!,
        scopeLabel: a!,
        agent: 'claude',
        model: 'claude-opus-5',
        cards: [{ key: a!, disposition: 'queued' }],
      },
      fixture.ctx,
    );

    expect(run.scopeWorkItemId).not.toBeNull();
    expect(run.scopeLabel).toBe(a);
    expect(run.agent).toBe('claude');
    expect(run.model).toBe('claude-opus-5');
  });

  it('refuses a set naming a card this project does not have — no half a set', async () => {
    const [a] = await seedItems(1);

    await expect(
      dispatchRunService.open(
        {
          projectKey: fixture.projectIdentifier,
          command: 'batch',
          cards: [
            { key: a!, disposition: 'queued' },
            { key: `${fixture.projectIdentifier}-9999`, disposition: 'queued' },
          ],
        },
        fixture.ctx,
      ),
    ).rejects.toBeInstanceOf(UnknownDispatchRunCardError);

    // And NOTHING was written — not the run, not the one resolvable leg.
    expect(await adminDb.dispatchRun.count({ where: { workspaceId: fixture.workspaceId } })).toBe(
      0,
    );
  });

  it('is IDEMPOTENT on the key: a repeat returns the same run and no second set', async () => {
    const [a] = await seedItems(1);
    const input = {
      projectKey: fixture.projectIdentifier,
      command: 'auto' as const,
      idempotencyKey: 'run-2026-08-29-a',
      cards: [{ key: a!, disposition: 'queued' as const }],
    };

    const first = await dispatchRunService.open(input, fixture.ctx);
    const second = await dispatchRunService.open(input, fixture.ctx);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.cards).toHaveLength(1);
    expect(await adminDb.dispatchRunCard.count({ where: { dispatchRunId: first.run.id } })).toBe(1);
  });

  it('surfaces a CONCURRENT duplicate as a typed error — a P2002 never escapes', async () => {
    const [a] = await seedItems(1);
    const input = {
      projectKey: fixture.projectIdentifier,
      command: 'auto' as const,
      idempotencyKey: 'run-raced',
      cards: [{ key: a!, disposition: 'queued' as const }],
    };

    // Two opens genuinely in flight at once against a warm pool. Both may find
    // no existing run, and the unique index is then the arbiter — which is the
    // window `DuplicateDispatchRunError` exists for. EITHER outcome is legitimate
    // (the loser may also lose the READ race and get `created: false`), so the
    // assertion is on what must NEVER happen: a second run row, or a raw
    // `PrismaClientKnownRequestError` reaching the caller.
    const results = await Promise.allSettled([
      dispatchRunService.open(input, fixture.ctx),
      dispatchRunService.open(input, fixture.ctx),
    ]);

    const rejections = results.filter((r) => r.status === 'rejected');
    for (const rejection of rejections) {
      expect((rejection as PromiseRejectedResult).reason).toMatchObject({
        code: 'DUPLICATE_DISPATCH_RUN',
      });
    }
    expect(await adminDb.dispatchRun.count({ where: { idempotencyKey: 'run-raced' } })).toBe(1);
  });
});

describe('appendEvents — one transaction, a monotonic seq, and the leg moves with it', () => {
  async function openRun(cards: number): Promise<{ runId: string; keys: string[] }> {
    const keys = await seedItems(cards);
    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run_scope',
        cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
      },
      fixture.ctx,
    );
    return { runId: run.id, keys };
  }

  it('numbers a batch in order and returns the new cursor', async () => {
    const { runId, keys } = await openRun(1);

    const first = await dispatchRunService.appendEvents(
      runId,
      [
        { kind: 'run_opened' },
        { kind: 'card_claimed', workItemKey: keys[0]! },
        { kind: 'prompt_issued', workItemKey: keys[0]! },
      ],
      fixture.ctx,
    );
    expect(first.appended).toBe(3);
    expect(first.seq).toBe(3);

    const second = await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'agent_started', workItemKey: keys[0]! }],
      fixture.ctx,
    );
    expect(second.seq).toBe(4);

    const rows = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runId },
      orderBy: { seq: 'asc' },
    });
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([
      [1, 'run_opened'],
      [2, 'card_claimed'],
      [3, 'prompt_issued'],
      [4, 'agent_started'],
    ]);
    // A RUN-scoped event hangs off no leg; a CARD-scoped one does.
    expect(rows[0]!.dispatchRunCardId).toBeNull();
    expect(rows[1]!.dispatchRunCardId).not.toBeNull();
  });

  it('applies the leg’s disposition in the SAME transaction as its event', async () => {
    const { runId, keys } = await openRun(2);

    const result = await dispatchRunService.appendEvents(
      runId,
      [
        { kind: 'card_claimed', workItemKey: keys[0]!, disposition: 'running' },
        {
          kind: 'card_settled',
          workItemKey: keys[0]!,
          disposition: 'implemented',
          sessionBranch: 'motir/auto-abc',
          exitCode: 0,
        },
        {
          kind: 'card_skipped',
          workItemKey: keys[1]!,
          disposition: 'skipped',
          skipReason: 'needs_human',
        },
      ],
      fixture.ctx,
    );

    // The response carries every leg the batch moved, so a caller need not
    // re-read the run to render the change it just reported.
    expect(result.cards).toHaveLength(2);

    const legs = await adminDb.dispatchRunCard.findMany({
      where: { dispatchRunId: runId },
      orderBy: { position: 'asc' },
    });
    // A card moved TWICE in one batch lands where its LAST event says.
    expect(legs[0]).toMatchObject({
      disposition: 'implemented',
      sessionBranch: 'motir/auto-abc',
      exitCode: 0,
    });
    expect(legs[0]!.startedAt).not.toBeNull();
    expect(legs[0]!.endedAt).not.toBeNull();
    expect(legs[1]).toMatchObject({ disposition: 'skipped', skipReason: 'needs_human' });
  });

  it('clears the skip reason when a leg moves OFF skipped — the constraint holds both ways', async () => {
    const { runId, keys } = await openRun(1);

    await dispatchRunService.appendEvents(
      runId,
      [
        {
          kind: 'card_skipped',
          workItemKey: keys[0]!,
          disposition: 'skipped',
          skipReason: 'claim_refused',
        },
      ],
      fixture.ctx,
    );
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'card_claimed', workItemKey: keys[0]!, disposition: 'running' }],
      fixture.ctx,
    );

    const leg = await adminDb.dispatchRunCard.findFirst({ where: { dispatchRunId: runId } });
    expect(leg).toMatchObject({ disposition: 'running', skipReason: null });
  });

  it('refuses an event naming a card the run does not own', async () => {
    const { runId } = await openRun(1);
    const [outsider] = await seedItems(1);

    await expect(
      dispatchRunService.appendEvents(
        runId,
        [{ kind: 'card_claimed', workItemKey: outsider! }],
        fixture.ctx,
      ),
    ).rejects.toBeInstanceOf(UnknownDispatchRunCardError);
  });

  it('refuses an OVER-SIZED log body rather than truncating it', async () => {
    const { runId } = await openRun(1);

    await expect(
      dispatchRunService.appendEvents(
        runId,
        [{ kind: 'log', body: 'x'.repeat(DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES + 1) }],
        fixture.ctx,
      ),
    ).rejects.toBeInstanceOf(DispatchRunEventBodyTooLargeError);

    // Nothing was written — the whole batch is refused, not silently shortened.
    expect(await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: runId } })).toBe(0);
  });

  it('refuses an append to a run that has already closed', async () => {
    const { runId } = await openRun(1);
    await dispatchRunService.close(runId, { stopReason: 'completed' }, fixture.ctx);

    await expect(
      dispatchRunService.appendEvents(runId, [{ kind: 'log', body: 'late' }], fixture.ctx),
    ).rejects.toBeInstanceOf(DispatchRunTerminalError);
  });

  it('404s on a run in ANOTHER workspace — never a 403, and never a read', async () => {
    const { runId } = await openRun(1);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });

    await expect(
      dispatchRunService.appendEvents(runId, [{ kind: 'log', body: 'x' }], other.ctx),
    ).rejects.toBeInstanceOf(DispatchRunNotFoundError);
    await expect(dispatchRunService.getRun(runId, other.ctx)).rejects.toBeInstanceOf(
      DispatchRunNotFoundError,
    );
  });
});

describe('close — read-derived, and it LOCKS', () => {
  async function openRun(): Promise<{ runId: string; keys: string[] }> {
    const keys = await seedItems(3);
    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run_scope',
        cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
      },
      fixture.ctx,
    );
    return { runId: run.id, keys };
  }

  it('settles every leg the run left in flight, by where it was', async () => {
    const { runId, keys } = await openRun();
    await dispatchRunService.appendEvents(
      runId,
      [
        { kind: 'card_settled', workItemKey: keys[0]!, disposition: 'implemented' },
        { kind: 'card_claimed', workItemKey: keys[1]!, disposition: 'running' },
        // keys[2] stays `queued` — the run never got to it.
      ],
      fixture.ctx,
    );

    const closed = await dispatchRunService.close(runId, { stopReason: 'max' }, fixture.ctx);

    expect(closed.status).toBe('succeeded');
    expect(closed.stopReason).toBe('max');
    expect(closed.endedAt).not.toBeNull();
    expect(closed.cards.map((c) => c.disposition)).toEqual([
      // Already terminal — untouched.
      'implemented',
      // An agent was ON it and nothing ever reported an outcome. Not
      // `not_reached`, which would say the opposite of what happened.
      'failed',
      // Taken, never started.
      'not_reached',
    ]);
  });

  it('derives the status from the stop reason — and `replanned` is a SUCCESS', async () => {
    for (const [stopReason, status] of [
      ['completed', 'succeeded'],
      ['drained', 'succeeded'],
      // The row that matters most: an agent refused a card, submitted a plan and
      // exited 0. A summary calling that a failure teaches an operator to ignore
      // failures.
      ['replanned', 'succeeded'],
      ['halted', 'failed'],
      ['interrupted', 'cancelled'],
      ['abandoned', 'timed_out'],
    ] as const) {
      const { runId } = await openRun();
      const closed = await dispatchRunService.close(runId, { stopReason }, fixture.ctx);
      expect(closed.status, `${stopReason} → ${status}`).toBe(status);
    }
  });

  it('REAL CONCURRENCY: two simultaneous closes, exactly one wins', async () => {
    const { runId } = await openRun();

    // ⚠️ GENUINELY SIMULTANEOUS, against a warm pool. A serial test passes
    // WITHOUT the `FOR UPDATE` lock and proves nothing: the second close would
    // simply overwrite the first, which is the defect — a run that finished
    // cleanly recorded as `timed_out` by the reap that raced it.
    const results = await Promise.allSettled([
      dispatchRunService.close(runId, { stopReason: 'completed' }, fixture.ctx),
      dispatchRunService.close(runId, { stopReason: 'abandoned' }, fixture.ctx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DispatchRunTerminalError);

    // And the stored row is the WINNER's, whichever won — never a blend.
    const row = await adminDb.dispatchRun.findUnique({ where: { id: runId } });
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ stopReason: string | null }>).value;
    expect(row!.stopReason).toBe(winner.stopReason);
    expect(row!.status).toBe(winner.stopReason === 'abandoned' ? 'timed_out' : 'succeeded');
  });

  it('refuses a second close, and the first answer stands', async () => {
    const { runId } = await openRun();
    await dispatchRunService.close(runId, { stopReason: 'drained' }, fixture.ctx);

    await expect(
      dispatchRunService.close(runId, { stopReason: 'halted' }, fixture.ctx),
    ).rejects.toBeInstanceOf(DispatchRunTerminalError);

    const row = await adminDb.dispatchRun.findUnique({ where: { id: runId } });
    expect(row).toMatchObject({ status: 'succeeded', stopReason: 'drained' });
  });
});

describe('the boundaries — asserted, not inspected', () => {
  it('writes NO work-item status across a whole open → append → close cycle', async () => {
    const keys = await seedItems(2);
    const before = await adminDb.workItem.findMany({
      where: { identifier: { in: keys } },
      select: { identifier: true, status: true, sessionBranch: true, updatedAt: true },
      orderBy: { identifier: 'asc' },
    });

    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run_scope',
        cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
      },
      fixture.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        { kind: 'card_claimed', workItemKey: keys[0]!, disposition: 'running' },
        {
          kind: 'card_settled',
          workItemKey: keys[0]!,
          disposition: 'implemented',
          sessionBranch: 'motir/auto-xyz',
        },
        { kind: 'delivery_linked', workItemKey: keys[0]! },
      ],
      fixture.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'completed' }, fixture.ctx);

    const after = await adminDb.workItem.findMany({
      where: { identifier: { in: keys } },
      select: { identifier: true, status: true, sessionBranch: true, updatedAt: true },
      orderBy: { identifier: 'asc' },
    });

    // ⚠️ THE WHOLE ROW SET, UNCHANGED — including `sessionBranch`, which the run
    // DID record on its own leg. That pairing is the point: the run knows the
    // branch, and it still does not write it onto the card. The CLI owns every
    // transition, and a second writer here would be a duplicate write path for
    // the fact the board renders.
    expect(after).toEqual(before);
  });

  it('records the session branch on the LEG, where it belongs', async () => {
    const keys = await seedItems(1);
    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'auto',
        cards: [{ key: keys[0]!, disposition: 'queued' }],
      },
      fixture.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'card_settled',
          workItemKey: keys[0]!,
          disposition: 'integrated',
          sessionBranch: 'motir/auto-1',
        },
      ],
      fixture.ctx,
    );

    const read = await dispatchRunService.getRun(run.id, fixture.ctx);
    expect(read.cards[0]!.sessionBranch).toBe('motir/auto-1');
  });
});
