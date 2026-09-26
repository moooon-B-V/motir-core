import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { computeGateStamp } from '@/lib/approvalGates/stamp';
import { presentApprovalGateRecord } from '@/lib/api/v1/workItems/schema';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE VERDICT AT THE DOORS A SURFACE REACHES (Story MOTIR-6070 · Subtask MOTIR-6421; ADR
// `approval-gates.md` §10d). The door's rule is proven over kind × verb × source in
// `tests/approvalGates/refusalVerdict.test.ts`; this file holds the SEAMS on real Postgres:
// the REST route and the item page's server action pass `refusalVerdict` through beside
// `noteMd`, answer both typed refusals as a 4xx / a typed refusal, and every read that
// already carries the reason — the item page / overlay read, the Approvals room, the v1
// decision record and the MCP `get_approval_gate` payload — carries the verdict back out.

const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
const activeProject = { current: null as unknown };
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeProject.current,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { approvalGateAccessService } = await import('@/lib/services/approvalGateAccessService');
const { runGetApprovalGate } = await import('@/lib/mcp/tools/getApprovalGate');
const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');
const { decideApprovalGateAction } = await import('@/app/(authed)/items/[key]/approvalGateActions');

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  signedIn.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: fx.owner.name } };
  activeProject.current = { ...fx.ctx, projectId: fx.projectId, project: fx.project };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A bare `awaiting` gate, and the stamp its reader would have been shown. */
async function awaitingGate(kind: ApprovalGateKind) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `A ${kind} waiting for a person` },
    fx.ctx,
  );
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${kind}`,
      subjectVersion: 'v1',
      state: 'awaiting',
    },
  });
  const stamp = computeGateStamp({
    subjectVersion: 'v1',
    companionSubjectVersion: null,
    descriptionMd: item.descriptionMd ?? null,
  });
  return { gate, item, stamp };
}

async function viaRoute(gateId: string, body: Record<string, unknown>) {
  const res = await decideRoute(
    new Request(`http://localhost/api/approval-gates/${gateId}/decide`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: gateId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

