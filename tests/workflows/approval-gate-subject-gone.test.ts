import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { APPROVAL_GATE_HANDLERS } from '@/lib/approvalGates/registry';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import type { HomeActorContext } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// A QUESTION WHOSE SUBJECT IS GONE IS WITHDRAWN, EVERY KIND ALIKE (Bug MOTIR-7146).
//
// An `awaiting` gate whose subject stopped resolving stayed `awaiting` for ever: a *Gone*
// row on To approve, counted, with nothing in the product able to retire it. The reads
// that observe one now withdraw it — superseded `subject_gone`, after the handler of its
// kind re-reads the subject under the gate's lock — so it leaves the list and its count.
//
// Proven over EVERY kind the registry dispatches, so a kind added later is held to it by
// this file rather than by somebody remembering. Real Postgres, per the repo convention.

let fx: WorkItemFixture;
let me: HomeActorContext;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  me = { ...fx.ctx, projectId: fx.projectId };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every registered kind a WORK ITEM can hold — `plan_approval` belongs to a plan. */
const CARD_KINDS = (Object.keys(APPROVAL_GATE_HANDLERS) as ApprovalGateKind[]).filter(
  // `planning_session` is the second card-less kind (MOTIR-7913), held to the same constraint.
  (kind) => kind !== 'plan_approval' && kind !== 'planning_session',
);

/** The kinds a person's To approve lists: never the review agent's (ADR §12.1). */
const QUEUE_KINDS = CARD_KINDS.filter((kind) => kind !== 'agent_review');

/** The kinds whose subject is its own row rather than the card itself. */
const EVIDENCE_KINDS: ReadonlySet<ApprovalGateKind> = new Set([
  'design_result',
  'acceptance_result',
]);

let seq = 0;

/** A plain task at In review, reported (so routed) to the fixture's user. It delivers
 *  no pull request and its body is not a choice or a decision, so every subject that IS
 *  the card fails to resolve on it. */
