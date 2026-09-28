import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import {
  InvalidProposalError,
  PlanRefGraphError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A plan draws `supersedes` EDGES (Story MOTIR-6577 · MOTIR-6630) — the link kind
// MOTIR-6580 shipped, reachable from a plan at last. Five carriers: an `add`'s
// `supersedesRefs` column, and a `modify`'s `supersedesAdd` / `supersedesRemove`
// (the target is the NEWER card) and `supersededByAdd` / `supersededByRemove`
// (the target is the OLDER one). Two spellings of ONE directed row — so however
// a plan spells an edge, approve writes it once — and a supersedes CYCLE refused
// at the append, because the database never refuses one.
//
// Real Postgres, per CLAUDE.md: what is asserted is what lands in `plan_item`,
// `work_item_link`, `work_item` and `work_item_revision`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function newPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx)).id;
}

async function closeAndApprove(fx: WorkItemFixture, planId: string): Promise<void> {
  await plansService.markPlanned(planId, fx.ctx);
  await plansService.approvePlan(planId, fx.ctx);
}

const supersedesRows = () =>
  adminDb.workItemLink.findMany({
    where: { kind: 'supersedes' },
    select: { fromId: true, toId: true },
  });

async function doneCard(fx: WorkItemFixture, title: string) {
  const card = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });
  return card;
}

async function link(fx: WorkItemFixture, fromId: string, toId: string): Promise<void> {
  await adminDb.workItemLink.create({
    data: {
      workspaceId: fx.workspaceId,
      fromId,
      toId,
      kind: 'supersedes',
      createdById: fx.ctx.userId,
    },
  });
}

describe('append — the carriers persist and are checked where they are written', () => {
  it('persists an `add`’s supersedesRefs (a real id and a `planItem:` ref from an earlier call)', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneCard(fx, 'Old contract');
    const planId = await newPlan(fx);
    const first = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'New contract', kind: 'task' },
          supersedesRefs: [old.id],
        },
      ],
      fx.ctx,
    );
    const firstId = first.appendedItemIds[0]!;
    const second = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Newer still', kind: 'task' },
          supersedesRefs: [`planItem:${firstId}`],
        },
      ],
      fx.ctx,
    );
    const rows = await adminDb.planItem.findMany({
      where: { planId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.supersedesRefs)).toEqual([[old.id], [`planItem:${firstId}`]]);
    // The DTO carries it.
    expect(second.items.find((i) => i.id === firstId)!.supersedesRefs).toEqual([old.id]);
  });

  it('refuses a `planItem:` ref to a proposal in the SAME batch, writing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'T' });
    const planId = await newPlan(fx);
    const err = await plansService
      .addProposals(
        planId,
        [
          { op: 'add', proposedFields: { title: 'A', kind: 'task' } },
          {
            op: 'modify',
            workItemId: target.id,
            patch: { supersededByAdd: ['planItem:same-batch'] },
          },
        ],
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnresolvedPlanRefError);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
  });

  it('refuses `supersedesRefs` on a `modify` by name — its edges ride the patch', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'T' });
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'O' });
    const planId = await newPlan(fx);
    const err = await plansService
      .addProposals(
        planId,
        [
          {
            op: 'modify',
            workItemId: target.id,
            patch: { title: 'x' },
            supersedesRefs: [other.id],
          },
        ],
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as Error).message).toContain('supersedesRefs');
  });

  it('refuses a supersedes CYCLE through one live link and one proposal, at the append', async () => {
    const fx = await makeWorkItemFixture();
    const older = await createTestWorkItem(fx, { kind: 'task', title: 'Older' });
    const newer = await createTestWorkItem(fx, { kind: 'task', title: 'Newer' });
    await link(fx, newer.id, older.id);
    const planId = await newPlan(fx);
    const err = await plansService
      .addProposals(
        planId,
        [{ op: 'modify', workItemId: older.id, patch: { supersedesAdd: [newer.id] } }],
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRefGraphError);
    expect((err as PlanRefGraphError).code).toBe('INVALID_PLAN_REF_GRAPH');
    expect((err as PlanRefGraphError).reason).toBe('cycle');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
  });

  it('refuses a cycle between two proposals of one plan, across two calls', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'story', title: 'B' });
    const planId = await newPlan(fx);
    // A task superseding a story — a cross-level edge is accepted (no level rule).
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: a.id, patch: { supersedesAdd: [b.id] } }],
      fx.ctx,
    );
    const err = await plansService
      .addProposals(
        planId,
        [{ op: 'modify', workItemId: a.id, patch: { supersededByAdd: [b.id] } }],
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect((err as PlanRefGraphError).reason).toBe('cycle');
  });

  it('two `modify`s of one card UNION the lists, and a ref in an add and a remove list cancels', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'T' });
    const x = await createTestWorkItem(fx, { kind: 'task', title: 'X' });
    const y = await createTestWorkItem(fx, { kind: 'task', title: 'Y' });
    const z = await createTestWorkItem(fx, { kind: 'task', title: 'Z' });
    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { supersedesAdd: [x.id, y.id] } }],
      fx.ctx,
    );
    const merged = await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { supersedesRemove: [y.id], supersededByAdd: [z.id] },
        },
      ],
      fx.ctx,
    );
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]!.patch).toEqual({ supersedesAdd: [x.id], supersededByAdd: [z.id] });
  });
});

