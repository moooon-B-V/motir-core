import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { APPROVAL_GATE_HANDLERS } from '@/lib/approvalGates/registry';
import { ApprovalGateSupersededError } from '@/lib/approvalGates/errors';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// A QUESTION ABOUT ABANDONED WORK IS WITHDRAWN, EVERY KIND ALIKE (Bug MOTIR-7109).
//
// MOTIR-5527 withdrew a card's `awaiting` gates on a HAND move to Cancelled. Three
// routes still left one standing — approvable, with the status and merge its approval
// carries, for work nobody intends to finish:
//
//   · ARCHIVE, which is not a status transition and never reached the funnel;
//   · a SYSTEM move to Cancelled, which the pull-back rule exempts;
//   · a gate that predates both writers, which the decide door accepted.
//
// Proven over EVERY card kind the registry dispatches, so a kind added later is held
// to it by this file rather than by somebody remembering. Real Postgres, per the repo
// convention.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
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
  (kind) => kind !== 'plan_approval',
);

let seq = 0;

async function card(status: 'in_progress' | 'in_review' = 'in_review') {
  seq += 1;
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Task ${seq}` },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  if (status === 'in_review') await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  return item.id;
}

/** One `awaiting` gate of `kind` on the card, raised straight through the repository. */
async function raise(itemId: string, kind: ApprovalGateKind) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: itemId,
        kind,
        subjectId: `subject-${kind}-${itemId}`,
      },
      tx,
    ),
  );
}

async function raiseEveryKind(itemId: string) {
  const ids: string[] = [];
  for (const kind of CARD_KINDS) ids.push((await raise(itemId, kind)).id);
  return ids;
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const gateRows = (ids: string[]) =>
  adminDb.approvalGate.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });

function expectWithdrawn(rows: Awaited<ReturnType<typeof gateRows>>, count: number) {
  expect(rows).toHaveLength(count);
  for (const row of rows) {
    expect(row.state).toBe('superseded');
    expect(row.supersededCause).toBe('pulled_back');
    // A withdrawal is never a decision.
    expect(row.decidedById).toBeNull();
    expect(row.decidedAt).toBeNull();
  }
}

describe('archiving a card withdraws every question on it', () => {
  it('supersedes an awaiting gate of EVERY registered card kind', async () => {
    expect(CARD_KINDS.length).toBeGreaterThanOrEqual(5);
    const itemId = await card();
    const ids = await raiseEveryKind(itemId);

    await workItemsService.archiveWorkItem(itemId, fx.ctx);

    expectWithdrawn(await gateRows(ids), CARD_KINDS.length);
  });

  it('leaves a DECIDED gate exactly as it was', async () => {
    const itemId = await card();
    const gate = await raise(itemId, 'design_result');
    await adminDb.approvalGate.update({ where: { id: gate.id }, data: { state: 'approved' } });

    await workItemsService.archiveWorkItem(itemId, fx.ctx);

    expect((await gateRow(gate.id)).state).toBe('approved');
  });

  it('touches no OTHER card', async () => {
    const archived = await card();
    const other = await card();
    const kept = await raise(other, 'design_result');
    await raise(archived, 'design_result');

    await workItemsService.archiveWorkItem(archived, fx.ctx);

    expect((await gateRow(kept.id)).state).toBe('awaiting');
  });

  it('unarchiving does NOT bring the question back', async () => {
    const itemId = await card();
    const gate = await raise(itemId, 'decision_approval');

    await workItemsService.archiveWorkItem(itemId, fx.ctx);
    await workItemsService.unarchiveWorkItem(itemId, fx.ctx);

    expect((await gateRow(gate.id)).state).toBe('superseded');
  });
});

describe('a move to Cancelled withdraws every question, whoever writes it', () => {
  it('a SYSTEM move to Cancelled supersedes every kind — the pull-back exemption does not reach it', async () => {
    const itemId = await card();
    const ids = await raiseEveryKind(itemId);

    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemsService.applyStatusTransition(itemId, 'cancelled', fx.ctx, tx, { system: true }),
    );

    expectWithdrawn(await gateRows(ids), CARD_KINDS.length);
  });

  it('a hand move to Cancelled from BELOW review supersedes it too', async () => {
    const itemId = await card('in_progress');
    const gate = await raise(itemId, 'decision_choice');

    await workItemsService.updateStatus(itemId, 'cancelled', fx.ctx);

    expectWithdrawn(await gateRows([gate.id]), 1);
  });

  it("the decide door's OWN move to Cancelled keeps its deciding gate and withdraws the rest", async () => {
    const itemId = await card();
    const deciding = await raise(itemId, 'decision_confirmation');
    const other = await raise(itemId, 'design_result');

    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemsService.applyStatusTransition(itemId, 'cancelled', fx.ctx, tx, {
        decidingGateId: deciding.id,
      }),
    );

    const decidingRow = await gateRow(deciding.id);
    expect(decidingRow.state).toBe('awaiting');
    expect(decidingRow.supersededCause).toBeNull();
    expectWithdrawn(await gateRows([other.id]), 1);
  });

  it('a system move that does NOT cancel still withdraws nothing (rule 6 unchanged)', async () => {
    const itemId = await card();
    const gate = await raise(itemId, 'design_result');

    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemsService.applyStatusTransition(itemId, 'in_progress', fx.ctx, tx, { system: true }),
    );

    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });
});

describe('the decide door refuses a question about abandoned work', () => {
  // The backstop: a gate left `awaiting` on such a card by anything that predates the
  // withdrawing writers. Built by writing the card's state straight to the row, which
  // is exactly the state no live writer can produce any more.
  const decide = (gateId: string) =>
    approvalGatesService.decide(
      { gateId, decision: 'approve', stamp: DECIDED_WITHOUT_A_READER, source: 'ui' },
      fx.ctx,
    );

  it('refuses an awaiting gate on an ARCHIVED card as withdrawn, and records nothing', async () => {
    const itemId = await card();
    const gate = await raise(itemId, 'design_result');
    await adminDb.workItem.update({ where: { id: itemId }, data: { archivedAt: new Date() } });

    const err = await decide(gate.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateSupersededError);
    expect((err as ApprovalGateSupersededError).supersedeCause).toBe('pulled_back');

    const row = await gateRow(gate.id);
    expect(row.state).toBe('awaiting');
    expect(row.decidedAt).toBeNull();
  });

  it('refuses an awaiting gate on a CANCELLED card', async () => {
    const itemId = await card();
    const gate = await raise(itemId, 'decision_approval');
    await adminDb.workItem.update({ where: { id: itemId }, data: { status: 'cancelled' } });

    await expect(decide(gate.id)).rejects.toBeInstanceOf(ApprovalGateSupersededError);
    expect((await gateRow(gate.id)).decidedAt).toBeNull();
  });

  it('refuses a gate the archive withdrew, through the ordinary superseded refusal', async () => {
    const itemId = await card();
    const gate = await raise(itemId, 'design_result');
    await workItemsService.archiveWorkItem(itemId, fx.ctx);

    await expect(decide(gate.id)).rejects.toBeInstanceOf(ApprovalGateSupersededError);
  });
});