describe('the REST route passes the verdict through', () => {
  it('a design refusal WITH a verdict → 200, stored on the row, carried on the response gate', async () => {
    const { gate, stamp } = await awaitingGate('design_result');

    const res = await viaRoute(gate.id, {
      decision: 'request_changes',
      noteMd: 'The empty state is missing.',
      refusalVerdict: 're_plan',
      stamp,
    });

    expect(res.status).toBe(200);
    expect(res.body.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: 're_plan' });
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'changes_requested',
      noteMd: 'The empty state is missing.',
      decisionSource: 'api',
      refusalVerdict: 're_plan',
    });
  });

  it('a design refusal WITHOUT one → 400 `refusal_verdict_required`; the gate still awaits', async () => {
    const { gate, stamp } = await awaitingGate('design_result');
    const res = await viaRoute(gate.id, {
      decision: 'request_changes',
      noteMd: 'The empty state is missing.',
      stamp,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'refusal_verdict_required',
    });
    expect(await gateRow(gate.id)).toMatchObject({ state: 'awaiting', refusalVerdict: null });
  });

  it('a verdict on another kind → 400 `refusal_verdict_not_offered`', async () => {
    const { gate, stamp } = await awaitingGate('decision_approval');
    const res = await viaRoute(gate.id, {
      decision: 'request_changes',
      noteMd: 'Not this direction.',
      refusalVerdict: 'revise',
      stamp,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'refusal_verdict_not_offered',
    });
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('a verdict on APPROVE → 400 `refusal_verdict_not_offered`', async () => {
    const { gate, stamp } = await awaitingGate('design_result');
    const res = await viaRoute(gate.id, { decision: 'approve', refusalVerdict: 'revise', stamp });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'refusal_verdict_not_offered' });
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('a malformed verdict is a 400 BAD_REQUEST before anything is locked', async () => {
    const { gate, stamp } = await awaitingGate('design_result');
    for (const refusalVerdict of ['scrap', 3, true, '']) {
      const res = await viaRoute(gate.id, {
        decision: 'request_changes',
        noteMd: 'x',
        refusalVerdict,
        stamp,
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('a verdict on the PLAN gate’s Decline → 400 `refusal_verdict_not_offered`', async () => {
    const { plansService } = await import('@/lib/services/plansService');
    const plan = await plansService.createPlan(fx.projectId, { title: 'A plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Proposed', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: null, kind: 'plan_approval', subjectId: plan.id, state: 'awaiting' },
    });
    const read = await approvalGatesService.getForPlan({ planId: plan.id }, fx.ctx);

    const res = await viaRoute(gate.id, {
      decision: 'decline',
      refusalVerdict: 're_plan',
      stamp: read.stamp!,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'refusal_verdict_not_offered' });
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });
});

describe('the server action passes the verdict through', () => {
  it('with a verdict → ok, stored as pressed in Motir', async () => {
    const { gate, item, stamp } = await awaitingGate('design_result');
    const result = await decideApprovalGateAction({
      gateId: gate.id,
      decision: 'request_changes',
      identifier: item.identifier,
      noteMd: 'Tighten the spacing.',
      refusalVerdict: 'revise',
      stamp,
    });
    expect(result).toMatchObject({ ok: true, gate: { refusalVerdict: 'revise' } });
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'changes_requested',
      decisionSource: 'ui',
      refusalVerdict: 'revise',
    });
  });

  it('without one → the typed refusal, and nothing written', async () => {
    const { gate, item, stamp } = await awaitingGate('design_result');
    const result = await decideApprovalGateAction({
      gateId: gate.id,
      decision: 'request_changes',
      identifier: item.identifier,
      noteMd: 'Tighten the spacing.',
      stamp,
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_VERB_NOT_OFFERED' },
    });
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });
});

describe('every read that carries the reason carries the verdict', () => {
  it('the item page / overlay read, the Approvals room, the v1 record and the MCP payload', async () => {
    const { gate, item, stamp } = await awaitingGate('design_result');
    const res = await viaRoute(gate.id, {
      decision: 'request_changes',
      noteMd: 'The plan around this is wrong.',
      refusalVerdict: 're_plan',
      stamp,
    });
    expect(res.status).toBe(200);

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );
    expect(read.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: 're_plan' });

    const room = await approvalGatesService.listRecords(
      { ...fx.ctx, projectId: fx.projectId },
      { limit: 100 },
    );
    const row = room.sections.decided.items.find((r) => r.gateId === gate.id);
    expect(row).toMatchObject({
      state: 'changes_requested',
      refusalReason: 'The plan around this is wrong.',
      refusalVerdict: 're_plan',
    });

    const record = await approvalGateAccessService.getGateRecord(
      { key: item.identifier, kind: 'design_result' },
      fx.ctx,
    );
    expect(record.gate).toMatchObject({ refusalVerdict: 're_plan' });
    expect(presentApprovalGateRecord(record).gate).toMatchObject({ refusalVerdict: 're_plan' });

    const tool = await runGetApprovalGate({ key: item.identifier, kind: 'design_result' }, fx.ctx);
    expect(tool.structuredContent).toMatchObject({ gate: { refusalVerdict: 're_plan' } });
    const text = tool.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('verdict: re_plan');
  });

  it('a gate decided without a verdict reads NULL everywhere', async () => {
    const { gate, item, stamp } = await awaitingGate('pull_request_approval');
    await viaRoute(gate.id, { decision: 'request_changes', noteMd: 'No.', stamp });
    const record = await approvalGateAccessService.getGateRecord(
      { key: item.identifier, kind: 'pull_request_approval' },
      fx.ctx,
    );
    expect(record.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: null });
  });
});
