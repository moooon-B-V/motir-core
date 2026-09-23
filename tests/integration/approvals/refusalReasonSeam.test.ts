import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { computeGateStamp } from '@/lib/approvalGates/stamp';
import { APPROVAL_GATE_STATUS } from '@/lib/approvalGates/httpStatus';
import { APPROVAL_GATE_HANDLERS } from '@/lib/approvalGates/registry';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY GATE — A REFUSAL SAYS WHY (Story MOTIR-6067 · Subtask MOTIR-6076; ADR
// `approval-gates.md` §10a–§10b). The builder cards each test their own half: the door
// (`tests/approvalGates/refusalReason.test.ts`, via the service), the GitHub body
// (`tests/github/reviewEvaluator.test.ts`, `pullRequestReviewWebhook.test.ts`) and the
// surfaces (`tests/components/refusal-reason.test.tsx`). This file holds the SEAMS
// between them, on real Postgres: a person's refusal through BOTH doors a surface
// reaches — the REST route and the item page's server action — for every kind that
// offers the verb, and the read the screens consume carrying the reason back out.

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

/**
 * Every kind whose refusal is `request_changes` — the kinds this story's rule covers.
 * `decision_confirmation`'s refusal is Overturn, which carried its own required note first.
 */
const COVERED: readonly ApprovalGateKind[] = [
  'acceptance_result',
  'decision_approval',
  'decision_choice',
  'design_result',
  'pull_request_approval',
];
const REFUSES_BY_OVERTURN: readonly ApprovalGateKind[] = ['decision_confirmation'];
/** The PLAN gate's refusal is Decline, whose reason is OPTIONAL by design (ADR §11.4 —
 *  a stated departure from §10a), and it offers no `request_changes` at all (MOTIR-6035). */
const REFUSES_BY_DECLINE: readonly ApprovalGateKind[] = ['plan_approval'];

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

describe('the rule is TOTAL over the registry — a new kind that offers the verb must be covered', () => {
  it('every registered kind is either covered by the reason rule or refuses by Overturn', () => {
    // ⚠️ THE GUARD A PERCENTAGE CANNOT SEE. The door's rule keys on the VERB, so a new
    // kind inherits it — but this spec is where that inheritance is PROVEN per kind, and
    // a kind added to the registry without a row here fails on this line first.
    const registered = Object.keys(APPROVAL_GATE_HANDLERS).sort();
    expect(registered).toEqual([...COVERED, ...REFUSES_BY_OVERTURN, ...REFUSES_BY_DECLINE].sort());
  });

  it('the typed refusal maps to a 4xx', () => {
    expect(APPROVAL_GATE_STATUS.APPROVAL_GATE_VERB_NOT_OFFERED).toBe(400);
  });
});

describe('an EMPTY refusal is refused at BOTH doors, for every covered kind', () => {
  for (const kind of COVERED) {
    it(`${kind} · the REST route answers 400 with the code and reason; the gate still awaits`, async () => {
      const { gate, stamp } = await awaitingGate(kind);

      const res = await viaRoute(gate.id, { decision: 'request_changes', noteMd: '  ', stamp });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
        reason: 'request_changes_needs_a_note',
      });
      expect(await gateRow(gate.id)).toMatchObject({ state: 'awaiting', noteMd: null });
    });

    it(`${kind} · the server action refuses it with the same typed refusal`, async () => {
      const { gate, item, stamp } = await awaitingGate(kind);

      const result = await decideApprovalGateAction({
        gateId: gate.id,
        decision: 'request_changes',
        identifier: item.identifier,
        stamp,
      });

      expect(result).toMatchObject({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_VERB_NOT_OFFERED' },
      });
      expect((await gateRow(gate.id)).state).toBe('awaiting');
    });
  }
});

