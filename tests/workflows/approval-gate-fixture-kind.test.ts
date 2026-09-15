import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import type { GateEffect, GateHandler } from '@/lib/approvalGates/registry';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// THE GUARD FOLLOWS THE REGISTRY, NOT A LITERAL (Story MOTIR-4887 · MOTIR-5530;
// ADR `approval-gates.md` §6d AMENDMENT, rule 1). `decision_approval` is a real
// enum member this build does NOT register; this file registers a FIXTURE handler
// for it whose intent owns `approved`, and an `awaiting` row of that kind must then
// hold exactly that move. It is the proof that a kind registered later inherits
// the guard with no line of guard code. The registry mock is scoped to this file.

const fixtureDecisionHandler: GateHandler = {
  async resolveSubject() {
    return null;
  },
  async subjectVersion() {
    return null;
  },
  async currentSubject() {
    return null;
  },
  routeTo() {
    return null;
  },
  permission: 'work_item:edit',
  statusIntent: { key: 'approved', category: 'in_progress' },
  async approve(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};

vi.mock('@/lib/approvalGates/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/approvalGates/registry')>();
  return {
    ...actual,
    isRegisteredGateKind: (kind: ApprovalGateKind) =>
      kind === 'decision_approval' || actual.isRegisteredGateKind(kind),
    handlerFor: (kind: ApprovalGateKind) =>
      kind === 'decision_approval' ? fixtureDecisionHandler : actual.handlerFor(kind),
  };
});

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { ApprovalGatePendingError } = await import('@/lib/workItems/errors');

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function cardWithDecisionGate() {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Decide' },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'A decision' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'decision_approval',
        subjectId: `decision-${item.id}`,
      },
      tx,
    ),
  );
  return item;
}

describe('a fixture kind owning `approved` drives the guard', () => {
  it('refuses `in_review → approved` naming the fixture kind', async () => {
    const item = await cardWithDecisionGate();

    const err = await workItemsService.updateStatus(item.id, 'approved', fx.ctx).catch((e) => e);

    expect(err).toBeInstanceOf(ApprovalGatePendingError);
    expect(err).toMatchObject({ gateKind: 'decision_approval', waitingOn: 'decision' });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_review',
    );
  });

  it('permits `→ in_progress` — only the owned move is held', async () => {
    const item = await cardWithDecisionGate();
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_progress',
    );
  });

  it('does NOT hold Done — the fixture kind owns `approved`, not Done', async () => {
    const item = await cardWithDecisionGate();
    await workItemsService.updateStatus(item.id, 'done', fx.ctx);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'done',
    );
  });
});
