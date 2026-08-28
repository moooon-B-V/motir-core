import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { Prisma } from '@/generated/prisma/client';

import { db } from '@/lib/db';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planTargetLockRepository } from '@/lib/repositories/planTargetLockRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanTargetLockedError } from '@/lib/planChange/errors';
import {
  PLANNING_STATUS_KEY,
  PLAN_TARGET_LOCK_LEASE_MS,
  leaseExpiryFrom,
} from '@/lib/planChange/targetLock';
import { planTargetLockSweep } from '@/lib/jobs/definitions/planTargetLockSweep';
import { jobDefinitions } from '@/lib/jobs/registry';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// planTargetLockService — the `planning` status lock (Story MOTIR-2786 ·
// MOTIR-2787) against a REAL Postgres, which is the only place a claim about a
// lock, a transaction or a race can be proved.
//
// What these prove, per the card's acceptance criteria:
//   1. opening a session moves every target in the scope to `planning`, in ONE
//      transaction with the session write;
//   2. a second session whose scope OVERLAPS a held item is refused with a typed
//      error naming the item and the holder — under GENUINE contention, in a
//      loop, not two sequential calls;
//   3. the hand-off releases upward and acquires downward atomically;
//   4. release runs on every terminal path the product actually has;
//   5. a stale lease is recoverable with no database edit;
//   6. the prior status is RESTORED, asserted from `in_progress` and not only
//      from `todo`;
//   7. the `category: 'in_progress'` consequence is checked where it bites — the
//      dispatch pick.
//
// ⚠️ THE CONCURRENCY CASES RUN IN A LOOP. Which racer loses is timing, and the
// two losing paths are not equally likely: the row lock catches most, the unique
// index the rest. A single round tests whichever path fired that morning
// (`cant-lock-an-empty-set`). Five rounds with a fresh precondition each time
// exercise the FIRST race every round, which is the one that matters.

let fx: WorkItemFixture;

/**
 * Create an item through the SERVICE, not the repository fixture.
 *
 * ⚠️ `createTestWorkItem` inserts at the repository edge, so the row keeps
 * `work_item.status`'s Prisma DEFAULT — the literal `"open"`, which is not a
 * member of any project's workflow. Every assertion here is about status
 * transitions, and an item whose current status has no `workflow_status` row
 * cannot legally move ANYWHERE: `canTransition` resolves the from-key to null and
 * answers false, so a lock built on that fixture would silently record
 * `statusHeld: false` for every case and prove nothing. The service create is
 * what seeds the workflow's real INITIAL status.
 */
async function makeItem(kind: 'epic' | 'story', title: string, parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, parentId: parentId ?? null },
    fx.ctx,
  );
}

/** A session row to hang leases off. The lock's subject is the ITEM, so these
 *  tests build sessions directly rather than through the conversation service —
 *  the wiring is asserted separately, at the bottom. */
async function makeSession(scopeKey: string, targetKeys: string[]) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    planChangeSessionRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        scopeKey,
        targetKeys,
      },
      tx,
    ),
  );
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    workItemRepository.findById(workItemId, tx),
  );
  return row!.status;
}

async function lockRow(workItemId: string) {
  return withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planTargetLockRepository.findByWorkItemId(workItemId, tx),
  );
}

/** Force a lease into the past — the shape a crashed planner leaves behind. This
 *  is the ONLY database edit in these tests, and it is standing in for the
 *  passage of thirty minutes, not for the recovery itself: the recovery under
 *  test is the shipped sweep, which is given no help at all. */
async function ageLease(workItemId: string, by: number) {
  const lock = await lockRow(workItemId);
  await adminDb.planTargetLock.update({
    where: { id: lock!.id },
    data: { expiresAt: new Date(Date.now() - by) },
  });
}