describe('a refusal WITH a reason reaches the row, and the read carries it back out', () => {
  it('through the REST route: stored verbatim, frozen, read back with its source', async () => {
    const { gate, item, stamp } = await awaitingGate('pull_request_approval');

    const res = await viaRoute(gate.id, {
      decision: 'request_changes',
      noteMd: 'The retry loop never backs off.',
      stamp,
    });

    expect(res.status).toBe(200);
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'changes_requested',
      noteMd: 'The retry loop never backs off.',
      decisionSource: 'api',
    });
    // The read the item page and the overlay consume — the stored row through the real mapper.
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'pull_request_approval' },
      fx.ctx,
    );
    expect(read.gate).toMatchObject({
      state: 'changes_requested',
      noteMd: 'The retry loop never backs off.',
      decisionSource: 'api',
    });
    // Frozen: the decided-row trigger refuses a rewrite of the reason.
    await expect(
      adminDb.approvalGate.update({ where: { id: gate.id }, data: { noteMd: 'rewritten' } }),
    ).rejects.toThrow();
  });

  it('through the server action: stored, and read back as pressed in Motir', async () => {
    const { gate, item, stamp } = await awaitingGate('pull_request_approval');

    const result = await decideApprovalGateAction({
      gateId: gate.id,
      decision: 'request_changes',
      identifier: item.identifier,
      stamp,
      noteMd: 'Split the migration from the backfill.',
    });

    expect(result).toMatchObject({ ok: true });
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'changes_requested',
      noteMd: 'Split the migration from the backfill.',
      decisionSource: 'ui',
    });
  });

  it('Overturn keeps its own required-note rule, unchanged', async () => {
    const { gate, stamp } = await awaitingGate('decision_confirmation');
    const res = await viaRoute(gate.id, { decision: 'overturn', noteMd: '', stamp });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'overturn_needs_a_note' });
  });
});

describe('the PLAN gate at the REST route (MOTIR-6035; ADR §11.4) — Decline, and no Request changes', () => {
  /** A `planned` plan with one proposal, and the awaiting gate MOTIR-6036 will raise. */
  async function plannedPlanGate() {
    const { plansService } = await import('@/lib/services/plansService');
    const plan = await plansService.createPlan(fx.projectId, { title: 'A plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Proposed', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: null,
        kind: 'plan_approval',
        subjectId: plan.id,
        routedToId: fx.ownerId,
      },
    });
    const read = await approvalGatesService.getForPlan({ planId: plan.id }, fx.ctx);
    return { plan, gate, stamp: read.stamp! };
  }

  it('`request_changes` is refused 400 with reason `request_changes_on_plan`, even WITH a note', async () => {
    const { gate, stamp } = await plannedPlanGate();
    const res = await viaRoute(gate.id, {
      decision: 'request_changes',
      noteMd: 'Split it differently.',
      stamp,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'request_changes_on_plan',
    });
    expect(await gateRow(gate.id)).toMatchObject({ state: 'awaiting', noteMd: null });
  });

  it('`decline` with NO reason is accepted: the gate is `declined` and the plan `declined` / `reviewed`', async () => {
    const { plan, gate, stamp } = await plannedPlanGate();
    const res = await viaRoute(gate.id, { decision: 'decline', stamp });
    expect(res.status).toBe(200);
    // The post-commit hook never crosses the wire.
    expect(res.body.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'plan_decision_writes_no_work_item',
    });
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'declined',
      noteMd: null,
      decisionSource: 'api',
      decidedUnderAuthority: 'plan_permission',
    });
    expect(await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({
      status: 'declined',
      decisionReason: 'reviewed',
    });
  });

  it('`decline` on a card kind is refused 400 with reason `decline_on_other_kind`', async () => {
    const { gate, stamp } = await awaitingGate('design_result');
    const res = await viaRoute(gate.id, { decision: 'decline', stamp });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'decline_on_other_kind' });
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('a HELD plan answers 409 with who holds it and until when; the gate still awaits', async () => {
    const { plansService } = await import('@/lib/services/plansService');
    const { plan, gate, stamp } = await plannedPlanGate();
    await plansService.acquireRevisionLease(plan.id, fx.ctx, {
      source: 'mcp',
      harness: 'Claude Code',
      model: null,
    });
    const res = await viaRoute(gate.id, { decision: 'approve', stamp });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PLAN_REVISION_IN_FLIGHT', heldBy: 'Claude Code' });
    expect(typeof res.body.expiresAt).toBe('string');
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('a plan no longer `planned` answers 409 PLAN_NOT_IN_EXPECTED_STATUS', async () => {
    const { plan, gate, stamp } = await plannedPlanGate();
    await adminDb.plan.update({ where: { id: plan.id }, data: { status: 'stale' } });
    const res = await viaRoute(gate.id, { decision: 'decline', stamp });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PLAN_NOT_IN_EXPECTED_STATUS' });
  });

  it('an unknown verb names `decline` among the five', async () => {
    const { gate, stamp } = await plannedPlanGate();
    const res = await viaRoute(gate.id, { decision: 'reject', stamp });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('`decline`');
  });
});
