import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE AI BOUNDARY CARRIES A DECISION'S CONFIRMATION (Story MOTIR-5871 · Subtask
// MOTIR-5958). Through the REAL internal routes, against a real Postgres: a `human`
// decision's latest confirm question rides `get-item`, `get-subtree` and `plan-tree`
// as a `decision` block — `confirmed` / `overturned` / `awaiting` / `none`, dated when
// decided, with an overturn's owed keys — read in ONE query per response however
// many decisions the set holds, and `null` on every other item.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { aiBoundaryService } = await import('@/lib/services/aiBoundaryService');
const { GET: getItemGET } = await import('@/app/api/internal/ai/get-item/route');
const { GET: getSubtreeGET } = await import('@/app/api/internal/ai/get-subtree/route');
const { GET: planTreeGET } = await import('@/app/api/internal/ai/plan-tree/route');

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function req(path: string, fx: Fx, query: Record<string, string> = {}): Request {
  const url = new URL(`http://core/api/internal/ai/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, {
    headers: {
      authorization: `Bearer ${SERVICE_SECRET}`,
      'x-motir-job-token': mintJobToken({
        userId: fx.ctx.userId,
        workspaceId: fx.ctx.workspaceId,
        projectId: fx.projectId,
      }),
    },
  });
}

const BODY = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** less requirement',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'MOTIR-6 and MOTIR-7',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

let seq = 0;
async function decision(fx: Fx, epicId: string, descriptionMd = BODY, executor = 'human') {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      parentId: epicId,
      title: `Decision ${seq}`,
      type: 'decision',
      executor: executor as 'human',
      descriptionMd,
    },
    fx.ctx,
  );
}

async function decide(fx: Fx, itemId: string, verb: 'approve' | 'overturn') {
  const read = await approvalGatesService.getForWorkItem(
    { workItemId: itemId, kind: 'decision_confirmation' },
    fx.ctx,
  );
  const result = await approvalGatesService.decide(
    {
      gateId: read.gate!.id,
      decision: verb,
      source: 'api',
      stamp: read.stamp!,
      ...(verb === 'overturn' ? { noteMd: 'Not what we agreed.' } : {}),
    },
    fx.ctx,
  );
  return result.gate.decidedAt!;
}

async function scene() {
  const fx = await makeFixture();
  const epic = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Exports' },
    fx.ctx,
  );
  const confirmed = await decision(fx, epic.id);
  const confirmedAt = await decide(fx, confirmed.id, 'approve');
  const overturned = await decision(fx, epic.id);
  const overturnedAt = await decide(fx, overturned.id, 'overturn');
  const awaiting = await decision(fx, epic.id);
  const defective = await decision(fx, epic.id, '## Decision\nOnly this.');
  const agent = await decision(fx, epic.id, BODY, 'coding_agent');
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Plain', parentId: epic.id },
    fx.ctx,
  );
  return {
    fx,
    epic,
    confirmed,
    confirmedAt,
    overturned,
    overturnedAt,
    awaiting,
    defective,
    agent,
    story,
  };
}

describe('GET get-item — the decision block', () => {
  it('confirmed · overturned · awaiting · none, and null on every other item', async () => {
    const s = await scene();
    const blockOf = async (key: string) => {
      const res = await getItemGET(req('get-item', s.fx, { key }));
      expect(res.status).toBe(200);
      return (await res.json()).item.decision;
    };
    expect(await blockOf(s.confirmed.identifier)).toEqual({
      state: 'confirmed',
      decidedAt: s.confirmedAt,
      replanOwed: null,
    });
    expect(await blockOf(s.overturned.identifier)).toEqual({
      state: 'overturned',
      decidedAt: s.overturnedAt,
      replanOwed: ['MOTIR-6', 'MOTIR-7'],
    });
    expect(await blockOf(s.awaiting.identifier)).toEqual({
      state: 'awaiting',
      decidedAt: null,
      replanOwed: null,
    });
    expect(await blockOf(s.defective.identifier)).toEqual({
      state: 'none',
      decidedAt: null,
      replanOwed: null,
    });
    expect(await blockOf(s.agent.identifier)).toBeNull();
    expect(await blockOf(s.story.identifier)).toBeNull();
    expect(await blockOf(s.epic.identifier)).toBeNull();
  });
});

describe('skeleton rows — get-subtree and plan-tree carry the same block', () => {
  it('get-subtree rows carry each decision’s block, and null elsewhere', async () => {
    const s = await scene();
    const res = await getSubtreeGET(
      req('get-subtree', s.fx, { rootKey: s.epic.identifier, depth: '1' }),
    );
    expect(res.status).toBe(200);
    const byKey = new Map(
      (await res.json()).nodes.map((n: { key: string; decision: unknown }) => [n.key, n.decision]),
    );
    expect(byKey.get(s.confirmed.identifier)).toMatchObject({ state: 'confirmed' });
    expect(byKey.get(s.overturned.identifier)).toMatchObject({
      state: 'overturned',
      replanOwed: ['MOTIR-6', 'MOTIR-7'],
    });
    expect(byKey.get(s.awaiting.identifier)).toMatchObject({ state: 'awaiting' });
    expect(byKey.get(s.defective.identifier)).toMatchObject({ state: 'none' });
    expect(byKey.get(s.agent.identifier)).toBeNull();
    expect(byKey.get(s.story.identifier)).toBeNull();
    expect(byKey.get(s.epic.identifier)).toBeNull();
  });

  it('plan-tree rows carry the same block', async () => {
    const s = await scene();
    const res = await planTreeGET(req('plan-tree', s.fx));
    expect(res.status).toBe(200);
    const items = (await res.json()).items as Array<{ key: string; decision: unknown }>;
    expect(items.find((i) => i.key === s.confirmed.identifier)?.decision).toEqual({
      state: 'confirmed',
      decidedAt: s.confirmedAt,
      replanOwed: null,
    });
    expect(items.find((i) => i.key === s.story.identifier)?.decision).toBeNull();
  });
});

describe('ONE query, however many decisions', () => {
  it('a subtree of three decisions costs the same queries as one of one', async () => {
    const countQueries = async (fn: () => Promise<unknown>): Promise<number> => {
      let calls = 0;
      const listener = (e: { query: string }) => {
        if (!/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(e.query.trim())) calls += 1;
      };
      (db as unknown as { $on: (e: 'query', cb: (e: { query: string }) => void) => void }).$on(
        'query',
        listener,
      );
      await fn();
      return calls;
    };

    const fx = await makeFixture();
    const small = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Small' },
      fx.ctx,
    );
    await decision(fx, small.id);
    const big = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Big' },
      fx.ctx,
    );
    for (let i = 0; i < 3; i += 1) await decision(fx, big.id);

    const one = await countQueries(() =>
      aiBoundaryService.getSubtree(fx.projectId, small.identifier, 1, fx.ctx),
    );
    const three = await countQueries(() =>
      aiBoundaryService.getSubtree(fx.projectId, big.identifier, 1, fx.ctx),
    );
    // The listener is cumulative (Prisma has no `$off`), so compare the DELTA.
    expect(three - one).toBe(one);
  });
});
