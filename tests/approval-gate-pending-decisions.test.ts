import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, ApprovalGateState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { boardsService } from '@/lib/services/boardsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { HomeActorContext } from '@/lib/services/homeService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE DECISION-WAITING MARKER'S READ (Story MOTIR-4908 · Subtask MOTIR-5876) —
// `approvalGatesService.pendingDecisionsFor`, against a REAL Postgres.
//
// What makes this suite worth having, each of which fails QUIETLY:
//
//   · `yours` IS THE TO-APPROVE TAB. The marker and the tab answer one question
//     about one person, so they are compared over ONE fixture that holds every
//     routing shape — the assignee, the reporter fallback, somebody else's gate,
//     a carried merge gate, a decided and a superseded gate. A marker that drew
//     its own conclusion about routing would pass every per-case test and still
//     disagree with the list built to answer the same question.
//   · THE ADMIN IS NOT ASKED. The fixture's owner holds `approval:decide_any`, so
//     they COULD press a gate routed elsewhere; the marker must still call it
//     someone else's, because the tab never lists it.
//   · THE FLOOR. A project viewer the gate is routed to sees it in the tab and
//     cannot press it — the marker's `others`, not `yours`.
//   · ONE QUERY, WHATEVER THE SIZE. Asserted by counting the model operations the
//     call makes, never by timing it.

let fx: WorkItemFixture;
let otherId: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const other = await createTestUser({ email: 'other@ex.com', name: 'Other' });
  await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
  otherId = other.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A root-level task — a card the default board draws — with its routing pair set exactly. */
async function card(opts: { title: string; assigneeId?: string | null; reporterId?: string }) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: opts.title },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      assigneeId: opts.assigneeId ?? null,
      ...(opts.reporterId ? { reporterId: opts.reporterId } : {}),
    },
  });
  return item;
}

