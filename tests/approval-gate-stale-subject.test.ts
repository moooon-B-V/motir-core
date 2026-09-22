import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateStaleSubjectError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { APPROVAL_GATE_STATUS } from '@/lib/approvalGates/httpStatus';
import { toGateRefusal } from '@/lib/approvalGates/refusals';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// A STALE RESULT CANNOT BE APPROVED (Story MOTIR-5232 · Subtask MOTIR-5234; ADR
// docs/decisions/approval-gates.md §6b's MOTIR-5234 amendment), against a REAL
// Postgres.
//
// The door already refused a WITHDRAWN question. What it could not do was tell a
// press from a page rendered a second ago from a press from a page rendered an hour
// ago: nothing the reader saw was recorded. The read now hands out a STAMP, the
// press hands it back, and the door recomputes it under the lock. Asserted here:
//
//   · editing the card's acceptance criteria makes a pending decision stale, with no
//     republish involved — the half nothing caught before;
//   · a design press whose companion MERGE gate's pull requests moved is refused as
//     `pull_requests`, and NEITHER gate is decided;
//   · a refusal writes NOTHING;
//   · a field nobody was deciding about never makes a decision stale;
//   · the state refusals run FIRST, so a withdrawn question is never reported stale.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A design subtask in review, carrying an awaiting design gate — and, when asked, the
 *  card's awaiting approve-to-merge gate beside it (a design with a pull request). */
async function designCard(opts: { withMergeGate?: boolean } = {}) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: story.id,
      title: 'Draw the frame',
      descriptionMd: '## Acceptance criteria\n\n- the frame is drawn',
    },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  const create = (kind: 'design_result' | 'pull_request_approval', subjectVersion: string) =>
    withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind,
          subjectId: kind === 'design_result' ? `design-evidence-${item.id}` : item.id,
          subjectVersion,
        },
        tx,
      ),
    );
  const gate = await create('design_result', 'design-sha-1');
  const mergeGate = opts.withMergeGate
    ? await create('pull_request_approval', 'acme/web#7@aaa')
    : null;
  return { item, gate, mergeGate };
}

async function stampOf(workItemId: string, kind: 'design_result' | 'pull_request_approval') {
  const read = await approvalGatesService.getForWorkItem({ workItemId, kind }, fx.ctx);
  expect(read.stamp).toEqual(expect.any(String));
  return read.stamp!;
}

async function expectUntouched(gateId: string, itemId: string, statusBefore: string) {
  const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } });
  expect(row.state).toBe('awaiting');
  expect(row.decidedById).toBeNull();
  expect(row.decidedAt).toBeNull();
  expect(row.decisionSource).toBeNull();
  expect(row.outcomeRef).toBeNull();
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: itemId } });
  expect(item.status).toBe(statusBefore);
}

describe('the read hands out a stamp', () => {
  it('stamps an awaiting gate, and a decided one not at all', async () => {
    const { item, gate } = await designCard();
    expect(await stampOf(item.id, 'design_result')).toMatch(/^v1\./);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    const after = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );
    expect(after.gate?.state).toBe('approved');
    expect(after.stamp).toBeNull();
  });
});

describe('a press with the stamp it was shown', () => {
  it('lands when nothing moved', async () => {
    const { item, gate } = await designCard();
    const stamp = await stampOf(item.id, 'design_result');
    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp },
      fx.ctx,
    );
    expect(result.gate.state).toBe('approved');
  });
});

