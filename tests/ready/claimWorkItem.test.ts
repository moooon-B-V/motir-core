import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { runClaimWorkItem } from '@/lib/mcp/tools/claimWorkItem';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { warmPool } from '../helpers/warmPool';

// `claim_work_item` / `POST /api/v1/work-items/{key}/claim` (MOTIR-2961) — the
// ATOMIC claim of ONE NAMED work item, over real Postgres.
//
// The behaviour under test: lock the named row, re-assert the to-do CATEGORY
// under that lock, and assign + flip in ONE transaction — so two sessions
// dispatched on the SAME card cannot both start it. The concurrency tests warm
// the pool first: on a cold pool the racers share one physical connection, which
// serialises them and would pass even with the race intact.
//
// The FOUR outcomes are the deliverable as much as the lock is. A refusal that
// says only "not in `todo`" forces the loser into a second read to find out
// which of three different situations it is in — and two of them are not losses.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeItem(fx: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, assigneeId: null, descriptionMd: null },
    fx.ctx,
  );
}

/** A SECOND workspace member, so "somebody else holds it" is a real actor. */
async function otherMember(fx: WorkItemFixture): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `rival+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Rival Runner',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

async function rowOf(id: string) {
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

describe('claimWorkItem — the happy path', () => {
  it('claims a `todo` item: assigns it to the caller AND leaves it in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'claimable');

    const claim = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);

    expect(claim.outcome).toBe('claimed');
    expect(claim.claimed).toBe(true);
    expect(claim.key).toBe(item.identifier);
    expect(claim.title).toBe('claimable');
    expect(claim.status).toEqual({ key: 'in_progress', category: 'in_progress' });
    expect(claim.assignee?.id).toBe(fx.ownerId);

    // BOTH writes landed — the assignment is the half `ensureInProgress` did
    // unconditionally and unlocked, and it must survive the same transaction.
    const row = await rowOf(item.id);
    expect(row.status).toBe('in_progress');
    expect(row.assigneeId).toBe(fx.ownerId);
  });

  it('claims a `blocked` item too — the CATEGORY is what is re-asserted, not the `todo` key', async () => {
    // `--force` exists to dispatch a card whose dependencies are unmet, and such
    // a card sits at `blocked`. Keying the re-assert on the literal `todo` would
    // break that flag the day this shipped.
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'blocked but forced');
    await workItemsService.updateStatus(item.id, 'blocked', fx.ctx);

    const claim = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);

    expect(claim.outcome).toBe('claimed');
    expect((await rowOf(item.id)).status).toBe('in_progress');
  });

  it('re-claims a card that was released back to `todo` while still assigned to the caller', async () => {
    // The assignment is a LABEL and the status is the claim; they can disagree.
    // A card sent back to To Do without being unassigned is claimable again, and
    // the re-claim must not write a pointless assignment revision over a value
    // that is already correct.
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'released back');
    await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);
    await workItemsService.updateStatus(item.id, 'todo', fx.ctx);
    expect((await rowOf(item.id)).assigneeId).toBe(fx.ownerId);

    const claim = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);

    expect(claim.outcome).toBe('claimed');
    expect(claim.assignee?.id).toBe(fx.ownerId);
    expect((await rowOf(item.id)).status).toBe('in_progress');
  });

  it('names the actor and the moment of the transition it just made', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'timestamped');

    const claim = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);

    expect(claim.transitionedBy?.id).toBe(fx.ownerId);
    expect(claim.transitionedAt).not.toBeNull();
    expect(() => new Date(claim.transitionedAt as string).toISOString()).not.toThrow();
  });
});

describe('claimWorkItem — the refusal DISCRIMINATES', () => {
  it('an immediate SECOND call by another actor is `taken`, and NAMES the holder', async () => {
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const item = await makeItem(fx, 'contested');

    const first = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);
    const second = await workItemsService.claimWorkItem(
      fx.projectId,
      item.identifier,
      rival.ctx,
    );

    expect(first.outcome).toBe('claimed');
    expect(second.outcome).toBe('taken');
    expect(second.claimed).toBe(false);
    expect(second.assignee?.id).toBe(fx.ownerId);
    expect(second.transitionedBy?.id).toBe(fx.ownerId);
    // The loser's call changed nothing.
    const row = await rowOf(item.id);
    expect(row.assigneeId).toBe(fx.ownerId);
    expect(row.status).toBe('in_progress');
  });

  it('the SAME caller re-claiming their own in-progress card gets `mine`, not a failure', async () => {
    // The documented recovery: a run resuming a card its own failed agent left
    // behind. The caller proceeds.
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'resumable');

    await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);
    const again = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);

    expect(again.outcome).toBe('mine');
    expect(again.claimed).toBe(false);
    expect(again.assignee?.id).toBe(fx.ownerId);
    expect(again.status.key).toBe('in_progress');
  });

  it('an in-progress card with NO assignee is `taken` — the MOTIR-2958 shape', async () => {
    // The incident: a session flipped the status through `transition_status` and
    // never assigned. "Unassigned" is therefore evidence of nothing, and the
    // refusal has to name the winner from the status HISTORY instead.
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const item = await makeItem(fx, 'flipped, never assigned');
    await workItemsService.updateStatus(item.id, 'in_progress', rival.ctx);

    const claim = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);

    expect(claim.outcome).toBe('taken');
    expect(claim.assignee).toBeNull();
    expect(claim.transitionedBy?.id).toBe(rival.user.id);
    expect(claim.transitionedBy?.name).toBe('Rival Runner');
  });

  it.each([
    ['in_review', ['in_progress', 'in_review']],
    ['done', ['in_progress', 'in_review', 'done']],
    ['cancelled', ['cancelled']],
    ['planning', ['planning']],
    ['implemented', ['in_progress', 'implemented']],
  ] as const)(
    'a card at `%s` is `not_claimable` — a claim never re-opens finished work',
    async (terminal, hops) => {
      // `motir run <a-done-card>` used to silently reopen finished work: FIVE
      // statuses have a legal edge into `in_progress` and the CLI checked none
      // of them. Re-asserting the CATEGORY under the lock ends that.
      const fx = await makeWorkItemFixture();
      const item = await makeItem(fx, `parked at ${terminal}`);
      for (const hop of hops) await workItemsService.updateStatus(item.id, hop, fx.ctx);

      const claim = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);

      expect(claim.outcome).toBe('not_claimable');
      expect(claim.claimed).toBe(false);
      expect(claim.status.key).toBe(terminal);
      // Untouched — no transition error, no exception, and no reopened card.
      expect((await rowOf(item.id)).status).toBe(terminal);
    },
  );

  it('an ARCHIVED card is `not_claimable` even though its status is still `todo`', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'archived');
    await workItemsService.archiveWorkItem(item.id, fx.ctx);

    const claim = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);

    expect(claim.outcome).toBe('not_claimable');
    expect((await rowOf(item.id)).status).toBe('todo');
  });
});

describe('claimWorkItem — real concurrency (warm pool)', () => {
  it('N genuinely concurrent claims on ONE to-do item yield EXACTLY ONE success', async () => {
    // The property the whole card exists for. Serially this passes even with the
    // race intact — the warm pool is what makes it a test.
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'one item, six racers');
    const racers = await Promise.all(Array.from({ length: 5 }, () => otherMember(fx)));
    const contexts = [fx.ctx, ...racers.map((r) => r.ctx)];

    await warmPool(contexts.length + 2);
    const results = await Promise.all(
      contexts.map((ctx) => workItemsService.claimWorkItem(fx.projectId, item.identifier, ctx)),
    );

    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'taken')).toHaveLength(contexts.length - 1);
    // Every loser got a TYPED refusal, never a raw Prisma error — and every one
    // of them can name the winner without a second read.
    const winner = results.find((r) => r.outcome === 'claimed');
    for (const loser of results.filter((r) => r.outcome === 'taken')) {
      expect(loser.claimed).toBe(false);
      expect(loser.assignee?.id).toBe(winner?.assignee?.id);
    }

    const row = await rowOf(item.id);
    expect(row.status).toBe('in_progress');
    expect(row.assigneeId).toBe(winner?.assignee?.id);
  });

  it('the SAME caller racing itself resolves to one `claimed` and one `mine` — never two claims', async () => {
    // A dispatcher that fires twice (a retry, a double-invoked loop) must not
    // read two successes and start the work twice.
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'self race');

    await warmPool();
    const results = await Promise.all([
      workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx),
      workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx),
    ]);

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(['claimed', 'mine']);
  });
});

describe('claimWorkItem — access', () => {
  it('a key in ANOTHER workspace is refused as not-found, with no existence leak', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await makeWorkItemFixture({ name: 'Rival Co', identifier: 'ZZZ' });
    const item = await makeItem(fx, 'private');

    await expect(
      workItemsService.claimWorkItem(fx.projectId, item.identifier, outsider.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
    // Nothing was claimed on the way to the refusal.
    expect((await rowOf(item.id)).status).toBe('todo');
  });
});

describe('runClaimWorkItem — the MCP tool', () => {
  it('claims through the SAME service method and returns the claim resource', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'via mcp');

    const res = await runClaimWorkItem({ key: item.identifier.toLowerCase() }, fx.ctx);
    const sc = res.structuredContent as {
      key: string;
      outcome: string;
      claimed: boolean;
      status: { key: string; category: string };
    };

    expect(res.isError).toBeFalsy();
    expect(sc.key).toBe(item.identifier);
    expect(sc.outcome).toBe('claimed');
    expect(sc.claimed).toBe(true);
    expect(sc.status.category).toBe('in_progress');
    expect((await rowOf(item.id)).status).toBe('in_progress');
  });

  it('reports a LOST claim as an ordinary result, not an isError', async () => {
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const item = await makeItem(fx, 'lost via mcp');
    await workItemsService.claimWorkItem(fx.projectId, item.identifier, rival.ctx);

    const res = await runClaimWorkItem({ key: item.identifier }, fx.ctx);
    const sc = res.structuredContent as { outcome: string; assignee: { name: string } | null };

    expect(res.isError).toBeFalsy();
    expect(sc.outcome).toBe('taken');
    expect(sc.assignee?.name).toBe('Rival Runner');
    // The human-readable half must say NOT claimed, or a watching operator reads
    // a refusal as a success.
    expect(JSON.stringify(res.content)).toContain('NOT claimed');
  });

  it('tells a RESUMING caller to proceed, and a caller of finished work to stop', async () => {
    // The agent-facing text IS this tool's product surface: an agent that reads
    // "mine" as a loss abandons its own half-done work, and one that reads
    // "not_claimable" as a race retries against a card that is finished.
    const fx = await makeWorkItemFixture();
    const mine = await makeItem(fx, 'resume via mcp');
    await workItemsService.claimWorkItem(fx.projectId, mine.identifier, fx.ctx);
    const resumed = await runClaimWorkItem({ key: mine.identifier }, fx.ctx);
    expect((resumed.structuredContent as { outcome: string }).outcome).toBe('mine');
    expect(JSON.stringify(resumed.content)).toContain('RESUME');

    const shipped = await makeItem(fx, 'shipped via mcp');
    for (const hop of ['in_progress', 'in_review', 'done']) {
      await workItemsService.updateStatus(shipped.id, hop, fx.ctx);
    }
    const refused = await runClaimWorkItem({ key: shipped.identifier }, fx.ctx);
    expect((refused.structuredContent as { outcome: string }).outcome).toBe('not_claimable');
    expect(JSON.stringify(refused.content)).toContain('not available to a run');
  });

  it('names a holder it cannot read off the assignee column', async () => {
    // The MOTIR-2958 shape again, at the text layer: with nobody assigned the
    // summary must still say who, from the status history.
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const item = await makeItem(fx, 'held, unassigned');
    await workItemsService.updateStatus(item.id, 'in_progress', rival.ctx);

    const res = await runClaimWorkItem({ key: item.identifier }, fx.ctx);

    expect((res.structuredContent as { assignee: unknown }).assignee).toBeNull();
    expect(JSON.stringify(res.content)).toContain('Rival Runner');
  });

  it('an unknown key is a typed tool error, not a thrown exception', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runClaimWorkItem({ key: `${fx.projectIdentifier}-9999` }, fx.ctx);
    expect(res.isError).toBe(true);
  });
});