async function card() {
  seq += 1;
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Task ${seq}` },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  return item.id;
}

/** One `awaiting` gate of `kind` on the card whose subject does not resolve: an evidence
 *  id that names no row, or the card itself for a kind whose subject IS the card. */
async function raiseGone(itemId: string, kind: ApprovalGateKind) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: itemId,
        kind,
        subjectId: EVIDENCE_KINDS.has(kind) ? `gone-${kind}-${itemId}` : itemId,
      },
      tx,
    ),
  );
}

/** A `design_result` gate over a REAL evidence row — a subject that resolves. */
async function raiseLiveDesign(itemId: string) {
  const evidence = await adminDb.designEvidence.create({
    data: { workspaceId: fx.workspaceId, workItemId: itemId },
  });
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: itemId,
        kind: 'design_result',
        subjectId: evidence.id,
      },
      tx,
    ),
  );
}

/** A card-less `plan_approval` gate routed to the fixture's user, about a plan that does
 *  not exist. */
async function raiseGonePlan() {
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: null,
        kind: 'plan_approval',
        subjectId: 'plan-that-is-gone',
        routedToId: fx.ctx.userId,
      },
      tx,
    ),
  );
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

async function expectWithdrawnGone(id: string) {
  const row = await gateRow(id);
  expect(row.state).toBe('superseded');
  expect(row.supersededCause).toBe('subject_gone');
  // A withdrawal is never a decision.
  expect(row.decidedById).toBeNull();
  expect(row.decidedAt).toBeNull();
}

describe('To approve withdraws a question whose subject is gone', () => {
  it('lists nothing and counts nothing for a gone gate of EVERY kind the tab lists', async () => {
    expect(QUEUE_KINDS.length).toBeGreaterThanOrEqual(5);
    const ids: string[] = [];
    for (const kind of QUEUE_KINDS) ids.push((await raiseGone(await card(), kind)).id);
    ids.push((await raiseGonePlan()).id);
    // Before anything observes them, the count is every one of them — the defect.
    expect(await approvalGatesService.countAwaitingMe(me)).toBe(ids.length);

    const page = await approvalGatesService.listAwaitingMe(me);

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.truncated).toBe(false);
    for (const id of ids) await expectWithdrawnGone(id);
    expect(await approvalGatesService.countAwaitingMe(me)).toBe(0);
  });

  it('keeps a gate whose subject RESOLVES, beside a gone one on the same card', async () => {
    const itemId = await card();
    const live = await raiseLiveDesign(itemId);
    const gone = await raiseGone(itemId, 'decision_choice');

    const page = await approvalGatesService.listAwaitingMe(me);

    expect(page.items.map((row) => row.gateId)).toEqual([live.id]);
    expect(page.total).toBe(1);
    expect((await gateRow(live.id)).state).toBe('awaiting');
    await expectWithdrawnGone(gone.id);
  });

  it('the Approvals room withdraws it too, and lists it in neither section', async () => {
    const live = await raiseLiveDesign(await card());
    const gone = await raiseGone(await card(), 'acceptance_result');

    const page = await approvalGatesService.listRecords(me);

    expect(page.sections.awaiting.items.map((row) => row.gateId)).toEqual([live.id]);
    expect(page.sections.awaiting.total).toBe(1);
    expect(page.sections.decided.items).toEqual([]);
    expect(page.total).toBe(1);
    await expectWithdrawnGone(gone.id);
  });
});

describe('withdrawGoneQuestionsOnWorkItem — the overlay’s withdrawal', () => {
  it('supersedes a gone gate of EVERY registered card kind, through its own handler', async () => {
    for (const kind of CARD_KINDS) {
      const itemId = await card();
      const gate = await raiseGone(itemId, kind);

      const withdrawn = await approvalGatesService.withdrawGoneQuestionsOnWorkItem(itemId, fx.ctx);

      expect([...withdrawn], kind).toEqual([gate.id]);
      await expectWithdrawnGone(gate.id);
    }
  });

  it('a card-less plan gate is withdrawn by id', async () => {
    const gate = await raiseGonePlan();

    const withdrawn = await approvalGatesService.withdrawGoneQuestions([gate.id], fx.ctx);

    expect([...withdrawn]).toEqual([gate.id]);
    await expectWithdrawnGone(gate.id);
  });

  it('leaves a gate whose subject resolves exactly as it was', async () => {
    const itemId = await card();
    const live = await raiseLiveDesign(itemId);

    const withdrawn = await approvalGatesService.withdrawGoneQuestionsOnWorkItem(itemId, fx.ctx);

    expect(withdrawn.size).toBe(0);
    const row = await gateRow(live.id);
    expect(row.state).toBe('awaiting');
    expect(row.supersededCause).toBeNull();
  });

  it('never touches a DECIDED gate — somebody’s answer stands over a gone subject', async () => {
    const itemId = await card();
    const gate = await raiseGone(itemId, 'design_result');
    await adminDb.approvalGate.update({ where: { id: gate.id }, data: { state: 'approved' } });

    const withdrawn = await approvalGatesService.withdrawGoneQuestions([gate.id], fx.ctx);

    expect(withdrawn.size).toBe(0);
    expect((await gateRow(gate.id)).state).toBe('approved');
  });

  it('is idempotent — a second pass finds nothing awaiting to withdraw', async () => {
    const itemId = await card();
    const gate = await raiseGone(itemId, 'pull_request_approval');

    await approvalGatesService.withdrawGoneQuestionsOnWorkItem(itemId, fx.ctx);
    const again = await approvalGatesService.withdrawGoneQuestions([gate.id], fx.ctx);

    expect(again.size).toBe(0);
    await expectWithdrawnGone(gate.id);
  });

  it('an id that names no gate withdraws nothing', async () => {
    const withdrawn = await approvalGatesService.withdrawGoneQuestions(['no-such-gate'], fx.ctx);
    expect(withdrawn.size).toBe(0);
  });
});

describe('a withdrawal that fails never fails the read', () => {
  it('To approve still answers, with the gone row as it was', async () => {
    const gate = await raiseGone(await card(), 'design_result');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(approvalGateRepository, 'supersedeAwaitingById').mockRejectedValueOnce(
      new Error('the write was refused'),
    );

    const page = await approvalGatesService.listAwaitingMe(me);

    expect(page.items.map((row) => row.gateId)).toEqual([gate.id]);
    expect(page.items[0]!.subject).toBeNull();
    expect(page.total).toBe(1);
    expect((await gateRow(gate.id)).state).toBe('awaiting');
    expect(error).toHaveBeenCalled();
  });
});