const ctxFor = (f: WorkItemFixture) => ({
  userId: f.ownerId,
  workspaceId: f.workspaceId,
  projectId: f.projectId,
});

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('acquire', () => {
  it('moves every target in the scope to `planning` and records the prior status', async () => {
    const epic = await makeItem('epic', 'Billing');
    const story = await makeItem('story', 'Invoices');
    const session = await makeSession('A', [epic.identifier, story.identifier]);

    const outcomes = await planTargetLockService.acquireForScope(
      session.id,
      [epic.identifier, story.identifier],
      ctxFor(fx),
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.disposition === 'acquired')).toBe(true);
    expect(outcomes.every((o) => o.statusHeld)).toBe(true);
    expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);

    const lock = await lockRow(epic.id);
    expect(lock).toMatchObject({
      sessionId: session.id,
      heldById: fx.ownerId,
      priorStatus: 'todo',
      statusHeld: true,
    });
  });

  it('is idempotent for the holding session — a re-open REFRESHES the lease', async () => {
    const epic = await makeItem('epic', 'Billing');
    const session = await makeSession('A', [epic.identifier]);
    const early = new Date(Date.now() - 60_000);

    await planTargetLockService.acquireForScope(session.id, [epic.identifier], ctxFor(fx), early);
    const first = await lockRow(epic.id);
    const again = await planTargetLockService.acquireForScope(
      session.id,
      [epic.identifier],
      ctxFor(fx),
    );

    expect(again[0]!.disposition).toBe('refreshed');
    const second = await lockRow(epic.id);
    expect(second!.expiresAt.getTime()).toBeGreaterThan(first!.expiresAt.getTime());
    // The status was moved ONCE. A refresh must not re-derive `priorStatus` from
    // the item's current status, or the item would remember `planning` as the
    // place to go back to and the release would strand it.
    expect(second!.priorStatus).toBe('todo');
  });

  it('LOCKS an item it cannot legally move, and says it did not move it', async () => {
    // `in_review` has no edge to `planning` in the default workflow. The item is
    // still a legitimate subject for a planning conversation, so the exclusion
    // must hold — it is the ROW, not the status.
    const story = await makeItem('story', 'Invoices');
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);

    const session = await makeSession('A', [story.identifier]);
    const [outcome] = await planTargetLockService.acquireForScope(
      session.id,
      [story.identifier],
      ctxFor(fx),
    );

    expect(outcome!.statusHeld).toBe(false);
    expect(await statusOf(story.id)).toBe('in_review');
    expect(await lockRow(story.id)).not.toBeNull();

    // …and the exclusion is real even though no status moved.
    const other = await makeSession('B', [story.identifier]);
    await expect(
      planTargetLockService.acquireForScope(other.id, [story.identifier], ctxFor(fx)),
    ).rejects.toBeInstanceOf(PlanTargetLockedError);
  });

  it('does NOT disturb an item parked at `planning` by hand (MOTIR-2425)', async () => {
    // A card an agent parked for re-planning has no lease. Acquiring on it is
    // legitimate — a planning conversation is exactly what it is waiting for —
    // but nothing about it may be treated as this lock's doing, so releasing must
    // leave it where the human put it.
    const story = await makeItem('story', 'Invoices');
    await workItemsService.updateStatus(story.id, PLANNING_STATUS_KEY, fx.ctx);

    const session = await makeSession('A', [story.identifier]);
    const [outcome] = await planTargetLockService.acquireForScope(
      session.id,
      [story.identifier],
      ctxFor(fx),
    );
    expect(outcome!.statusHeld).toBe(false);

    await planTargetLockService.releaseForSession(session.id, ctxFor(fx));
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('does nothing at all for the PROJECT-WIDE scope', async () => {
    // The shipped 7.30 thread is anchored at no items (`scopeKey === ''`), so it
    // has nothing to hold. It must stay free rather than being made to mean "the
    // whole project is locked", which is precisely the per-project serialization
    // MOTIR-2780 rejected.
    const session = await makeSession('', []);
    await expect(
      planTargetLockService.acquireForScope(session.id, [], ctxFor(fx)),
    ).resolves.toEqual([]);
    await expect(
      planTargetLockService.handOff(session.id, { release: [], acquire: [] }, ctxFor(fx)),
    ).resolves.toEqual([]);
  });

  it('refuses without a name when the holder has been deleted', async () => {
    // `held_by_id` is SetNull, so a live lease can outlive its owner. The refusal
    // still has to happen — an unnamed holder is not an absent one.
    const epic = await makeItem('epic', 'Billing');
    const a = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(a.id, [epic.identifier], ctxFor(fx));
    await adminDb.planTargetLock.updateMany({ data: { heldById: null } });

    const b = await makeSession('B', [epic.identifier, 'PROD-999']);
    const err = await planTargetLockService
      .acquireForScope(b.id, [epic.identifier], ctxFor(fx))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanTargetLockedError);
    expect((err as PlanTargetLockedError).holderName).toBeNull();
  });

  it('skips an identifier that names nothing', async () => {
    const session = await makeSession('A', ['PROD-999']);
    await expect(
      planTargetLockService.acquireForScope(session.id, ['PROD-999'], ctxFor(fx)),
    ).resolves.toEqual([]);
  });
});

