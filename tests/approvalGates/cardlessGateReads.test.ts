import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, Prisma, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  APPROVAL_GATE_HANDLERS,
  type GateEffectArgs,
  type GateHandler,
  type GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import {
  ApprovalGateHasNoCardError,
  ApprovalGateStaleSubjectError,
} from '@/lib/approvalGates/errors';
import { requireArgsCard } from '@/lib/approvalGates/gateCard';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  approvalGatesService,
  resolveCardlessGateAuthority,
} from '@/lib/services/approvalGatesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { HomeActorContext } from '@/lib/services/homeService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE GATE READS ADMIT A GATE WITH NO WORK ITEM (Story MOTIR-6012 · Subtask MOTIR-6034;
// ADR `approval-gates.md` §11.1, §11.2, §11.5b, §11.6) — against a REAL Postgres.
//
// `plan_approval` is still UNREGISTERED when this card lands, so nothing in the product
// raises one of these rows: every card-less row below is written by `adminDb` (or by the
// new card-less repository forms), the way MOTIR-6036's raise will write it. What is
// proved is that the SHARED reads — the queue, its count, the record room, the decide
// door's pre-read and actor gate — answer a card-less row rather than failing to resolve
// a card, and that every card-owned path answers exactly as before beside it.
//
// ⚠️ THE DECIDE DOOR'S CARD-LESS ACTOR GATE is reachable only through a REGISTERED
// card-less kind, and none exists until MOTIR-6035. So one describe below registers a
// FAKE `plan_approval` handler for the length of each case (the registry's membership
// test is `kind in APPROVAL_GATE_HANDLERS`) and removes it afterwards. It proves the
// door's arms — the floor on the gate's OWN project, the `plan_permission` authority,
// no pin — not any behaviour of the real handler.

let fx: WorkItemFixture;
let meCtx: HomeActorContext;
let otherId: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  meCtx = { ...fx.ctx, projectId: fx.projectId };
  const other = await createTestUser({ email: 'other@ex.com', name: 'Other Person' });
  await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
  otherId = other.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A card-less `plan_approval` gate about `planId`, as MOTIR-6036's raise will write it. */
function planGate(planId: string, extra: Partial<Prisma.ApprovalGateUncheckedCreateInput> = {}) {
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: null,
      kind: 'plan_approval',
      subjectId: planId,
      routedToId: fx.ownerId,
      ...extra,
    },
  });
}

