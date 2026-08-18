import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { InvalidProposalError } from '@/lib/plans/errors';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import type { PlanItemProposedFields } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Materialize stamps the plan's REAL author (Story MOTIR-2982 · Subtask
// MOTIR-2990) — the run-time half of `docs/decisions/work-item-provenance.md`
// Decision 5's 2026-08-18 amendment, argued in
// `docs/decisions/agent-authored-plans.md` Q4.
//
// `plansService.materialize` used to PIN `native` / `Motir` on every created
// item, on the premise that "every item materialized from an approved plan was
// planned NATIVELY by Motir". MOTIR-2982 falsifies that premise; these tests
// pin the three things the amendment turns on:
//
//   1. an `mcp`-provenance proposal materializes as `mcp · <harness> · <model>`;
//   2. a proposal carrying NO provenance is byte-identical to before —
//      `native · Motir` — which is what keeps every shipped producer unaffected;
//   3. an unrecognised `source` is REJECTED with a typed error rather than
//      written through, which is the narrow guard that lets the pin be lifted at
//      all.
//
// Real Postgres, per CLAUDE.md — the assertions are about columns and a read
// DTO, and a mock would prove neither.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Author + approve a one-`add` plan, returning the created work item's row. */
async function approveOneAdd(
  fx: WorkItemFixture,
  proposedFields: PlanItemProposedFields,
): Promise<{ id: string }> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'add', proposedFields }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  const created = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: fx.projectId, title: proposedFields.title },
  });
  return created;
}

describe('materialize — the planning provenance it stamps', () => {
  it('stamps `mcp · <harness> · <model>` from the proposal', async () => {
    const fx = await makeWorkItemFixture();

    const created = await approveOneAdd(fx, {
      title: 'An agent-proposed task',
      kind: 'task',
      // What `add_plan_items` stamps, server-side, from the plan's own triple.
      planningProvenance: { source: 'mcp', harness: 'Claude Code', model: 'claude-opus-5' },
    });

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.planningSource).toBe('mcp');
    expect(row.planningHarness).toBe('Claude Code');
    expect(row.planningModel).toBe('claude-opus-5');
  });

  it('an absent provenance still materializes as `native · Motir` — every shipped producer', async () => {
    const fx = await makeWorkItemFixture();

    // Generation, augment, expand, replan, contextual and cadence all reach
    // materialize through this shape. The DEFAULT is the whole compatibility
    // story: the pin was lifted without moving a single existing row.
    const created = await approveOneAdd(fx, { title: 'A generated task', kind: 'task' });

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.planningSource).toBe('native');
    expect(row.planningHarness).toBe('Motir');
    expect(row.planningModel).toBeNull();
  });

  it("MOTIR-1690's producer pair is byte-identical to the pinned behaviour", async () => {
    const fx = await makeWorkItemFixture();

    // The other shipped shape: motir-ai sends the native pair explicitly plus a
    // model. Under the pin this wrote `native · Motir · <model>`; under the read
    // it writes exactly the same thing, which is why no producer needed changing.
    const created = await approveOneAdd(fx, {
      title: 'A generated task with a model',
      kind: 'task',
      planningProvenance: { source: 'native', harness: 'Motir', model: 'deepseek-chat' },
    });

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.planningSource).toBe('native');
    expect(row.planningHarness).toBe('Motir');
    expect(row.planningModel).toBe('deepseek-chat');
  });

  it('the read DTO exposes an `mcp` item’s model and still strips a `native` one’s', async () => {
    const fx = await makeWorkItemFixture();

    // The one deliberate consequence of the amendment, and it is the SHIPPED
    // mapper rule rather than a new one (`workItemMappers.ts` — "MCP/BYOK keep +
    // expose their model; the user reported their OWN"). Asserted here so it is a
    // decision on the record rather than a side effect nobody named.
    const agent = await approveOneAdd(fx, {
      title: 'Agent item',
      kind: 'task',
      planningProvenance: { source: 'mcp', harness: 'Codex', model: 'gpt-5' },
    });
    const native = await approveOneAdd(fx, {
      title: 'Native item',
      kind: 'task',
      planningProvenance: { source: 'native', harness: 'Motir', model: 'deepseek-chat' },
    });

    const agentRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: agent.id } });
    const nativeRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: native.id } });

    expect(toWorkItemDto(agentRow).planningModel).toBe('gpt-5');
    expect(toWorkItemDto(agentRow).planningHarness).toBe('Codex');
    // Recorded on the row, stripped at the boundary — Motir abstracts its own model.
    expect(nativeRow.planningModel).toBe('deepseek-chat');
    expect(toWorkItemDto(nativeRow).planningModel).toBeNull();
  });

  it('rejects an unrecognised `source` at the APPEND, before any row exists', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);

    await expect(
      plansService.addProposals(
        plan.id,
        [
          {
            op: 'add',
            proposedFields: {
              title: 'Forged',
              planningProvenance: { source: 'trustworthy', harness: 'x' },
            },
          },
        ],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);

    // Nothing was appended — the rejection is at the boundary, not a partial write.
    const items = await adminDb.planItem.count({ where: { planId: plan.id } });
    expect(items).toBe(0);
  });

  it('rejects it AGAIN at approve, atomically, for a proposal that predates the append guard', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Legit' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // Write the bad value STRAIGHT to the column, bypassing the append guard —
    // standing in for a proposal stored before that guard existed. The persist
    // boundary re-checks (`lib/plans/validateProposals.ts`'s own doctrine: the
    // proposal is not trusted at approve), which is what makes "never written
    // through to the column" a property of the write rather than of every writer
    // having behaved.
    const item = await adminDb.planItem.findFirstOrThrow({ where: { planId: plan.id } });
    await adminDb.planItem.update({
      where: { id: item.id },
      data: { proposedFields: { title: 'Legit', planningProvenance: { source: 'forged' } } },
    });

    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toBeInstanceOf(
      InvalidProposalError,
    );

    // ATOMIC: the tree is byte-identical and the plan never left `planned`.
    const created = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(created).toBe(0);
    const after = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(after.status).toBe('planned');
  });
});
