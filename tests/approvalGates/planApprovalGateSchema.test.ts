import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { handlerFor, UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';
import {
  ApprovalGateHasNoCardError,
  ApprovalGateKindUnregisteredError,
} from '@/lib/approvalGates/errors';
import { requireGateCard, requireGateWorkItem } from '@/lib/approvalGates/gateCard';
import { APPROVAL_GATE_STATUS } from '@/lib/approvalGates/httpStatus';
import { toGateRefusal } from '@/lib/approvalGates/refusals';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE GATE SCHEMA ADMITS A CARD-LESS GATE (Story MOTIR-6012 · Subtask MOTIR-6032; ADR
// `approval-gates.md` §11.1–§11.2, §11.4, §11.6, §11.7) — against a REAL Postgres.
//
// What is proved here is SHAPE only: the kind is unregistered, so nothing in the
// product raises one of these rows yet. Every row below is written by `adminDb`, the
// way a later card's raise will write it, so the constraints are what is under test.

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

const planGate = (
  subjectId: string,
  extra: Partial<Prisma.ApprovalGateUncheckedCreateInput> = {},
) =>
  adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: null,
      kind: 'plan_approval',
      subjectId,
      ...extra,
    },
  });

const cardGate = (
  subjectId: string,
  extra: Partial<Prisma.ApprovalGateUncheckedCreateInput> = {},
) =>
  adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: itemId,
      kind: 'design_result',
      subjectId,
      ...extra,
    },
  });

