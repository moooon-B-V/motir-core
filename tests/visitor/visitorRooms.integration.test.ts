import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { planReviewService } from '@/lib/services/planReviewService';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Plans, Approvals and Runs as a Visitor reads them (Story MOTIR-6170 ·
// MOTIR-6645), through the real resolver and datastore. A public project holds a
// private epic E with a child C, and a visible item V. Each room offers the
// Visitor its Project view alone, omits every record that joins C, and answers a
// withheld record read by id exactly as an unknown id; a member's rooms are
// unchanged.

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function roomsFixture() {
  const identifier = `VR${seq++}`;
  const fx = await makeWorkItemFixture({ name: `VR ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { accessMode: 'public', accessLevel: 'public' },
  });
  const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic E' });
  const hidden = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Hidden story C',
    parentId: epic.id,
  });
  const visible = await createTestWorkItem(fx, { kind: 'story', title: 'Visible story V' });
  await adminDb.workItem.update({ where: { id: epic.id }, data: { publicChildrenHidden: true } });

  const base = { workspaceId: fx.workspaceId, projectId: fx.projectId };
  // P1 proposes a change to C; P2 touches only V. Each in its own session.
  const s1 = await adminDb.planChangeSession.create({ data: { ...base, targetKeys: [] } });
  const p1 = await adminDb.plan.create({
    data: { ...base, sessionId: s1.id, status: 'planned', title: 'Reshape C' },
  });
  await adminDb.planItem.create({
    data: { workspaceId: fx.workspaceId, planId: p1.id, op: 'modify', workItemId: hidden.id },
  });
  const s2 = await adminDb.planChangeSession.create({ data: { ...base, targetKeys: [] } });
  const p2 = await adminDb.plan.create({
    data: { ...base, sessionId: s2.id, status: 'planned', title: 'Reshape V' },
  });
  await adminDb.planItem.create({
    data: { workspaceId: fx.workspaceId, planId: p2.id, op: 'modify', workItemId: visible.id },
  });

  // Approval records: one on C, one on V, and the card-less plan gate of each plan.
  const gate = (
    workItemId: string | null,
    kind: 'design_result' | 'plan_approval',
    subjectId: string,
  ) =>
    adminDb.approvalGate.create({
      data: { ...base, workItemId, kind, subjectId, state: 'awaiting' },
    });
  const gateOnC = await gate(hidden.id, 'design_result', `sub-${hidden.id}`);
  const gateOnV = await gate(visible.id, 'design_result', `sub-${visible.id}`);
  const gateOnP1 = await gate(null, 'plan_approval', p1.id);
  const gateOnP2 = await gate(null, 'plan_approval', p2.id);

  // Runs: one scoped to C, one scoped to V.
  const run = (scopeWorkItemId: string) =>
    adminDb.dispatchRun.create({
      data: {
        ...base,
        command: 'run_scope',
        status: 'running',
        scopeWorkItemId,
        cards: {
          create: { workspaceId: fx.workspaceId, workItemId: scopeWorkItemId, position: 0 },
        },
      },
    });
  const runOnC = await run(hidden.id);
  const runOnV = await run(visible.id);

  const verdict = await projectAccessService.resolveVisitor(identifier, null);
  if (verdict.kind !== 'visitor') throw new Error(`expected a visitor, got ${verdict.kind}`);
  return {
    fx,
    identifier,
    visitor: verdict.ctx as VisitorReadContext,
    sessions: { hidden: s1.id, visible: s2.id },
    plans: { hidden: p1.id, visible: p2.id },
    gates: { onC: gateOnC.id, onV: gateOnV.id, onP1: gateOnP1.id, onP2: gateOnP2.id },
    runs: { onC: runOnC.id, onV: runOnV.id },
  };
}

describe('the Plans room', () => {
  it('a Visitor sees the visible session only, counts only it, and cannot open P1 by id', async () => {
    const t = await roomsFixture();
    const page = await planSessionsService.listSessions(t.fx.projectId, t.visitor);
    expect(page.sessions.map((s) => s.id)).toEqual([t.sessions.visible]);
    const counts = await planSessionsService.countSessionsByPlanState(t.fx.projectId, t.visitor);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
    expect(
      await planSessionsService.getSessionRow(t.fx.projectId, t.sessions.hidden, t.visitor),
    ).toBeNull();
    expect(await planSessionsService.roomAccess(t.fx.projectId, t.visitor)).toEqual({
      views: ['project'],
      canAuthor: false,
    });

    const hiddenErr = await planReviewService
      .getPlanReview(t.plans.hidden, t.visitor)
      .catch((e: unknown) => e);
    const unknownErr = await planReviewService
      .getPlanReview('cm-not-a-plan', t.visitor)
      .catch((e: unknown) => e);
    expect(hiddenErr).toBeInstanceOf(Error);
    expect((hiddenErr as Error).name).toBe((unknownErr as Error).name);
    expect((hiddenErr as { code?: string }).code).toBe((unknownErr as { code?: string }).code);
    const visible = await planReviewService.getPlanReview(t.plans.visible, t.visitor);
    expect(visible.id).toBe(t.plans.visible);
  });

  it('a member sees both sessions', async () => {
    const t = await roomsFixture();
    const page = await planSessionsService.listSessions(t.fx.projectId, t.fx.ctx);
    expect(page.sessions.map((s) => s.id).sort()).toEqual(
      [t.sessions.hidden, t.sessions.visible].sort(),
    );
  });
});

describe('the Approvals room', () => {
  it('a Visitor sees only records on visible work and visible plans, and decides nothing', async () => {
    const t = await roomsFixture();
    const records = await approvalGatesService.listRecords(t.visitor, { view: 'mine' });
    expect(records.views).toEqual(['project']);
    expect(records.scope).toBe('project');
    const ids = records.sections.awaiting.items.map((r) => r.gateId).sort();
    expect(ids).toEqual([t.gates.onV, t.gates.onP2].sort());
    expect(records.sections.awaiting.total).toBe(2);
    expect(records.total).toBe(2);
    expect(records.sections.awaiting.items.every((r) => r.canDecide === false)).toBe(true);
    expect(await approvalGatesService.recordViews(t.visitor)).toEqual(['project']);
  });

  it('a member sees all four records', async () => {
    const t = await roomsFixture();
    const records = await approvalGatesService.listRecords(
      { ...t.fx.ctx, projectId: t.fx.projectId },
      { view: 'project' },
    );
    expect(records.sections.awaiting.total).toBe(4);
  });
});

describe('the Runs room', () => {
  it('a Visitor lists the visible run only, and the hidden run by id is an unknown run', async () => {
    const t = await roomsFixture();
    const page = await dispatchRunService.listRunsForProject(t.identifier, { take: 20 }, t.visitor);
    expect(page.runs.map((r) => r.id)).toEqual([t.runs.onV]);
    const active = await dispatchRunService.listActiveRunsForProject(t.identifier, t.visitor);
    expect(active.runs.map((r) => r.id)).toEqual([t.runs.onV]);
    expect(await dispatchRunService.roomAccess(t.identifier, t.visitor)).toEqual({
      views: ['project'],
      canRun: false,
    });

    const hiddenErr = await dispatchRunService
      .getRunDetail(t.runs.onC, t.visitor)
      .catch((e: unknown) => e);
    const unknownErr = await dispatchRunService
      .getRunDetail('cm-not-a-run', t.visitor)
      .catch((e: unknown) => e);
    expect((hiddenErr as Error).name).toBe((unknownErr as Error).name);
    expect((hiddenErr as Error).name).toBe('DispatchRunNotFoundError');
    const visible = await dispatchRunService.getRunDetail(t.runs.onV, t.visitor);
    expect(visible.id).toBe(t.runs.onV);
  });

  it('a member lists both runs', async () => {
    const t = await roomsFixture();
    const page = await dispatchRunService.listRunsForProject(
      t.identifier,
      { take: 20, view: 'project' },
      t.fx.ctx,
    );
    expect(page.runs.map((r) => r.id).sort()).toEqual([t.runs.onC, t.runs.onV].sort());
  });
});