describe('a press against a stamp that has MOVED is refused, and writes nothing', () => {
  it('the ACCEPTANCE CRITERIA were edited — no republish involved', async () => {
    const { item, gate } = await designCard();
    const stamp = await stampOf(item.id, 'design_result');
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { descriptionMd: '## Acceptance criteria\n\n- the frame is drawn, in zh too' },
    });

    const refusal = await approvalGatesService
      .decide({ gateId: gate.id, decision: 'approve', source: 'ui', stamp }, fx.ctx)
      .catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ApprovalGateStaleSubjectError);
    expect((refusal as ApprovalGateStaleSubjectError).moved).toEqual(['criteria']);
    await expectUntouched(gate.id, item.id, 'in_review');
  });

  it('the SUBJECT moved under a live question — the version it was asked about changed', async () => {
    const { item, gate } = await designCard();
    const stamp = await stampOf(item.id, 'design_result');
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { subjectVersion: 'design-sha-2' },
    });

    await expect(
      approvalGatesService.decide(
        {
          gateId: gate.id,
          decision: 'request_changes',
          noteMd: 'Needs changes.',
          source: 'ui',
          stamp,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ tag: 'APPROVAL_GATE_STALE_SUBJECT', moved: ['subject'] });
    await expectUntouched(gate.id, item.id, 'in_review');
  });

  it('a DESIGN press whose pull requests moved is refused as `pull_requests`, and NEITHER gate is decided', async () => {
    const { item, gate, mergeGate } = await designCard({ withMergeGate: true });
    const stamp = await stampOf(item.id, 'design_result');
    // A push: the old merge question is withdrawn and a new one asks about new commits.
    await adminDb.approvalGate.update({
      where: { id: mergeGate!.id },
      data: { state: 'superseded', supersededCause: 'head_moved' },
    });
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'pull_request_approval',
          subjectId: item.id,
          subjectVersion: 'acme/web#7@bbb',
        },
        tx,
      ),
    );

    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve', source: 'ui', stamp },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ moved: ['pull_requests'] });
    await expectUntouched(gate.id, item.id, 'in_review');
    const awaitingMerge = await adminDb.approvalGate.findMany({
      where: { workItemId: item.id, kind: 'pull_request_approval', state: 'awaiting' },
    });
    expect(awaitingMerge).toHaveLength(1);
  });

  it('a pressed MERGE gate reports its own subject as its pull requests', async () => {
    const { item, mergeGate } = await designCard({ withMergeGate: true });
    const stamp = await stampOf(item.id, 'pull_request_approval');
    await adminDb.approvalGate.update({
      where: { id: mergeGate!.id },
      data: { subjectVersion: 'acme/web#7@ccc' },
    });
    await expect(
      approvalGatesService.decide(
        {
          gateId: mergeGate!.id,
          decision: 'request_changes',
          noteMd: 'Needs changes.',
          source: 'ui',
          stamp,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ moved: ['pull_requests'] });
  });
});

describe('what the stamp does NOT cover', () => {
  it('the assignee, a label, the status and a watcher never make a decision stale', async () => {
    const { item, gate } = await designCard();
    const stamp = await stampOf(item.id, 'design_result');
    const other = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: other.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    const label = await adminDb.label.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Frontend',
        nameLower: 'frontend',
      },
    });

    // Each written directly: the question is what the STAMP reads, not what a door allows.
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
    await adminDb.workItemLabel.create({ data: { workItemId: item.id, labelId: label.id } });
    await adminDb.watcher.create({ data: { workItemId: item.id, userId: other.id } });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { updatedAt: new Date(Date.now() + 60_000) },
    });
    // The status too: moved away and back, and the stamp never noticed either write.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'blocked' } });
    expect(await stampOf(item.id, 'design_result')).toBe(stamp);
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_review' } });
    expect(await stampOf(item.id, 'design_result')).toBe(stamp);

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp },
      fx.ctx,
    );
    expect(result.gate.state).toBe('approved');
  });
});

describe('the STATE refusals run first', () => {
  it('a republished (superseded) question is WITHDRAWN, never stale — even with a moved stamp', async () => {
    const { item, gate } = await designCard();
    const stamp = await stampOf(item.id, 'design_result');
    await adminDb.workItem.update({ where: { id: item.id }, data: { descriptionMd: 'changed' } });
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { state: 'superseded', supersededCause: 'republished' },
    });
    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve', source: 'ui', stamp },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);
  });

  it('an answered question is ALREADY DECIDED, never stale', async () => {
    const { item, gate } = await designCard();
    const stamp = await stampOf(item.id, 'design_result');
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: item.id }, data: { descriptionMd: 'changed' } });
    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve', source: 'ui', stamp },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyDecidedError);
  });
});

describe('the refusal on the wire', () => {
  it('is a 409 and narrows to a typed member carrying what moved', () => {
    expect(APPROVAL_GATE_STATUS.APPROVAL_GATE_STALE_SUBJECT).toBe(409);
    expect(toGateRefusal('APPROVAL_GATE_STALE_SUBJECT', { moved: ['criteria'] })).toEqual({
      tag: 'APPROVAL_GATE_STALE_SUBJECT',
      moved: ['criteria'],
    });
    // A caller that could not say what moved names all three — never an empty list.
    expect(toGateRefusal('APPROVAL_GATE_STALE_SUBJECT')).toEqual({
      tag: 'APPROVAL_GATE_STALE_SUBJECT',
      moved: ['subject', 'pull_requests', 'criteria'],
    });
  });
});
