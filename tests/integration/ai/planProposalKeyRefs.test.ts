import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { PATCH as proposalPATCH } from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A ref written as a `<PREFIX>-<n>` KEY on the INTERNAL doors (MOTIR-7983).
//
// MOTIR-3576 decided that a plan ref written as a key resolves or is refused —
// never silently accepted — and implemented it on the MCP tools. The two doors
// Motir's own hosted planner writes through, `POST /api/internal/ai/plan-proposals`
// and the `mode: 'correct'` PATCH on `plan-proposals/[itemId]`, stored the key
// verbatim: the add landed with no resolvable parent, and the plan's CLOSE then
// refused the whole thing `dangling`, twenty minutes and a whole planning run
// later. This file pins every carrier on both doors, resolved and refused.

const SERVICE_SECRET = 'core-callback-secret-key-refs';
const JOB_ID = 'job_key_refs';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function authed(req: Request, fx: WorkItemFixture): Request {
  req.headers.set('authorization', `Bearer ${SERVICE_SECRET}`);
  req.headers.set('content-type', 'application/json');
  req.headers.set(
    'x-motir-job-token',
    mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    }),
  );
  return req;
}

function append(fx: WorkItemFixture, body: unknown): Promise<Response> {
  return proposalsPOST(
    authed(
      new Request('http://core/api/internal/ai/plan-proposals', {
        method: 'POST',
        body: JSON.stringify({ jobId: JOB_ID, ...(body as object) }),
      }),
      fx,
    ),
  );
}

function correct(fx: WorkItemFixture, itemId: string, body: unknown): Promise<Response> {
  return proposalPATCH(
    authed(
      new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ jobId: JOB_ID, mode: 'correct', ...(body as object) }),
      }),
      fx,
    ),
    { params: Promise.resolve({ itemId }) },
  );
}

/** A plan motir-ai owns — bound to the job, `generating`, native author. */
async function openJobPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Hosted planner', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: JOB_ID } });
  return plan.id;
}

async function appendedIds(res: Response): Promise<string[]> {
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { planItemIds: string[] }).planItemIds;
}

async function row(planItemId: string) {
  const r = await adminDb.planItem.findUniqueOrThrow({ where: { id: planItemId } });
  return {
    parentRef: r.parentRef,
    blockedByRefs: r.blockedByRefs,
    supersedesRefs: r.supersedesRefs,
    patch: r.patch as Record<string, unknown> | null,
  };
}

async function doneCard(fx: WorkItemFixture, title: string) {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
  return item;
}