describe('the race', () => {
  it('gives ONE of two genuinely concurrent overlapping scopes the item, and names the holder to the other', async () => {
    // Five rounds, fresh precondition each time: which racer loses is timing, and
    // the two losing paths (the row lock, the unique index) are not equally
    // likely. One round tests whichever fired today.
    for (let round = 0; round < 5; round += 1) {
      await truncateAuthTables();
      fx = await makeWorkItemFixture();
      const epic = await makeItem('epic', `Billing ${round}`);
      const other = await makeItem('story', `Invoices ${round}`);

      // OVERLAPPING, not identical: `[epic]` and `[epic, other]` are two different
      // scope keys naming one common item. Identical scopes RESUME one thread by
      // design, so they are not the case the lock exists for — this is.
      const a = await makeSession('A', [epic.identifier]);
      const b = await makeSession('B', [epic.identifier, other.identifier]);

      const results = await Promise.allSettled([
        planTargetLockService.acquireForScope(a.id, [epic.identifier], ctxFor(fx)),
        planTargetLockService.acquireForScope(
          b.id,
          [epic.identifier, other.identifier],
          ctxFor(fx),
        ),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won, `round ${round}: exactly one holder`).toHaveLength(1);
      expect(lost).toHaveLength(1);

      const err = (lost[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(PlanTargetLockedError);
      // It NAMES the item and the holder. "Planning is locked" with no subject is
      // an error a user cannot act on: with a multi-anchor scope they do not know
      // WHICH target is taken, and with no holder they do not know whom to ask.
      expect(err.targetIdentifier).toBe(epic.identifier);
      expect(err.holderName).toBe(fx.owner.name);
      expect(err.expiresAt).toBeInstanceOf(Date);
      expect(err.message).toContain(epic.identifier);
      expect(err.message).toContain(fx.owner.name);

      // Exactly one lease exists for the contended item.
      const rows = await adminDb.planTargetLock.findMany({ where: { workItemId: epic.id } });
      expect(rows).toHaveLength(1);
    }
  });

  it('acquires a multi-target scope ALL-OR-NOTHING', async () => {
    const held = await makeItem('epic', 'Billing');
    const free = await makeItem('story', 'Invoices');
    const holder = await makeSession('A', [held.identifier]);
    await planTargetLockService.acquireForScope(holder.id, [held.identifier], ctxFor(fx));

    const b = await makeSession('B', [free.identifier, held.identifier]);
    await expect(
      planTargetLockService.acquireForScope(b.id, [free.identifier, held.identifier], ctxFor(fx)),
    ).rejects.toBeInstanceOf(PlanTargetLockedError);

    // A partial acquire would leave B holding half a scope it cannot name, and
    // would make the refusal depend on which anchor happened to sort first.
    expect(await lockRow(free.id)).toBeNull();
    expect(await statusOf(free.id)).toBe('todo');
  });
});

describe('the hand-off', () => {
  it('releases the epic and acquires the story in ONE transaction', async () => {
    const epic = await makeItem('epic', 'Billing');
    const story = await makeItem('story', 'Invoices', epic.id);
    const session = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(session.id, [epic.identifier], ctxFor(fx));

    const outcomes = await planTargetLockService.handOff(
      session.id,
      { release: [epic.identifier], acquire: [story.identifier] },
      ctxFor(fx),
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.identifier).toBe(story.identifier);
    // The epic is back in the pickable set; the story now carries the lock.
    expect(await statusOf(epic.id)).toBe('todo');
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);
    expect(await lockRow(epic.id)).toBeNull();
    expect(await lockRow(story.id)).not.toBeNull();
  });

  it('leaves a SIBLING story free while one is being expanded', async () => {
    // The case per-project serialization would have broken, and the reason
    // MOTIR-2780 rejected it: two people planning different stories of one
    // project is ordinary use.
    const epic = await makeItem('epic', 'Billing');
    const one = await makeItem('story', 'One', epic.id);
    const two = await makeItem('story', 'Two', epic.id);

    const a = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(a.id, [epic.identifier], ctxFor(fx));
    await planTargetLockService.handOff(
      a.id,
      { release: [epic.identifier], acquire: [one.identifier] },
      ctxFor(fx),
    );

    const b = await makeSession('B', [two.identifier]);
    await expect(
      planTargetLockService.acquireForScope(b.id, [two.identifier], ctxFor(fx)),
    ).resolves.toHaveLength(1);
    expect(await statusOf(two.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('refuses to release a lease another session holds', async () => {
    const epic = await makeItem('epic', 'Billing');
    const a = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(a.id, [epic.identifier], ctxFor(fx));

    const b = await makeSession('B', [epic.identifier, 'PROD-999']);
    await expect(
      planTargetLockService.handOff(b.id, { release: [epic.identifier], acquire: [] }, ctxFor(fx)),
    ).resolves.toEqual([]);
    // A hand-off that could release someone else's lock would be a way AROUND the
    // exclusion rather than a use of it.
    expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
    expect((await lockRow(epic.id))!.sessionId).toBe(a.id);
  });
});

describe('release', () => {
  it('restores the prior status from `in_progress`, not to a hardcoded `todo`', async () => {
    // A release that assumed everything returns to `todo` would silently discard
    // real progress — and it would pass every test written from a fresh item,
    // which is exactly the sort of test people write.
    const story = await makeItem('story', 'Invoices');
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);

    const session = await makeSession('A', [story.identifier]);
    await planTargetLockService.acquireForScope(session.id, [story.identifier], ctxFor(fx));
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);

    const released = await planTargetLockService.releaseForSession(session.id, ctxFor(fx));
    expect(released).toEqual([{ workItemId: story.id, outcome: 'restored' }]);
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('treats a MANUAL move out of Planning as a manual release', async () => {
    // Nothing stops someone dragging a locked card out of the Planning column,
    // and that is a legitimate escape hatch rather than a bug — a lock whose only
    // exit is a background sweep is one a person cannot get out of. What must NOT
    // happen is writing our remembered status back over their decision.
    const story = await makeItem('story', 'Invoices');
    const session = await makeSession('A', [story.identifier]);
    await planTargetLockService.acquireForScope(session.id, [story.identifier], ctxFor(fx));

    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    const released = await planTargetLockService.releaseForSession(session.id, ctxFor(fx));

    expect(released).toEqual([{ workItemId: story.id, outcome: 'left_as_is' }]);
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(await lockRow(story.id)).toBeNull();
  });

  it('is total and idempotent — a session holding nothing releases nothing', async () => {
    const session = await makeSession('A', []);
    await expect(planTargetLockService.releaseForSession(session.id, ctxFor(fx))).resolves.toEqual(
      [],
    );
  });

  it('frees the item for the next session', async () => {
    const epic = await makeItem('epic', 'Billing');
    const a = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(a.id, [epic.identifier], ctxFor(fx));
    await planTargetLockService.releaseForSession(a.id, ctxFor(fx));

    const b = await makeSession('B', [epic.identifier, 'PROD-999']);
    await expect(
      planTargetLockService.acquireForScope(b.id, [epic.identifier], ctxFor(fx)),
    ).resolves.toHaveLength(1);
  });
});

describe('the heartbeat', () => {
  it('pushes the session lease out so a long conversation is not swept', async () => {
    const epic = await makeItem('epic', 'Billing');
    const session = await makeSession('A', [epic.identifier]);
    const long_ago = new Date(Date.now() - PLAN_TARGET_LOCK_LEASE_MS);
    await planTargetLockService.acquireForScope(
      session.id,
      [epic.identifier],
      ctxFor(fx),
      long_ago,
    );

    const moved = await planTargetLockService.refreshForSession(session.id, ctxFor(fx));
    expect(moved).toBe(1);
    expect((await lockRow(epic.id))!.expiresAt.getTime()).toBeGreaterThan(
      leaseExpiryFrom(long_ago).getTime(),
    );

    // …and the sweep now finds nothing to do.
    await expect(planTargetLockService.releaseExpired()).resolves.toEqual({
      released: 0,
      entries: [],
    });
  });
});

describe('recovery — the crashed planner', () => {
  it('releases an EXPIRED lease with no database edit, restoring the prior status', async () => {
    const story = await makeItem('story', 'Invoices');
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    const session = await makeSession('A', [story.identifier]);
    await planTargetLockService.acquireForScope(session.id, [story.identifier], ctxFor(fx));
    await ageLease(story.id, 1_000);

    const result = await planTargetLockService.releaseExpired();

    expect(result.released).toBe(1);
    expect(result.entries).toEqual([{ workItemId: story.id, outcome: 'restored' }]);
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(await lockRow(story.id)).toBeNull();
  });

  it('lets a NEW session take an item whose holder has gone silent', async () => {
    // The user-facing shape of the same thing: a stuck epic must not need an
    // operator. A competing acquire reclaims an expired lease directly, without
    // waiting for the sweep to come round.
    const epic = await makeItem('epic', 'Billing');
    const dead = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(dead.id, [epic.identifier], ctxFor(fx));
    await ageLease(epic.id, 1_000);

    const live = await makeSession('B', [epic.identifier, 'PROD-999']);
    const [outcome] = await planTargetLockService.acquireForScope(
      live.id,
      [epic.identifier],
      ctxFor(fx),
    );

    expect(outcome!.disposition).toBe('reclaimed');
    expect((await lockRow(epic.id))!.sessionId).toBe(live.id);
    // The RECLAIM inherits the dead session's `priorStatus`. Recomputing it would
    // read `planning` — the state the dead lease itself caused — and the item
    // would be stranded there forever by the very release meant to free it.
    expect((await lockRow(epic.id))!.priorStatus).toBe('todo');
    await planTargetLockService.releaseForSession(live.id, ctxFor(fx));
    expect(await statusOf(epic.id)).toBe('todo');
  });

  it('leaves a LIVE lease alone', async () => {
    const epic = await makeItem('epic', 'Billing');
    const session = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(session.id, [epic.identifier], ctxFor(fx));

    await expect(planTargetLockService.releaseExpired()).resolves.toEqual({
      released: 0,
      entries: [],
    });
    expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('bounds one pass', async () => {
    const items = await Promise.all([0, 1, 2].map((n) => makeItem('story', `S${n}`)));
    const session = await makeSession(
      'A',
      items.map((i) => i.identifier),
    );
    await planTargetLockService.acquireForScope(
      session.id,
      items.map((i) => i.identifier),
      ctxFor(fx),
    );
    for (const item of items) await ageLease(item.id, 1_000);

    const first = await planTargetLockService.releaseExpired(new Date(), 2);
    expect(first.released).toBe(2);
    const second = await planTargetLockService.releaseExpired(new Date(), 2);
    expect(second.released).toBe(1);
  });

  it('leaves a lease the session gave back between the scan and the release', async () => {
    // The rows are chosen from a snapshot taken in a DIFFERENT transaction, so a
    // session can release in between. A sweep that deleted on that stale read
    // would raise P2025 on a lease somebody already handed back — so the release
    // re-reads under the transaction that acts.
    const epic = await makeItem('epic', 'Billing');
    const session = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(session.id, [epic.identifier], ctxFor(fx));
    await ageLease(epic.id, 1_000);
    const stale = (await lockRow(epic.id))!;

    await planTargetLockService.releaseForSession(session.id, ctxFor(fx));

    // Hand the sweep the row it would have read a moment earlier.
    const spy = vi
      .spyOn(planTargetLockRepository, 'listExpired')
      .mockResolvedValueOnce([{ ...stale, expiresAt: new Date(Date.now() - 1_000) }]);
    try {
      await expect(planTargetLockService.releaseExpired()).resolves.toEqual({
        released: 1,
        entries: [{ workItemId: epic.id, outcome: 'left_as_is' }],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('still drops a lease it cannot attribute to anyone', async () => {
    // A lease whose holder was deleted, in a workspace with no resolvable owner.
    // Leaving the row would preserve a permanently unplannable item in order to
    // protect a status change nobody can sign — the wrong way round.
    const epic = await makeItem('epic', 'Billing');
    const session = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(session.id, [epic.identifier], ctxFor(fx));
    await ageLease(epic.id, 1_000);
    await adminDb.planTargetLock.updateMany({ data: { heldById: null } });
    await adminDb.workspaceMembership.deleteMany({ where: { workspaceId: fx.workspaceId } });

    const result = await planTargetLockService.releaseExpired();

    expect(result.entries).toEqual([{ workItemId: epic.id, outcome: 'unattributable' }]);
    expect(await lockRow(epic.id)).toBeNull();
  });

  it('runs as the scheduled job, end to end', async () => {
    // `jobDefinitions` is what `app/api/inngest/route.ts` serves — a sweep absent
    // from it never runs, and the whole recovery story is that cron line. Driving
    // the real function in-process proves the wiring too: the registry entry, the
    // services bag, and the handler's own step.
    expect(jobDefinitions).toContain(planTargetLockSweep);

    const epic = await makeItem('epic', 'Billing');
    const session = await makeSession('A', [epic.identifier]);
    await planTargetLockService.acquireForScope(session.id, [epic.identifier], ctxFor(fx));
    await ageLease(epic.id, 1_000);

    const engine = new JobTestEngine({ function: planTargetLockSweep });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ released: 1 });
    expect(await statusOf(epic.id)).toBe('todo');
    expect(await lockRow(epic.id)).toBeNull();
  });
});

describe('the unique index — the backstop under the row lock', () => {
  // Acquire locks the work item row first, so in practice the racer waits and
  // reads the winner's lease rather than colliding on the insert. That makes the
  // `work_item_id` unique a BACKSTOP, and a backstop nothing exercises is a
  // guess: the constraint still fires for a writer that reached the insert from a
  // connection holding an older snapshot, and what must never happen is a raw
  // Prisma P2002 escaping the service.
  //
  // Its value was measured, not assumed. Deleting the row lock and re-running the
  // race left the exclusion INTACT — this path caught it — but the refusal lost
  // the holder's name, because a unique violation knows nothing about who won.
  // So the two guards are not redundant: the index keeps the exclusion, the lock
  // makes the refusal say something a person can act on.
  it('translates a unique violation into the typed refusal', async () => {
    const epic = await makeItem('epic', 'Billing');
    const session = await makeSession('A', [epic.identifier]);
    const spy = vi.spyOn(planTargetLockRepository, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    try {
      const err = await planTargetLockService
        .acquireForScope(session.id, [epic.identifier], ctxFor(fx))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlanTargetLockedError);
      expect((err as PlanTargetLockedError).targetIdentifier).toBe(epic.identifier);
    } finally {
      spy.mockRestore();
    }
  });

  it('rethrows anything that is NOT a lost race', async () => {
    // A translation that swallowed every write failure would report "someone else
    // is planning this" for a disk error.
    const epic = await makeItem('epic', 'Billing');
    const session = await makeSession('A', [epic.identifier]);
    const boom = new Error('connection reset');
    const spy = vi.spyOn(planTargetLockRepository, 'create').mockRejectedValueOnce(boom);
    try {
      await expect(
        planTargetLockService.acquireForScope(session.id, [epic.identifier], ctxFor(fx)),
      ).rejects.toBe(boom);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the refusal itself', () => {
  it('reads sensibly when the holder cannot be named', () => {
    // `heldById` is SetNull, so a lease can outlive its owner — which is one of
    // the cases the sweep exists for. The message still has to be a sentence a
    // person can act on, and the expiry is what makes it one.
    const at = new Date('2026-08-17T20:00:00.000Z');
    const err = new PlanTargetLockedError('PROD-7', null, at);
    expect(err.code).toBe('PLAN_TARGET_LOCKED');
    expect(err.message).toContain('PROD-7');
    expect(err.message).toContain('another session');
    expect(err.message).toContain(at.toISOString());
  });
});

describe('the `in_progress` category consequence', () => {
  it('takes a held item OUT of the dispatch claim', async () => {
    // `planning` is `category: 'in_progress'`, and `claimNextReadyCandidate`
    // admits a row only while `ws.category = 'todo'`. So a held item leaves the
    // pickable set STRUCTURALLY — nothing special-cases it. That is MOTIR-2425's
    // design and this lock inherits it; the assertion is here so a future
    // recategorization of `planning` fails against the LOCK as well as against
    // the re-plan flow, which is the half a reader of either card alone would
    // not think to check.
    const story = await makeItem('story', 'Invoices');
    const claimable = () =>
      withWorkspaceContext(fx.ctx, (tx) =>
        workItemRepository.claimNextReadyCandidate([story.id], tx),
      );

    expect(await claimable()).toEqual({ id: story.id });

    const session = await makeSession('A', [story.identifier]);
    await planTargetLockService.acquireForScope(session.id, [story.identifier], ctxFor(fx));

    expect(await claimable()).toBeNull();

    // …and it comes back the moment the lock does.
    await planTargetLockService.releaseForSession(session.id, ctxFor(fx));
    expect(await claimable()).toEqual({ id: story.id });
  });
});
