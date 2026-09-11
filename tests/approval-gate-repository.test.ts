import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { ApprovalGateAlreadyAwaitingError } from '@/lib/approvalGates/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// approvalGateRepository — single-op data access for the `approval_gate` table
// (Story MOTIR-4778 · Subtask MOTIR-4788; ADR docs/decisions/approval-gates.md)
// against a REAL Postgres. The load-bearing assertion is the partial-unique
// concurrency one: two concurrent inserts for the same
// (workItem, kind, subject) leave exactly one `awaiting` gate, and the LOSER
// surfaces a typed `ApprovalGateAlreadyAwaitingError` — never a raw `P2002`
// (the concurrency rule in CLAUDE.md).
//
// `truncateAuthTables()` CASCADEs through `workspace` → `work_item` →
// `approval_gate`, so the table under test is empty each run; the explicit
// `approval_gate` truncate is defensive.

let fx: WorkItemFixture;
let itemId: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Gate host' },
    fx.ctx,
  );
  itemId = item.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const gate = (subjectId: string) => ({
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  workItemId: itemId,
  kind: 'design_result' as const,
  subjectId,
});

describe('approvalGateRepository.create + findAwaitingByWorkItem', () => {
  it('creates an awaiting gate and reads it back on the card', async () => {
    await withWorkspaceContext(fx.ctx, (tx) => approvalGateRepository.create(gate('subj-1'), tx));
    const rows = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(itemId, tx),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workItemId: itemId,
      kind: 'design_result',
      subjectId: 'subj-1',
      state: 'awaiting',
      decidedById: null,
      decidedAt: null,
    });
  });

  it('two gates with DIFFERENT subjects coexist — the partial unique is per-subject', async () => {
    await withWorkspaceContext(fx.ctx, (tx) => approvalGateRepository.create(gate('subj-1'), tx));
    await withWorkspaceContext(fx.ctx, (tx) => approvalGateRepository.create(gate('subj-2'), tx));
    const rows = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(itemId, tx),
    );
    expect(rows.map((r) => r.subjectId).sort()).toEqual(['subj-1', 'subj-2']);
  });
});

describe('approvalGateRepository.create — partial-unique race', () => {
  it('a second insert for the SAME (workItem, kind, subject) throws the typed error', async () => {
    await withWorkspaceContext(fx.ctx, (tx) => approvalGateRepository.create(gate('subj-1'), tx));
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => approvalGateRepository.create(gate('subj-1'), tx)),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyAwaitingError);

    const rows = await adminDb.approvalGate.findMany({
      where: { workItemId: itemId, state: 'awaiting' },
    });
    expect(rows).toHaveLength(1);
  });

  it('two CONCURRENT inserts: exactly one wins, the loser surfaces the typed error (not a P2002)', async () => {
    // Promise.allSettled races two transactions on the same partial-unique
    // slot. Postgres blocks the second's INSERT on the first's uncommitted row,
    // then refuses it with the unique violation once the first commits; the
    // repository translates that to the typed domain error. WHICH one wins is
    // decided by the scheduler, so the assertion accepts either winner — it
    // pins the COUNT and the TYPE, never the identity.
    const results = await Promise.allSettled([
      withWorkspaceContext(fx.ctx, (tx) => approvalGateRepository.create(gate('subj-1'), tx)),
      withWorkspaceContext(fx.ctx, (tx) => approvalGateRepository.create(gate('subj-1'), tx)),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ApprovalGateAlreadyAwaitingError,
    );

    const rows = await adminDb.approvalGate.findMany({
      where: { workItemId: itemId, state: 'awaiting' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('approvalGateRepository — THE ROUTING READ', () => {
  async function seedRouted(assigneeId: string | null): Promise<string> {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `Routed ${Math.random()}` },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId } });
    const row = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'design_result',
          subjectId: `subj-${item.id}`,
        },
        tx,
      ),
    );
    return row.id;
  }

  it('returns the gates routed to the reader, and counts the same set', async () => {
    const mine = await seedRouted(fx.ownerId);
    await seedRouted(null); // reported by the owner too — the fallback arm
    const scope = { projectIds: [fx.projectId], userId: fx.ownerId };

    const rows = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.findAwaitingRoutedTo(scope, { skip: 0, take: 50 }, tx),
    );
    const count = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.countAwaitingRoutedTo(scope, tx),
    );

    expect(rows.map((r) => r.id)).toContain(mine);
    expect(count).toBe(rows.length);
    expect(count).toBe(2);
  });

  it('returns NOTHING for an EMPTY project scope — the shape an unbrowsable reader resolves to', async () => {
    await seedRouted(fx.ownerId);

    // `projectIds: []` is what `routingScope` hands the query when the actor may
    // not browse their own active project. It must be EMPTY rather than
    // unscoped — an `IN ()` that degraded to "no filter" would return the row,
    // which is the access leak the service's own note is about.
    const rows = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.findAwaitingRoutedTo(
        { projectIds: [], userId: fx.ownerId },
        { skip: 0, take: 50 },
        tx,
      ),
    );

    expect(rows).toEqual([]);
    expect(
      await withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.countAwaitingRoutedTo({ projectIds: [], userId: fx.ownerId }, tx),
      ),
    ).toBe(0);
  });
});