/** A card routed to the fixture owner, carrying an awaiting design gate. */
async function cardGate(title: string, kind: ApprovalGateKind = 'design_result') {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${item.id}`,
      routedToId: fx.ownerId,
    },
  });
  return { item, gate };
}

describe('the QUEUE — `listAwaitingMe` / `countAwaitingMe` list a card-less row (§11.1, §11.6)', () => {
  it('returns the plan gate beside a card gate, with its SUBJECT rather than a card', async () => {
    const card = await cardGate('A design to approve');
    const plan = await planGate('plan-1', { createdAt: new Date(Date.now() + 1000) });

    const queue = await approvalGatesService.listAwaitingMe(meCtx);
    expect(queue.total).toBe(2);
    expect(queue.items.map((row) => row.gateId)).toEqual([card.gate.id, plan.id]);

    const planRow = queue.items[1]!;
    expect(planRow).toMatchObject({
      kind: 'plan_approval',
      state: 'awaiting',
      workItem: null,
      // MOTIR-6035 registered the kind: its summary is read from the PLAN, and `plan-1`
      // names no plan, so the subject no longer resolves (it was `{ kind }` while the
      // kind was unregistered).
      subject: null,
      // …and the owner holds `ai:decide_plan`, the kind's one check (it was `false`
      // while no handler named a permission).
      canDecide: true,
    });
    // Named from the `routedToId` written at creation — there is no card to ask.
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
    expect(planRow.routedToName).toBe(owner.name);

    // The card row is exactly what it was.
    expect(queue.items[0]).toMatchObject({
      workItem: { id: card.item.id, title: 'A design to approve' },
      canDecide: true,
    });

    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(2);
  });

  it('routes a card-less gate by its `routedToId` — somebody else’s plan is not in my queue', async () => {
    await planGate('plan-mine');
    await planGate('plan-theirs', { routedToId: otherId });
    await planGate('plan-nobody', { routedToId: null });

    const mine = await approvalGatesService.listAwaitingMe(meCtx);
    expect(mine.items.map((row) => row.gateId)).toHaveLength(1);
    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(1);

    const theirs = await approvalGatesService.listAwaitingMe({ ...meCtx, userId: otherId });
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]).toMatchObject({ workItem: null, routedToName: 'Other Person' });
  });

  it('a DECIDED card-less gate is not waiting on anybody', async () => {
    await planGate('plan-1', { state: 'declined', decidedAt: new Date(), decidedById: fx.ownerId });
    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(0);
  });
});

describe('the RECORD ROOM — `listRecords` carries a card-less row in both sections', () => {
  it('lists an awaiting plan gate and a DECIDED one with no card, and the card rows unchanged', async () => {
    const card = await cardGate('A card beside the plans');
    await planGate('plan-waiting');
    await planGate('plan-approved', {
      state: 'approved',
      decidedAt: new Date(),
      decidedById: fx.ownerId,
      decidedByLabel: 'Owner',
      decidedUnderAuthority: 'plan_permission',
      subjectVersion: 'plan.v1.abc',
    });

    const page = await approvalGatesService.listRecords(meCtx, { limit: 50 });
    expect(page.sections.awaiting.total).toBe(2);
    const awaitingPlan = page.sections.awaiting.items.find((row) => row.kind === 'plan_approval');
    // Registered by MOTIR-6035: no plan behind `plan-waiting`, and the owner may decide.
    expect(awaitingPlan).toMatchObject({
      workItem: null,
      subject: null,
      canDecide: true,
    });
    expect(
      page.sections.awaiting.items.find((row) => row.kind === 'design_result')?.workItem?.id,
    ).toBe(card.item.id);

    expect(page.sections.decided.items).toHaveLength(1);
    expect(page.sections.decided.items[0]).toMatchObject({
      kind: 'plan_approval',
      state: 'approved',
      workItem: null,
      subjectVersion: 'plan.v1.abc',
      subject: null,
    });
  });

  it('lists a DECLINED plan gate among the decisions, with its optional reason (MOTIR-6037)', async () => {
    await planGate('plan-declined', {
      state: 'declined',
      decidedAt: new Date(),
      decidedById: fx.ownerId,
      decidedByLabel: 'Owner',
      decidedUnderAuthority: 'plan_permission',
      subjectVersion: 'plan.v1.def',
      noteMd: 'Not this quarter',
    });
    const page = await approvalGatesService.listRecords(meCtx, { limit: 50 });
    expect(page.sections.decided.total).toBe(1);
    expect(page.sections.decided.items[0]).toMatchObject({
      kind: 'plan_approval',
      state: 'declined',
      workItem: null,
      refusalReason: 'Not this quarter',
    });
  });
});

describe('the MARKER — `pendingDecisionsFor` is keyed on cards, and a card-less gate is not one', () => {
  it('answers the cards asked about and never throws over a plan gate in the project', async () => {
    const card = await cardGate('Marked card');
    await planGate('plan-1');
    const marks = await approvalGatesService.pendingDecisionsFor(
      { projectId: fx.projectId, workItemIds: [card.item.id] },
      fx.ctx,
    );
    expect([...marks.keys()]).toEqual([card.item.id]);
  });
});

// MOTIR-6034 proved the door reached the UNREGISTERED refusal here; MOTIR-6035 registered
// the kind, so a gate whose plan does not exist now reaches the handler, which answers the
// stale-subject refusal — still never a failure to resolve a card.
describe('the DECIDE DOOR on a card-less gate whose plan is gone', () => {
  it('reaches the handler’s stale-subject refusal rather than failing to resolve a card', async () => {
    const plan = await planGate('plan-1');
    const err = await approvalGatesService
      .decide(
        { gateId: plan.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateStaleSubjectError);
    expect(err).not.toBeInstanceOf(ApprovalGateHasNoCardError);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: plan.id } })).state).toBe(
      'awaiting',
    );
  });
});

describe('the DECIDE DOOR on a card-less gate — the arms a registered kind reaches (§11.6)', () => {
  const handlers = APPROVAL_GATE_HANDLERS as Record<string, GateHandler>;
  // The REAL handler since MOTIR-6035 — swapped out per case and put back, never deleted.
  const realHandler = handlers.plan_approval!;
  const effects = { approve: vi.fn(), currentSubject: vi.fn() };

  beforeEach(() => {
    effects.approve.mockReset();
    effects.currentSubject.mockReset();
    // A stand-in with the §11.6 permission. It is NOT MOTIR-6035's handler: it
    // resolves nothing and writes no plan, so only the door's own arms are measured.
    handlers.plan_approval = {
      resolveSubject: async () => null,
      subjectVersion: async () => 'plan.v1.fake',
      routeTo: () => null,
      currentSubject: async (args: GateRoutingArgs) => {
        effects.currentSubject(args);
        return 'never-asked';
      },
      permission: 'ai:decide_plan',
      statusIntent: null,
      approve: async (args: GateEffectArgs) => {
        effects.approve(args);
        return { statusWritten: null };
      },
      requestChanges: async () => ({ statusWritten: null }),
    };
  });

  afterEach(() => {
    handlers.plan_approval = realHandler;
  });

  it('decides under `plan_permission`, hands the effect NO card, and pins nothing', async () => {
    const plan = await planGate('plan-1');
    const result = await approvalGatesService.decide(
      { gateId: plan.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    expect(result.gate).toMatchObject({
      id: plan.id,
      workItemId: null,
      state: 'approved',
      decidedUnderAuthority: 'plan_permission',
      subjectVersion: 'plan.v1.fake',
      replanOwed: null,
    });
    expect(result.filesKept).toBeNull();
    const args = effects.approve.mock.calls[0]![0] as GateEffectArgs;
    expect(args.item).toBeNull();
    expect(args.gate).toMatchObject({ workItemId: null, projectId: fx.projectId });
  });

  it('asserts the kind’s permission against the gate’s OWN project — a viewer is refused', async () => {
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: otherId,
      role: 'viewer',
    });
    const plan = await planGate('plan-1', { routedToId: otherId });
    const err = await approvalGatesService
      .decide(
        { gateId: plan.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
        { userId: otherId, workspaceId: fx.workspaceId },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(effects.approve).not.toHaveBeenCalled();
  });

  it('a member holding `ai:decide_plan` may decide a plan gate routed to somebody else', async () => {
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: otherId,
      role: 'member',
    });
    const plan = await planGate('plan-1');
    const result = await approvalGatesService.decide(
      { gateId: plan.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      { userId: otherId, workspaceId: fx.workspaceId },
    );
    expect(result.gate).toMatchObject({
      decidedById: otherId,
      decidedUnderAuthority: 'plan_permission',
    });
  });

  it('`raiseOnReviewEntry` never raises a plan gate — it is a card-only loop', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Entering review' },
      fx.ctx,
    );
    const card = (await adminDb.workItem.findUniqueOrThrow({
      where: { id: item.id },
    })) as WorkItem;
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGatesService.raiseOnReviewEntry(card, fx.ctx, tx),
    );
    expect(effects.currentSubject).not.toHaveBeenCalled();
    expect(await adminDb.approvalGate.count({ where: { kind: 'plan_approval' } })).toBe(0);
  });
});

describe('`resolveCardlessGateAuthority` — the kind’s permission, and nothing else (§11.6)', () => {
  it('answers `plan_permission` for a holder and null otherwise, reading the set when not handed one', async () => {
    const held = new Set(['ai:decide_plan'] as const);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await resolveCardlessGateAuthority(
          { projectId: fx.projectId, permission: 'ai:decide_plan' },
          fx.ctx,
          tx,
          held,
        ),
      ).toBe('plan_permission');
      expect(
        await resolveCardlessGateAuthority(
          { projectId: fx.projectId, permission: 'ai:decide_plan' },
          fx.ctx,
          tx,
          new Set(),
        ),
      ).toBeNull();
      // The owner holds every key through the always-pass rail.
      expect(
        await resolveCardlessGateAuthority(
          { projectId: fx.projectId, permission: 'ai:decide_plan' },
          fx.ctx,
          tx,
        ),
      ).toBe('plan_permission');
    });
  });
});

describe('the CARD-LESS repository forms — keyed on `(subjectId, kind)` (§11.2)', () => {
  const base = () => ({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    kind: 'plan_approval' as const,
    subjectId: 'plan-1',
    routedToId: fx.ownerId,
  });

  it('raises once, and a second raise on the same plan is "already raised" — not an error', async () => {
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await approvalGateRepository.createCardlessAwaitingIfAbsent(base(), tx)).toBe(true);
      expect(await approvalGateRepository.createCardlessAwaitingIfAbsent(base(), tx)).toBe(false);
      expect(
        await approvalGateRepository.createCardlessAwaitingIfAbsent(
          { ...base(), subjectId: 'plan-2', subjectVersion: 'plan.v1.x' },
          tx,
        ),
      ).toBe(true);
    });
    const rows = await adminDb.approvalGate.findMany({ orderBy: { subjectId: 'asc' } });
    expect(rows.map((r) => [r.subjectId, r.workItemId, r.state, r.subjectVersion])).toEqual([
      ['plan-1', null, 'awaiting', null],
      ['plan-2', null, 'awaiting', 'plan.v1.x'],
    ]);
  });

  it('finds, reports live, and supersedes the awaiting gate of one plan — and only it', async () => {
    const one = await planGate('plan-1');
    await planGate('plan-2');
    // A CARD gate that happens to share the subject id is a different question.
    const card = await cardGate('Shares an id');
    await adminDb.approvalGate.update({
      where: { id: card.gate.id },
      data: { subjectId: 'plan-1' },
    });

    await withWorkspaceContext(fx.ctx, async (tx) => {
      const found = await approvalGateRepository.findAwaitingCardlessBySubject(
        'plan_approval',
        'plan-1',
        tx,
      );
      expect(found.map((g) => g.id)).toEqual([one.id]);
      expect(
        await approvalGateRepository.hasLiveCardlessGateForSubject('plan_approval', 'plan-1', tx),
      ).toBe(true);
      expect(
        await approvalGateRepository.hasLiveCardlessGateForSubject('plan_approval', 'plan-9', tx),
      ).toBe(false);
      expect(
        await approvalGateRepository.supersedeAwaitingCardlessBySubject(
          'plan_approval',
          'plan-1',
          'plan_stale',
          tx,
        ),
      ).toBe(1);
      expect(
        await approvalGateRepository.hasLiveCardlessGateForSubject('plan_approval', 'plan-1', tx),
      ).toBe(false);
    });

    const after = await adminDb.approvalGate.findMany();
    const byId = new Map(after.map((g) => [g.id, g]));
    expect(byId.get(one.id)).toMatchObject({ state: 'superseded', supersededCause: 'plan_stale' });
    expect(byId.get(card.gate.id)?.state).toBe('awaiting');
    expect(after.filter((g) => g.state === 'awaiting')).toHaveLength(2);
  });

  it('an APPROVED plan gate is live — the question has been answered for this plan', async () => {
    await planGate('plan-1', { state: 'approved', decidedAt: new Date() });
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await approvalGateRepository.hasLiveCardlessGateForSubject('plan_approval', 'plan-1', tx),
      ).toBe(true);
    });
  });
});

describe('`requireArgsCard` — a card-kind handler never guesses a card', () => {
  it('returns the card, and throws the typed defect naming the gate when there is none', () => {
    const item = { id: 'wi' };
    expect(requireArgsCard({ item }, 'design_result', 'here')).toBe(item);
    expect(() =>
      requireArgsCard({ item: null, gate: { id: 'g1' } }, 'design_result', 'the handler'),
    ).toThrow(/g1.*design_result.*the handler/);
    const err = (() => {
      try {
        requireArgsCard({ item: null }, 'design_result', 'routing');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ApprovalGateHasNoCardError);
    expect((err as ApprovalGateHasNoCardError).gateId).toBe('(not yet raised)');
  });
});
