import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// `claim_next_ready` (MOTIR-1330) — the ATOMIC, race-safe dispatch claim over
// real Postgres. The behaviour: pick the highest-ranked ready item in the ACTIVE
// sprint and flip it to in_progress IN ONE transaction (FOR UPDATE SKIP LOCKED),
// so two concurrent `motir run` sessions can NEVER claim the same item. The
// concurrency tests warm the pool first so the two racers each get their own
// physical connection — otherwise a cold pool serialises them and masks a race.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

type Priority = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

async function makeReady(fx: WorkItemFixture, title: string, priority?: Priority) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      priority,
      assigneeId: null,
      descriptionMd: null,
    },
    fx.ctx,
  );
}

/** Create a sprint, drop the given items into it, and START it (→ active). */
async function activeSprintWith(fx: WorkItemFixture, itemIds: string[]): Promise<string> {
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
  if (itemIds.length > 0) {
    await db.workItem.updateMany({
      where: { id: { in: itemIds } },
      data: { sprintId: sprint.id },
    });
  }
  await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  return sprint.id;
}

/** Force ≥ n physical connections so two racing claims run truly concurrently —
 *  the FOR-UPDATE SKIP LOCKED (not a single shared connection) is then what
 *  separates them. A cold pool would serialise and mask the race. */
async function warmPool(n = 6): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db.$queryRaw`SELECT 1`));
}

async function statusOf(id: string): Promise<string> {
  const row = await db.workItem.findUniqueOrThrow({ where: { id } });
  return row.status;
}

describe('claimNextReady — atomic dispatch claim', () => {
  it('claims the highest-ranked ready item in the active sprint and flips it to in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const top = await makeReady(fx, 'top', 'highest');
    const low = await makeReady(fx, 'low', 'low');
    const sprintId = await activeSprintWith(fx, [top.id, low.id]);

    const claimed = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);
    expect(claimed?.key).toBe(top.identifier);
    expect(claimed?.status.category).toBe('in_progress');
    expect(await statusOf(top.id)).toBe('in_progress');
    expect(await statusOf(low.id)).toBe('todo'); // the lower-ranked item is untouched
  });

  it('a second claim returns the NEXT item; a third (none left) returns null', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeReady(fx, 'a', 'highest');
    const b = await makeReady(fx, 'b', 'high');
    const sprintId = await activeSprintWith(fx, [a.id, b.id]);

    const first = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);
    const second = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);
    const third = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);

    expect(first?.key).toBe(a.identifier);
    expect(second?.key).toBe(b.identifier);
    expect(third).toBeNull();
  });

  it('ignores ready items that are NOT in the active sprint', async () => {
    const fx = await makeWorkItemFixture();
    const inSprint = await makeReady(fx, 'in', 'medium');
    const backlog = await makeReady(fx, 'backlog', 'highest'); // higher rank, but unsprinted
    const sprintId = await activeSprintWith(fx, [inSprint.id]); // backlog item left out

    const claimed = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);
    expect(claimed?.key).toBe(inSprint.identifier);
    expect(await statusOf(backlog.id)).toBe('todo'); // never claimed
  });

  it('returns null when the active sprint has no ready item', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprintWith(fx, []);
    expect(await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx)).toBeNull();
  });

  it('with NO sprint scope (null), claims across the whole project — no sprint required', async () => {
    const fx = await makeWorkItemFixture();
    const top = await makeReady(fx, 'top', 'highest');
    await makeReady(fx, 'low', 'low');

    const claimed = await workItemsService.claimNextReady(fx.projectId, null, fx.ctx);
    expect(claimed?.key).toBe(top.identifier);
    expect(claimed?.status.category).toBe('in_progress');
    expect(await statusOf(top.id)).toBe('in_progress');
  });

  it('two concurrent claims take TWO DIFFERENT items — never double-claim (warm pool)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeReady(fx, 'a', 'highest');
    const b = await makeReady(fx, 'b', 'high');
    const sprintId = await activeSprintWith(fx, [a.id, b.id]);

    await warmPool();
    const [r1, r2] = await Promise.all([
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
    ]);

    expect(r1?.key).not.toBe(r2?.key); // distinct — no double-claim
    expect([r1?.key, r2?.key].sort()).toEqual([a.identifier, b.identifier].sort());
    expect(await statusOf(a.id)).toBe('in_progress');
    expect(await statusOf(b.id)).toBe('in_progress');
  });

  it('with ONE ready item, two concurrent claims: exactly one wins, the other gets null (warm pool)', async () => {
    const fx = await makeWorkItemFixture();
    const only = await makeReady(fx, 'only', 'highest');
    const sprintId = await activeSprintWith(fx, [only.id]);

    await warmPool();
    const results = await Promise.all([
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.find((r) => r !== null)?.key).toBe(only.identifier);
    expect(await statusOf(only.id)).toBe('in_progress');
  });
});

describe('runClaimNextReady — the MCP tool', () => {
  it('no active sprint → claims the top ready item project-wide (Kanban, no sprint required)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'kanban', 'highest'); // ready, in the backlog, no sprint
    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as {
      item: { key: string; status: { category: string } } | null;
    };
    expect(sc.item?.key).toBe(item.identifier);
    expect(sc.item?.status.category).toBe('in_progress');
    expect(await statusOf(item.id)).toBe('in_progress');
  });

  it('claims and returns the dispatch payload (status now in_progress) through the tool', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'claimable', 'highest');
    await activeSprintWith(fx, [item.id]);
    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as {
      item: { key: string; status: { category: string }; runCommand: string } | null;
    };
    expect(sc.item?.key).toBe(item.identifier);
    expect(sc.item?.status.category).toBe('in_progress');
    expect(sc.item?.runCommand).toBe(`motir run ${item.identifier}`);
  });

  it('active sprint but nothing ready → empty result with reason "none_ready"', async () => {
    const fx = await makeWorkItemFixture();
    await activeSprintWith(fx, []);
    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as { item: unknown; reason?: string };
    expect(sc.item).toBeNull();
    expect(sc.reason).toBe('none_ready');
  });
});