describe('approve — each edge lands as ONE `supersedes` row in the right direction', () => {
  it('an `add` with supersedesRefs [D] writes created → D, and D reads the new card under supersededBy', async () => {
    const fx = await makeWorkItemFixture();
    const d = await doneCard(fx, 'Old contract');
    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'New contract', kind: 'task' },
          supersedesRefs: [d.id],
        },
      ],
      fx.ctx,
    );
    await closeAndApprove(fx, planId);

    const created = await adminDb.planItem.findFirstOrThrow({ where: { planId, op: 'add' } });
    expect(await supersedesRows()).toEqual([{ fromId: created.workItemId, toId: d.id }]);

    const res = (await runGetWorkItem({ key: d.identifier }, fx.ctx)) as CallToolResult;
    const detail = res.structuredContent as { supersededBy: { item: { id: string } }[] };
    expect(detail.supersededBy.map((l) => l.item.id)).toEqual([created.workItemId]);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('done');
  });

  it('a mark-only `modify` of a DONE card, superseded by a proposed `add` spelled BOTH ways, writes the mark and ONE row', async () => {
    const fx = await makeWorkItemFixture();
    const d = await doneCard(fx, 'Old contract');
    const planId = await newPlan(fx);
    const addId = (
      await plansService.addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'New contract', kind: 'task' },
            supersedesRefs: [d.id],
          },
        ],
        fx.ctx,
      )
    ).appendedItemIds[0]!;
    await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: d.id,
          patch: {
            obsolescence: 'outdated',
            obsolescenceNoteMd: 'Replaced by the new contract.',
            supersededByAdd: [`planItem:${addId}`],
          },
        },
      ],
      fx.ctx,
    );
    await closeAndApprove(fx, planId);

    const createdId = (await adminDb.planItem.findUniqueOrThrow({ where: { id: addId } }))
      .workItemId!;
    expect(await supersedesRows()).toEqual([{ fromId: createdId, toId: d.id }]);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe('done');
    expect(after.obsolescence).toBe('outdated');
    expect(after.obsolescenceNoteMd).toBe('Replaced by the new contract.');
  });

  it('a `modify` with supersedesAdd writes target → ref, and records it in the revision’s `links` cell', async () => {
    const fx = await makeWorkItemFixture();
    const newer = await createTestWorkItem(fx, { kind: 'task', title: 'Newer' });
    const older = await doneCard(fx, 'Older');
    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: newer.id, patch: { supersedesAdd: [older.id] } }],
      fx.ctx,
    );
    await closeAndApprove(fx, planId);
    expect(await supersedesRows()).toEqual([{ fromId: newer.id, toId: older.id }]);
    const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId: newer.id } });
    const linkCells = revisions
      .map((r) => (r.diff as Record<string, unknown>)['links'])
      .filter((cell) => cell !== undefined);
    expect(linkCells).toEqual([{ added: [{ toId: older.id, kind: 'supersedes' }] }]);
  });

  it('supersedesRemove and supersededByRemove each delete the one row; a row that does not exist is a no-op', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'T' });
    const older = await createTestWorkItem(fx, { kind: 'task', title: 'Older' });
    const newer = await createTestWorkItem(fx, { kind: 'task', title: 'Newer' });
    const stranger = await createTestWorkItem(fx, { kind: 'task', title: 'Unlinked' });
    await link(fx, target.id, older.id);
    await link(fx, newer.id, target.id);
    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: {
            supersedesRemove: [older.id, stranger.id],
            supersededByRemove: [newer.id, stranger.id],
          },
        },
      ],
      fx.ctx,
    );
    await closeAndApprove(fx, planId);
    expect(await supersedesRows()).toEqual([]);
    const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId: target.id } });
    const linkCells = revisions
      .map((r) => (r.diff as Record<string, unknown>)['links'])
      .filter((cell) => cell !== undefined);
    expect(linkCells).toEqual([
      {
        removed: [
          { toId: older.id, kind: 'supersedes' },
          { toId: newer.id, kind: 'superseded_by' },
        ],
      },
    ]);
  });

  it('a supersedesAdd naming a row that ALREADY exists is a no-op, not a 409', async () => {
    const fx = await makeWorkItemFixture();
    const newer = await createTestWorkItem(fx, { kind: 'task', title: 'Newer' });
    const older = await createTestWorkItem(fx, { kind: 'task', title: 'Older' });
    await link(fx, newer.id, older.id);
    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: older.id, patch: { supersededByAdd: [newer.id] } }],
      fx.ctx,
    );
    await closeAndApprove(fx, planId);
    expect(await supersedesRows()).toEqual([{ fromId: newer.id, toId: older.id }]);
  });
});

describe('correction — supersedesRefs REPLACES the set on an `add`', () => {
  it('replaces the stored set, and refuses it on a `modify`', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const planId = await newPlan(fx);
    const set = await plansService.addProposals(
      planId,
      [
        { op: 'add', proposedFields: { title: 'New', kind: 'task' }, supersedesRefs: [a.id] },
        { op: 'modify', workItemId: b.id, patch: { title: 'B2' } },
      ],
      fx.ctx,
    );
    const [addId, modifyId] = set.appendedItemIds as [string, string];
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.correctProposal(planId, addId, { supersedesRefs: [b.id] }, fx.ctx);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: addId } })).supersedesRefs,
    ).toEqual([b.id]);
    const err = await plansService
      .correctProposal(planId, modifyId, { supersedesRefs: [a.id] }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
  });
});