describe('POST /api/internal/ai/plan-proposals — a ref written as a KEY', () => {
  it('stores the parent’s ID for an `add` whose `parentRef` is a key, and approve places it there', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'The story' });
    const planId = await openJobPlan(fx);

    const [addId] = await appendedIds(
      await append(fx, {
        proposals: [
          {
            op: 'add',
            proposedFields: { title: 'Its subtask', kind: 'subtask' },
            parentRef: story.identifier,
          },
        ],
      }),
    );
    expect((await row(addId!)).parentRef).toBe(story.id);

    // The plan reads the add UNDER the story — not ungrouped at the root.
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.items.find((i) => i.id === addId)!.parentRef).toBe(story.id);

    const closed = await append(fx, { proposals: [], final: true });
    expect(((await closed.json()) as { planned: boolean }).planned).toBe(true);
    await plansService.approvePlan(planId, fx.ctx);
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Its subtask' },
    });
    expect(created.parentId).toBe(story.id);
  });

  it('stores IDs for a `modify`’s `patch.blockedByAdd` / `blockedByRemove` keys, and the plan CLOSES `planned`', async () => {
    // The observed failure: the close refused `patch.blockedByAdd "MOTIR-7905"`
    // as dangling and the plan stayed `generating`.
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'The target' });
    const blockerA = await createTestWorkItem(fx, { kind: 'task', title: 'Blocker A' });
    const blockerB = await createTestWorkItem(fx, { kind: 'task', title: 'Blocker B' });
    await openJobPlan(fx);

    const res = await append(fx, {
      final: true,
      proposals: [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { blockedByAdd: [blockerA.identifier], blockedByRemove: [blockerB.identifier] },
        },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { planItemIds: string[]; planned: boolean };
    expect(body.planned).toBe(true);
    const { patch } = await row(body.planItemIds[0]!);
    expect(patch!.blockedByAdd).toEqual([blockerA.id]);
    expect(patch!.blockedByRemove).toEqual([blockerB.id]);
  });

  it('stores IDs for `blockedByRefs`, `patch.parentRef` and the `supersedes*` carriers', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'The story' });
    const blocker = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Same-level blocker',
      parentId: story.id,
    });
    const home = await createTestWorkItem(fx, { kind: 'story', title: 'Where it is' });
    const destination = await createTestWorkItem(fx, { kind: 'story', title: 'Where it belongs' });
    const card = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'The moving card',
      parentId: home.id,
    });
    const old = await doneCard(fx, 'The old card');
    const retired = await doneCard(fx, 'The retired card');
    const replacement = await doneCard(fx, 'The replacing card');
    await openJobPlan(fx);

    const [addId, moveId, markId] = await appendedIds(
      await append(fx, {
        proposals: [
          {
            op: 'add',
            proposedFields: { title: 'Blocked and superseding', kind: 'task' },
            parentRef: story.identifier,
            blockedByRefs: [blocker.identifier],
            supersedesRefs: [old.identifier],
          },
          { op: 'modify', workItemId: card.id, patch: { parentRef: destination.identifier } },
          {
            op: 'modify',
            workItemId: retired.id,
            patch: {
              obsolescence: 'deprecated',
              obsolescenceNoteMd: 'Replaced.',
              supersededByAdd: [replacement.identifier],
            },
          },
        ],
      }),
    );

    const add = await row(addId!);
    expect(add.blockedByRefs).toEqual([blocker.id]);
    expect(add.supersedesRefs).toEqual([old.id]);
    expect((await row(moveId!)).patch!.parentRef).toBe(destination.id);
    expect((await row(markId!)).patch!.supersededByAdd).toEqual([replacement.id]);
  });

  it('is case-insensitive, and leaves an ID and a `planItem:` temp-ref untouched', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'The story' });
    await openJobPlan(fx);

    const [first] = await appendedIds(
      await append(fx, {
        proposals: [
          {
            op: 'add',
            proposedFields: { title: 'Lower-case key', kind: 'subtask' },
            parentRef: story.identifier.toLowerCase(),
          },
        ],
      }),
    );
    expect((await row(first!)).parentRef).toBe(story.id);

    const [second] = await appendedIds(
      await append(fx, {
        proposals: [
          {
            op: 'add',
            proposedFields: { title: 'By id', kind: 'subtask' },
            parentRef: story.id,
            blockedByRefs: [`planItem:${first}`],
          },
        ],
      }),
    );
    const stored = await row(second!);
    expect(stored.parentRef).toBe(story.id);
    expect(stored.blockedByRefs).toEqual([`planItem:${first}`]);
  });

  it('⚠️ REFUSES a key that names no work item AT THE APPEND — 422 `dangling`, nothing appended', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'The target' });
    const planId = await openJobPlan(fx);
    const missing = `${fx.projectIdentifier}-999999`;

    for (const proposal of [
      {
        op: 'add',
        proposedFields: { title: 'Hangs off nothing', kind: 'task' },
        parentRef: missing,
      },
      {
        op: 'add',
        proposedFields: { title: 'Blocked by nothing', kind: 'task' },
        blockedByRefs: [missing],
      },
      { op: 'modify', workItemId: target.id, patch: { blockedByAdd: [missing] } },
    ]) {
      const res = await append(fx, { proposals: [proposal] });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; reason: string; error: string };
      expect(body.code).toBe('INVALID_PLAN_REF_GRAPH');
      expect(body.reason).toBe('dangling');
      // The MCP door's wording, naming the key.
      expect(body.error).toContain("A proposal's ref names no work item in this workspace");
      expect(body.error).toContain(missing);
    }
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
  });
});

describe('PATCH /api/internal/ai/plan-proposals/[itemId] `mode: correct` — a ref written as a KEY', () => {
  it('stores IDs for a corrected `parentRef`, `blockedByRefs` and `supersedesRefs`', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'The story' });
    const blocker = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Same-level blocker',
      parentId: story.id,
    });
    const old = await doneCard(fx, 'The old card');
    await openJobPlan(fx);
    const [addId] = await appendedIds(
      await append(fx, {
        proposals: [{ op: 'add', proposedFields: { title: 'Root task', kind: 'task' } }],
      }),
    );

    const res = await correct(fx, addId!, {
      parentRef: story.identifier,
      blockedByRefs: [blocker.identifier],
      supersedesRefs: [old.identifier],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await row(addId!);
    expect(stored.parentRef).toBe(story.id);
    expect(stored.blockedByRefs).toEqual([blocker.id]);
    expect(stored.supersedesRefs).toEqual([old.id]);
  });

  it('stores IDs for a corrected `modify` patch’s `blockedByAdd` and `parentRef`', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'The target' });
    const blocker = await createTestWorkItem(fx, { kind: 'task', title: 'The blocker' });
    await openJobPlan(fx);
    const [modifyId] = await appendedIds(
      await append(fx, {
        proposals: [{ op: 'modify', workItemId: target.id, patch: { title: 'Re-scoped' } }],
      }),
    );

    const res = await correct(fx, modifyId!, {
      modifyPatch: { title: 'Re-scoped', blockedByAdd: [blocker.identifier] },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await row(modifyId!)).patch!.blockedByAdd).toEqual([blocker.id]);
  });

  it('⚠️ REFUSES an unknown key with 422 `dangling` and leaves the proposal as it was', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'The story' });
    await openJobPlan(fx);
    const [addId] = await appendedIds(
      await append(fx, {
        proposals: [
          { op: 'add', proposedFields: { title: 'Placed', kind: 'task' }, parentRef: story.id },
        ],
      }),
    );
    const missing = `${fx.projectIdentifier}-999999`;

    const res = await correct(fx, addId!, { parentRef: missing });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; reason: string; error: string };
    expect(body.code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(body.reason).toBe('dangling');
    expect(body.error).toContain(missing);
    expect((await row(addId!)).parentRef).toBe(story.id);
  });
});