/** One gate on a card, in a given state and at a given age. */
async function gate(
  workItemId: string,
  opts: { kind?: ApprovalGateKind; state?: ApprovalGateState; createdAt?: Date } = {},
) {
  const row = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId,
        kind: opts.kind ?? 'design_result',
        subjectId: `subject-${workItemId}-${opts.kind ?? 'design_result'}-${Math.random()}`,
      },
      tx,
    ),
  );
  if (opts.state || opts.createdAt) {
    await adminDb.approvalGate.update({
      where: { id: row.id },
      data: {
        ...(opts.state ? { state: opts.state } : {}),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
  }
  return row;
}

function pendingFor(workItemIds: string[], ctx = fx.ctx) {
  return approvalGatesService.pendingDecisionsFor({ projectId: fx.projectId, workItemIds }, ctx);
}

/** A workspace member whose ONLY project membership is `viewer` — below `work_item:edit`. */
async function projectViewer() {
  const user = await createTestUser({ email: 'viewer@ex.com', name: 'Viewer' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await adminDb.projectMembership.deleteMany({
    where: { userId: user.id, projectId: fx.projectId },
  });
  await adminDb.projectMembership.create({
    data: { userId: user.id, projectId: fx.projectId, workspaceId: fx.workspaceId, role: 'viewer' },
  });
  return user;
}

describe('approvalGatesService.pendingDecisionsFor — the three outcomes', () => {
  it('YOURS when the gate is routed to the reader as ASSIGNEE, and as the REPORTER with no assignee', async () => {
    const assigned = await card({ title: 'Assigned to me', assigneeId: fx.ownerId });
    const reported = await card({ title: 'Reported by me', assigneeId: null });
    await gate(assigned.id);
    await gate(reported.id, { kind: 'acceptance_result' });

    const map = await pendingFor([assigned.id, reported.id]);

    expect(map.get(assigned.id)).toEqual({
      state: 'yours',
      kind: 'design_result',
      routedToId: fx.ownerId,
    });
    expect(map.get(reported.id)).toEqual({
      state: 'yours',
      kind: 'acceptance_result',
      routedToId: fx.ownerId,
    });
  });

  it('OTHERS when routed to someone else — even for an admin holding `approval:decide_any`', async () => {
    // `fx.ownerId` is the workspace owner, so they hold the `_any` key and could
    // decide this gate from the item page. The marker says who is ASKED.
    const theirs = await card({ title: 'Theirs', assigneeId: otherId });
    await gate(theirs.id);

    const map = await pendingFor([theirs.id]);

    expect(map.get(theirs.id)).toEqual({
      state: 'others',
      kind: 'design_result',
      routedToId: otherId,
    });
  });

  it('OTHERS for a reader the gate IS routed to who sits below the kind’s permission floor', async () => {
    const viewer = await projectViewer();
    const item = await card({ title: 'Routed to a viewer', assigneeId: viewer.id });
    await gate(item.id);

    const map = await pendingFor([item.id], { userId: viewer.id, workspaceId: fx.workspaceId });

    expect(map.get(item.id)).toEqual({
      state: 'others',
      kind: 'design_result',
      routedToId: viewer.id,
    });
  });

  it('NOTHING for a card with no gate, and for one whose gates are decided or superseded', async () => {
    const bare = await card({ title: 'No gate', assigneeId: fx.ownerId });
    const decided = await card({ title: 'Decided', assigneeId: fx.ownerId });
    const superseded = await card({ title: 'Superseded', assigneeId: fx.ownerId });
    await gate(decided.id, { state: 'approved' });
    await gate(decided.id, { kind: 'acceptance_result', state: 'changes_requested' });
    await gate(superseded.id, { state: 'superseded' });

    const map = await pendingFor([bare.id, decided.id, superseded.id]);

    expect(map.size).toBe(0);
  });
});

describe('approvalGatesService.pendingDecisionsFor — several gates on one card', () => {
  it('the OLDEST awaiting gate is the entry, and its kind is the one the header anchors on', async () => {
    const item = await card({ title: 'Two questions', assigneeId: fx.ownerId });
    await gate(item.id, { kind: 'design_result', createdAt: new Date('2026-09-02T00:00:00Z') });
    await gate(item.id, { kind: 'acceptance_result', createdAt: new Date('2026-09-01T00:00:00Z') });

    const map = await pendingFor([item.id]);

    expect(map.get(item.id)).toEqual({
      state: 'yours',
      kind: 'acceptance_result',
      routedToId: fx.ownerId,
    });
  });

  it('a merge gate CARRIED by an awaiting design gate contributes nothing, even when it is older', async () => {
    const item = await card({ title: 'Design with an open PR', assigneeId: fx.ownerId });
    await gate(item.id, {
      kind: 'pull_request_approval',
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    await gate(item.id, { kind: 'design_result', createdAt: new Date('2026-09-02T00:00:00Z') });

    const map = await pendingFor([item.id]);

    expect(map.get(item.id)?.kind).toBe('design_result');
  });

  it('a merge gate with no primary awaiting IS a question, and is the entry', async () => {
    const item = await card({ title: 'Code awaiting merge', assigneeId: fx.ownerId });
    await gate(item.id, { kind: 'design_result', state: 'approved' });
    await gate(item.id, { kind: 'pull_request_approval' });

    const map = await pendingFor([item.id]);

    expect(map.get(item.id)).toEqual({
      state: 'yours',
      kind: 'pull_request_approval',
      routedToId: fx.ownerId,
    });
  });
});

describe('approvalGatesService.pendingDecisionsFor — access, enforced IN the query', () => {
  it('returns an EMPTY map to a reader who may not browse the project — while the true population is not empty', async () => {
    const stranger = await createTestUser({ email: 'stranger@ex.com', name: 'Stranger' });
    await workspacesService.addMember({ userId: stranger.id, workspaceId: fx.workspaceId });
    const item = await card({ title: 'Routed to the stranger', assigneeId: stranger.id });
    await gate(item.id);
    await projectMembersService.setAccessLevel({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'private',
    });
    await adminDb.projectMembership.deleteMany({
      where: { userId: stranger.id, projectId: fx.projectId },
    });

    // The population is genuinely there — the owner sees it.
    expect((await pendingFor([item.id])).get(item.id)?.state).toBe('others');
    // The stranger, who may not browse, is told nothing — and no error.
    const map = await pendingFor([item.id], { userId: stranger.id, workspaceId: fx.workspaceId });
    expect(map.size).toBe(0);
  });
});

describe('`yours` EQUALS the To-approve tab, over one fixture', () => {
  it('the marker’s `yours` set is exactly the tab’s rows for the same reader', async () => {
    const mine = await card({ title: 'Mine', assigneeId: fx.ownerId });
    const reportedByMe = await card({ title: 'Reported by me', assigneeId: null });
    const theirs = await card({ title: 'Theirs', assigneeId: otherId });
    const reportedButAssigned = await card({
      title: 'Reported by me, assigned elsewhere',
      assigneeId: otherId,
    });
    const carried = await card({ title: 'Carried merge', assigneeId: fx.ownerId });
    const decided = await card({ title: 'Decided', assigneeId: fx.ownerId });
    const superseded = await card({ title: 'Superseded', assigneeId: fx.ownerId });
    await gate(mine.id);
    await gate(reportedByMe.id, { kind: 'acceptance_result' });
    await gate(theirs.id);
    await gate(reportedButAssigned.id);
    await gate(carried.id, { kind: 'pull_request_approval' });
    await gate(carried.id);
    await gate(decided.id, { state: 'approved' });
    await gate(superseded.id, { state: 'superseded' });

    const ids = [mine, reportedByMe, theirs, reportedButAssigned, carried, decided, superseded].map(
      (i) => i.id,
    );
    const map = await pendingFor(ids);
    const yours = [...map].filter(([, v]) => v.state === 'yours').map(([id]) => id);

    const meCtx: HomeActorContext = { ...fx.ctx, projectId: fx.projectId };
    const tab = await approvalGatesService.listAwaitingMe(meCtx);
    const tabDecidable = tab.items.filter((row) => row.canDecide).map((row) => row.workItem?.id);

    expect(yours.sort()).toEqual(tabDecidable.sort());
    expect(yours.sort()).toEqual([mine.id, reportedByMe.id, carried.id].sort());
    // …and the tab lists each of those cards ONCE, as the marker marks each once.
    expect(tab.items.map((r) => r.workItem?.id).sort()).toEqual(tabDecidable.sort());
  });

  it('for a reader BELOW the floor, the tab lists the gate it cannot press and the marker calls it `others`', async () => {
    const viewer = await projectViewer();
    const item = await card({ title: 'Routed to a viewer', assigneeId: viewer.id });
    await gate(item.id);
    const viewerCtx = { userId: viewer.id, workspaceId: fx.workspaceId };

    const tab = await approvalGatesService.listAwaitingMe({
      ...viewerCtx,
      projectId: fx.projectId,
    });
    const map = await pendingFor([item.id], viewerCtx);

    expect(tab.items.map((r) => [r.workItem?.id, r.canDecide])).toEqual([[item.id, false]]);
    expect(map.get(item.id)?.state).toBe('others');
  });
});

type ModelOp = string;

/**
 * Every MODEL operation made inside `db.$transaction` while `run` executes — the
 * recorder `tests/integration/plans/pendingPlanIndicator.test.ts` uses, so the
 * count is of queries actually issued, not of time spent.
 */
async function recordModelOps<T>(run: () => Promise<T>): Promise<{ result: T; ops: ModelOp[] }> {
  const ops: ModelOp[] = [];
  const passthrough = db.$transaction.bind(db) as (
    arg: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  const record = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx as object, {
      get(client, key) {
        const value = Reflect.get(client, key) as unknown;
        if (typeof key !== 'string' || key.startsWith('$') || typeof value !== 'object' || !value) {
          return value;
        }
        return new Proxy(value, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method) as unknown;
            if (typeof method !== 'string' || typeof fn !== 'function') return fn;
            return (...args: unknown[]) => {
              ops.push(`${key}.${method}`);
              return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      },
    }) as Prisma.TransactionClient;
  const spy = vi
    .spyOn(db, '$transaction')
    .mockImplementation(((arg: unknown, options?: unknown) =>
      typeof arg === 'function'
        ? passthrough(
            (tx: Prisma.TransactionClient) =>
              (arg as (t: Prisma.TransactionClient) => Promise<unknown>)(record(tx)),
            options,
          )
        : passthrough(arg, options)) as unknown as typeof db.$transaction);
  try {
    return { result: await run(), ops };
  } finally {
    spy.mockRestore();
  }
}

describe('ONE gate query per call, whatever the number of ids', () => {
  it('reads ONE `approvalGate.findMany` for one card and for thirty', async () => {
    const one = await card({ title: 'One', assigneeId: fx.ownerId });
    await gate(one.id);
    const many = [one];
    for (let i = 0; i < 29; i += 1) {
      const item = await card({ title: `Card ${i}`, assigneeId: i % 2 ? otherId : fx.ownerId });
      await gate(item.id);
      many.push(item);
    }

    const small = await recordModelOps(() => pendingFor([one.id]));
    const large = await recordModelOps(() => pendingFor(many.map((i) => i.id)));

    const gateReads = (ops: ModelOp[]) => ops.filter((op) => op.startsWith('approvalGate.'));
    expect(gateReads(small.ops)).toEqual(['approvalGate.findMany']);
    expect(gateReads(large.ops)).toEqual(['approvalGate.findMany']);
    expect(large.result.size).toBe(30);
    // The whole call is the same size either way — nothing in it is per row.
    expect(large.ops.length).toBe(small.ops.length);
  });

  it('issues NO query at all for an empty set', async () => {
    const { result, ops } = await recordModelOps(() => pendingFor([]));
    expect(result.size).toBe(0);
    expect(ops).toEqual([]);
  });
});

describe('the board carries the marker', () => {
  it('the board read’s cards carry `pendingDecision`, `null` where no gate awaits', async () => {
    const mine = await card({ title: 'Mine', assigneeId: fx.ownerId });
    const theirs = await card({ title: 'Theirs', assigneeId: otherId });
    const bare = await card({ title: 'Bare', assigneeId: fx.ownerId });
    await gate(mine.id);
    await gate(theirs.id, { kind: 'acceptance_result' });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const byId = new Map(board.columns.flatMap((c) => c.cards).map((c) => [c.id, c]));

    expect(byId.get(mine.id)?.pendingDecision).toEqual({
      state: 'yours',
      kind: 'design_result',
      routedToId: fx.ownerId,
    });
    expect(byId.get(theirs.id)?.pendingDecision).toEqual({
      state: 'others',
      kind: 'acceptance_result',
      routedToId: otherId,
    });
    expect(byId.get(bare.id)?.pendingDecision).toBeNull();
  });

  it('`moveCard`’s returned card keeps its marker, and a card with none returns `null`', async () => {
    const mine = await card({ title: 'Mine', assigneeId: fx.ownerId });
    const bare = await card({ title: 'Bare', assigneeId: fx.ownerId });
    await gate(mine.id);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const column = board.columns.find((c) => c.cards.some((card) => card.id === mine.id))!;

    // A within-column re-rank: no transition, so nothing a gate might hold.
    const moved = await boardsService.moveCard(
      board.boardId,
      mine.id,
      { toColumnId: column.id },
      fx.ctx,
    );
    const movedBare = await boardsService.moveCard(
      board.boardId,
      bare.id,
      { toColumnId: column.id },
      fx.ctx,
    );

    expect(moved.card.pendingDecision).toEqual({
      state: 'yours',
      kind: 'design_result',
      routedToId: fx.ownerId,
    });
    expect(movedBare.card.pendingDecision).toBeNull();
  });
});
