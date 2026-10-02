import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { presentMcpPlan } from '@/lib/mcp/payloads/workLoop';
import type { PlanAuthorSourceDto } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// No plan read names the model MOTIR planned with (Story MOTIR-7220 · Subtask
// MOTIR-7225). A native plan's proposal provenance, its author and its native
// timeline actors read back with `model: null` on every tenant-facing path —
// `getPlan`, the review DTO, and MCP `get_plan` — while the stored rows keep the
// real id. An `mcp` plan is the customer's own agent and reads back unchanged.
//
// Real Postgres, per CLAUDE.md: the property is "the row has it AND the read
// does not", and only the real path can show both halves.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const NATIVE_MODEL = 'claude-opus-5-5';
const AGENT_MODEL = 'gpt-5';

/** A planned plan with one `add`, plus a native and an `mcp` row on its trail. */
async function planWith(fx: WorkItemFixture, source: PlanAuthorSourceDto) {
  const native = source === 'native';
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: `A ${source} plan`,
      authorSource: source,
      authorHarness: native ? 'Motir' : 'Codex',
      authorModel: native ? NATIVE_MODEL : AGENT_MODEL,
    },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: 'One card',
          kind: 'task',
          planningProvenance: native
            ? { source: 'native', harness: 'Motir', model: NATIVE_MODEL }
            : { source: 'mcp', harness: 'Codex', model: AGENT_MODEL },
        },
      },
    ],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  // Two content events on the trail, one per actor kind, so a single plan shows
  // the rule is per ROW, not per plan.
  await adminDb.planRevision.createMany({
    data: [
      {
        planId: plan.id,
        changeKind: 'proposal_corrected',
        actorSource: 'native',
        actorHarness: 'Motir',
        actorModel: NATIVE_MODEL,
        diff: { proposalCount: 1 },
      },
      {
        planId: plan.id,
        changeKind: 'proposal_withdrawn',
        actorSource: 'mcp',
        actorHarness: 'Codex',
        actorModel: AGENT_MODEL,
        diff: { proposalCount: 1 },
      },
    ],
  });
  return plan.id;
}

describe('a NATIVE plan never names its model on a read (MOTIR-7225)', () => {
  it('the review DTO nulls the proposal provenance model, the author model and native actors', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWith(fx, 'native');

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const add = review.items.find((i) => i.op === 'add');
    expect(add?.planningProvenance).toEqual({ source: 'native', harness: 'Motir', model: null });
    expect(review.authorSource).toBe('native');
    expect(review.authorModel).toBeNull();

    const nativeEvent = review.history.find((e) => e.kind === 'proposal_corrected');
    const agentEvent = review.history.find((e) => e.kind === 'proposal_withdrawn');
    expect(nativeEvent).toMatchObject({ actorSource: 'native', actorHarness: 'Motir' });
    expect(nativeEvent?.actorModel).toBeNull();
    // The rule is per actor: an agent acting on a native plan keeps its model.
    expect(agentEvent).toMatchObject({ actorSource: 'mcp', actorModel: AGENT_MODEL });
  });

  it('getPlan and MCP get_plan carry no model in any provenance or the author', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWith(fx, 'native');

    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.authorModel).toBeNull();
    expect(plan.items[0]?.proposedFields?.planningProvenance).toEqual({
      source: 'native',
      harness: 'Motir',
      model: null,
    });

    const payload = presentMcpPlan(plan);
    expect(payload.authorModel).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(NATIVE_MODEL);
  });

  it('the stored rows still hold the model — the redaction is at the read', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWith(fx, 'native');

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.authorModel).toBe(NATIVE_MODEL);
    const item = await adminDb.planItem.findFirstOrThrow({ where: { planId } });
    expect(item.proposedFields).toMatchObject({ planningProvenance: { model: NATIVE_MODEL } });
    const rev = await adminDb.planRevision.findFirstOrThrow({
      where: { planId, actorSource: 'native' },
    });
    expect(rev.actorModel).toBe(NATIVE_MODEL);
  });

  it('approving still stamps the real model on the work item ROW (materialize reads the row)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWith(fx, 'native');
    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'One card' },
    });
    expect(created.planningSource).toBe('native');
    expect(created.planningModel).toBe(NATIVE_MODEL);
  });
});

describe('an MCP plan reads back the model its agent self-reported (MOTIR-7225)', () => {
  it('review DTO, getPlan and get_plan are unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWith(fx, 'mcp');

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(review.authorModel).toBe(AGENT_MODEL);
    expect(review.items.find((i) => i.op === 'add')?.planningProvenance).toEqual({
      source: 'mcp',
      harness: 'Codex',
      model: AGENT_MODEL,
    });
    expect(review.history.find((e) => e.kind === 'proposal_withdrawn')?.actorModel).toBe(
      AGENT_MODEL,
    );

    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.authorModel).toBe(AGENT_MODEL);
    expect(plan.items[0]?.proposedFields?.planningProvenance?.model).toBe(AGENT_MODEL);
    expect(presentMcpPlan(plan).authorModel).toBe(AGENT_MODEL);
  });
});