/** The Postgres constraint a refused write names, from wherever Prisma put it. */
function refusal(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

describe('the card-less BICONDITIONAL — `approval_gate_work_item_iff_not_plan` (§11.1)', () => {
  it('a `plan_approval` row with NO work item and its plan in `subject_id` inserts', async () => {
    const row = await planGate('plan-1');
    expect(row).toMatchObject({ kind: 'plan_approval', workItemId: null, subjectId: 'plan-1' });
  });

  it('refuses a card-less row of any OTHER kind', async () => {
    const err = await cardGate('ev-1', { workItemId: null }).catch((e: unknown) => e);
    expect(refusal(err)).toMatch(/approval_gate_work_item_iff_not_plan/);
  });

  it('refuses a `plan_approval` row that CARRIES a work item', async () => {
    const err = await planGate('plan-1', { workItemId: itemId }).catch((e: unknown) => e);
    expect(refusal(err)).toMatch(/approval_gate_work_item_iff_not_plan/);
  });

  it('refuses an UPDATE that strips a card-bearing gate of its card', async () => {
    const row = await cardGate('ev-1');
    const err = await adminDb.approvalGate
      .update({ where: { id: row.id }, data: { workItemId: null } })
      .catch((e: unknown) => e);
    expect(refusal(err)).toMatch(/approval_gate_work_item_iff_not_plan/);
  });
});

describe('ONE awaiting question per subject — both unique indexes (§11.2)', () => {
  it('a second awaiting card-less row for the same (subject, kind) is refused by the NEW index', async () => {
    await planGate('plan-1');
    const err = await planGate('plan-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('a DIFFERENT plan is its own question', async () => {
    await planGate('plan-1');
    await expect(planGate('plan-2')).resolves.toMatchObject({ subjectId: 'plan-2' });
  });

  it('a decided card-less row beside an awaiting one is allowed — decisions accumulate', async () => {
    await planGate('plan-1', { state: 'declined', decidedAt: new Date() });
    await expect(planGate('plan-1')).resolves.toMatchObject({ state: 'awaiting' });
  });

  it('the SHIPPED index still refuses two awaiting card gates for one (card, kind, subject)', async () => {
    await cardGate('ev-1');
    const err = await cardGate('ev-1').catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('…and still allows a decided one beside an awaiting one', async () => {
    await cardGate('ev-1', { state: 'approved', decidedAt: new Date() });
    await expect(cardGate('ev-1')).resolves.toMatchObject({ state: 'awaiting' });
  });

  it('the shipped `approval_gate_one_awaiting_per_subject` definition is byte-identical', async () => {
    const [shipped] = await adminDb.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'approval_gate' AND indexname = 'approval_gate_one_awaiting_per_subject'`;
    expect(shipped?.indexdef).toBe(
      "CREATE UNIQUE INDEX approval_gate_one_awaiting_per_subject ON public.approval_gate USING btree (work_item_id, kind, subject_id) WHERE (state = 'awaiting'::approval_gate_state)",
    );
  });
});

describe('cleanup — no FK to `Plan` is owed (§11.2)', () => {
  it('deleting the PROJECT deletes its gates, card-less ones included', async () => {
    await planGate('plan-1');
    await cardGate('ev-1');
    await adminDb.project.delete({ where: { id: fx.projectId } });
    expect(await adminDb.approvalGate.count()).toBe(0);
  });

  it('deleting a WORK ITEM still deletes its gates, and leaves a card-less one alone', async () => {
    await planGate('plan-1');
    await cardGate('ev-1');
    await adminDb.workItem.delete({ where: { id: itemId } });
    const left = await adminDb.approvalGate.findMany();
    expect(left.map((g) => g.kind)).toEqual(['plan_approval']);
  });
});

describe('the new enum members (§11.4, §11.6, §11.7)', () => {
  it('`declined`, `plan_stale`, `plan_discarded` and `plan_permission` are writable values', async () => {
    const declined = await planGate('plan-1', {
      state: 'declined',
      decidedAt: new Date(),
      decidedUnderAuthority: 'plan_permission',
    });
    expect(declined).toMatchObject({ state: 'declined', decidedUnderAuthority: 'plan_permission' });
    const stale = await planGate('plan-2', { state: 'superseded', supersededCause: 'plan_stale' });
    const gone = await planGate('plan-3', {
      state: 'superseded',
      supersededCause: 'plan_discarded',
    });
    expect([stale.supersededCause, gone.supersededCause]).toEqual(['plan_stale', 'plan_discarded']);
  });

  it('the decided-row trigger holds a `declined` row exactly as it holds the other decisions', async () => {
    const row = await planGate('plan-1', { state: 'declined', decidedAt: new Date() });
    const err = await adminDb.approvalGate
      .update({ where: { id: row.id }, data: { noteMd: 'rewritten after the fact' } })
      .catch((e: unknown) => e);
    expect(refusal(err)).toMatch(/AG_DECIDED_IMMUTABLE/);
  });

  it('an AWAITING plan gate stays writable — the trigger keys on decided states only', async () => {
    const row = await planGate('plan-1');
    await expect(
      adminDb.approvalGate.update({
        where: { id: row.id },
        data: { state: 'declined', decidedAt: new Date() },
      }),
    ).resolves.toMatchObject({ state: 'declined' });
  });
});

describe('RLS isolates a card-less row by workspace', () => {
  it("another workspace's bound read sees no card-less gate of this one", async () => {
    await planGate('plan-1');
    const other = await makeWorkItemFixture({ name: 'Bravo', identifier: 'BRAVO' });
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${other.workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.approvalGate.count();
    });
    expect(seen).toBe(0);
    const own = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.approvalGate.count();
    });
    expect(own).toBe(1);
  });
});

describe('the kind is UNREGISTERED — MOTIR-6035 promotes it', () => {
  it('`plan_approval` is a named hole, and `handlerFor` refuses it by name', () => {
    expect(UNREGISTERED_GATE_KINDS).toContain('plan_approval');
    expect(() => handlerFor('plan_approval')).toThrow(ApprovalGateKindUnregisteredError);
  });
});

describe('`requireGateCard` / `requireGateWorkItem` — a card path never guesses a card', () => {
  it('returns the card of a card-bearing gate', () => {
    expect(requireGateCard({ id: 'g', kind: 'design_result', workItemId: 'wi' }, 'here')).toBe(
      'wi',
    );
    const card = { id: 'wi' };
    expect(requireGateWorkItem({ id: 'g', workItem: card }, 'here')).toBe(card);
  });

  it('throws the typed DEFECT naming the gate, the kind and the path', () => {
    expect(() =>
      requireGateCard({ id: 'g1', kind: 'plan_approval', workItemId: null }, 'the queue'),
    ).toThrow(/g1.*plan_approval.*the queue/);
    const err = (() => {
      try {
        requireGateWorkItem({ id: 'g2', workItem: null }, 'the record');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ApprovalGateHasNoCardError);
    expect((err as ApprovalGateHasNoCardError).kind).toBe('unknown');
  });

  it('is a 500 on the wire and reads as the unexpected refusal — a defect, not a refusal', () => {
    expect(APPROVAL_GATE_STATUS.APPROVAL_GATE_HAS_NO_CARD).toBe(500);
    expect(toGateRefusal('APPROVAL_GATE_HAS_NO_CARD')).toEqual({
      tag: 'APPROVAL_GATE_HAS_NO_CARD',
    });
  });
});
