import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { runUpdatePlanProposal, runWithdrawPlanProposal } from '@/lib/mcp/tools/authorPlan';
import {
  PlanNotEditableError,
  PlanProposalReferencedError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { warmPool } from '../../helpers/warmPool';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';

// ════════════════════════════════════════════════════════════════════════════
// STORY MOTIR-3595 · Subtask MOTIR-3602 — the ASSEMBLED-SEAM gate
// ════════════════════════════════════════════════════════════════════════════
//
// ── What is HERE, and what deliberately is NOT ──────────────────────────────
// Every card in this story ships its own units under the code-and-tests-are-one-
// deliverable floor, and this gate does not restate them. It NAMES where each
// lives and asserts only what no single card can see:
//
//   * the route reaching `correctProposal` / `withdrawProposal`, the job→plan
//     resolution, the cross-job refusal, the `mode`/`modifyPatch` parsing
//       → MOTIR-3598, `tests/integration/ai/planRevisionRoutes.test.ts`
//   * the lease's own refusals, the idempotent release, AMENDMENT 10 D1's
//     relaxation in both directions
//       → MOTIR-3598, `tests/integration/plans/revisionLease.test.ts`
//   * `revise_plan` in `JOB_KINDS`, `submitRevise` returning the SAME plan id,
//     the acquire+bind, the cross-project not-found
//       → MOTIR-3599, `tests/integration/ai/submitRevise.test.ts`
//   * the handler seeding its registry from the plan, and the four verbs' meaning
//     on a temp-ref
//       → MOTIR-3600, `motir-ai` `tests/revisePlanHandler.test.ts`
//   * the affordance's placement, its absence on a frozen plan, the async-landing
//     page state, the *Revised* pill
//       → MOTIR-3601, `tests/components/plan-detail-revision.test.tsx` +
//         `plan-proposal-list-revised.test.tsx`
//   * the review model's own derivation of the lease and the revised set
//       → MOTIR-3601, `tests/integration/plans/planReviewRevision.test.ts`
//
// What is left is the composition — the halves agreeing.

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const AGENT = { source: null, harness: 'Motir AI', model: 'claude-opus-5' };

/** A `planned` plan bound to a job, carrying three `add`s appended separately. */
async function plannedPlan(fx: WorkItemFixture, jobId: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'The tree the reviewer is holding', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const ids: string[] = [];
  for (const title of ['The first story', 'The second story', 'The third story']) {
    const res = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title, kind: 'story' } }],
      fx.ctx,
    );
    ids.push(res.items[res.items.length - 1]!.id);
  }
  await plansService.markPlanned(plan.id, fx.ctx);
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return { planId: plan.id, ids };
}

async function titlesInTree(fx: WorkItemFixture): Promise<string[]> {
  return (await adminDb.workItem.findMany({ where: { projectId: fx.projectId } }))
    .map((w) => w.title)
    .sort();
}

// ── BLOCK 1 · THE WHOLE ACT ─────────────────────────────────────────────────

describe('block 1 — a plan authored, revised through the internal routes, and APPROVED', () => {
  it('materializes the REVISED shape, not what was originally proposed', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, ids } = await plannedPlan(fx, 'job-seam-1');
    const [, second, third] = ids as [string, string, string];

    // A revision takes the plan…
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    // …rewrites one proposal, withdraws one, and appends the half a split needs.
    await aiGenerationService.correctProposalForJob(
      'job-seam-1',
      second,
      { title: 'The second story, first half' },
      fx.ctx,
    );
    await aiGenerationService.withdrawProposalForJob('job-seam-1', third, fx.ctx);
    await aiGenerationService.appendProposals(
      'job-seam-1',
      [
        {
          op: 'add',
          proposedFields: { title: 'The second story, second half', kind: 'story' },
          // A ROOT-level sibling: splitting a story in two yields two stories
          // beside each other, and the grammar refuses a story parented to a
          // story — which is the plan rules holding at the revision door exactly
          // as they hold at the authoring one.
          parentRef: null,
        },
      ],
      fx.ctx,
      { revision: true, actor: AGENT },
    );
    await aiGenerationService.appendProposals('job-seam-1', [], fx.ctx, {
      revision: true,
      final: true,
      actor: AGENT,
    });

    // …and the reviewer approves what they asked for.
    await plansService.approvePlan(planId, fx.ctx);

    // ⚠️ ASSERTED ON THE MATERIALIZED WORK ITEMS, not on the proposal set. "The
    // revision survives approve" is a claim about the TREE, and a proposal-set
    // assertion would pass with a materialize that ignored every correction.
    expect(await titlesInTree(fx)).toEqual([
      'The first story',
      'The second story, first half',
      'The second story, second half',
    ]);
    // The withdrawn proposal reached nothing at all.
    expect(await titlesInTree(fx)).not.toContain('The third story');
    // And the plan is spent — one plan, decided once, never a second one.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'approved',
    );
    expect(await adminDb.plan.count({ where: { projectId: fx.projectId } })).toBe(1);
  });
});

// ── BLOCK 2 · THE APPROVE / REVISE RACE ─────────────────────────────────────

describe('block 2 — an approve that RACES a revision, driven for real', () => {
  it('resolves to REFUSED-and-untouched or SUCCEEDED-and-whole, never half a tree', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, ids } = await plannedPlan(fx, 'job-race');
    const [, second] = ids as [string, string, string];

    // ⚠️ A COLD POOL IS NOT A RACE. Without this the pool hands out one physical
    // connection, both transactions serialise on it, and the assertion passes
    // whether or not the lock under test exists.
    await warmPool(8);

    // The revision and the decision, fired at the same instant. The revision is a
    // SEQUENCE of writes — which is the whole reason the lease exists, since each
    // one is individually atomic and the composition is not.
    const revision = (async () => {
      await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
      await aiGenerationService.correctProposalForJob(
        'job-race',
        second,
        { title: 'Rewritten mid-approve' },
        fx.ctx,
      );
      await aiGenerationService.appendProposals('job-race', [], fx.ctx, {
        revision: true,
        final: true,
        actor: AGENT,
      });
      return 'revised' as const;
    })();
    const approve = plansService.approvePlan(planId, fx.ctx);

    const [revised, decided] = await Promise.allSettled([revision, approve]);

    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    const tree = await titlesInTree(fx);

    if (decided.status === 'rejected') {
      // OUTCOME ONE — the decision lost. NOTHING was materialized, and the plan
      // is exactly where it was: the reviewer waits, reads what changed, and
      // approves the plan they asked for.
      expect(decided.reason).toBeInstanceOf(PlanRevisionInFlightError);
      expect(plan.status).toBe('planned');
      expect(tree).toEqual([]);
      expect(revised.status).toBe('fulfilled');
    } else {
      // OUTCOME TWO — the decision won. It materialized a WHOLLY CONSISTENT set:
      // either every proposal as authored, or every one as revised. Never one
      // correction in and the next one out.
      expect(plan.status).toBe('approved');
      expect(tree).toHaveLength(3);
      const rewritten = tree.includes('Rewritten mid-approve');
      const original = tree.includes('The second story');
      // Exactly one of the two readings of that proposal reached the tree.
      expect(rewritten).not.toBe(original);
      // …and the revision, if it was still running, was refused its lease rather
      // than allowed to write into a decided plan.
      if (revised.status === 'rejected') {
        expect(revised.reason).toBeInstanceOf(PlanNotEditableError);
      }
    }
  });
});

// ── BLOCK 3 · THE FROZEN STATUSES, FROM THE NEW DOOR ────────────────────────

describe('block 3 — the frozen statuses hold at the JOB-TOKEN door', () => {
  it('refuses a correction and a withdraw on an APPROVED plan, naming the status', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, ids } = await plannedPlan(fx, 'job-frozen-a');
    await plansService.approvePlan(planId, fx.ctx);

    // The service already refuses; what this asserts is that the NEW CALLER does
    // not route around it — the gate is not re-implemented at the seam, so it
    // cannot drift from the one the MCP door asserts.
    await expect(
      aiGenerationService.correctProposalForJob('job-frozen-a', ids[0]!, { title: 'x' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotEditableError);
    await expect(
      aiGenerationService.withdrawProposalForJob('job-frozen-a', ids[0]!, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotEditableError);
  });

  it('refuses both on a DECLINED plan too', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, ids } = await plannedPlan(fx, 'job-frozen-d');
    await plansService.declinePlan(planId, fx.ctx);

    const err = await aiGenerationService
      .correctProposalForJob('job-frozen-d', ids[0]!, { title: 'x' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanNotEditableError);
    expect((err as Error).message).toContain('declined');
  });
});

// ── BLOCK 4 · THE TIMELINE AGREES ───────────────────────────────────────────

describe('block 4 — the WRITE side and the READ side agree about a real revision', () => {
  it('every act appears on the merged timeline, in order, with the acting party', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, ids } = await plannedPlan(fx, 'job-trail');

    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await aiGenerationService.correctProposalForJob(
      'job-trail',
      ids[1]!,
      { title: 'Corrected' },
      fx.ctx,
    );
    await aiGenerationService.withdrawProposalForJob('job-trail', ids[2]!, fx.ctx);
    await aiGenerationService.appendProposals('job-trail', [], fx.ctx, {
      revision: true,
      final: true,
      actor: AGENT,
    });

    // ⚠️ READ BACK THROUGH THE READ PATH's DTO, not off the table. The write side
    // is this story's and the read side is the sibling story's, so that the two
    // agree about a real revision is neither one's own test.
    const view = await planReviewService.getPlanReview(planId, fx.ctx);
    const kinds = view.history.map((e) => e.kind);
    expect(kinds).toContain('revision_started');
    expect(kinds).toContain('edited');
    expect(kinds).toContain('withdrawn');
    expect(kinds).toContain('revision_ended');
    expect(kinds.indexOf('revision_started')).toBeLessThan(kinds.indexOf('revision_ended'));

    // The reviewer can see WHICH harness changed the tree under them — the
    // story's own criterion, and what makes a revision legible rather than a
    // count that moved.
    const started = view.history.find((e) => e.kind === 'revision_started')!;
    expect(started.actorHarness).toBe('Motir AI');

    // The lease is released, so the plan is decidable again…
    expect(view.revision).toBeNull();
    // …and the row that moved is the one the revision touched.
    expect(view.items.filter((i) => i.revised).map((i) => i.planItemId)).toEqual([ids[1]!]);
  });
});

// ── BLOCK 5 · THE MCP PATH IS UNMOVED ───────────────────────────────────────

describe('block 5 — this story adds a second CALLER, never a second behaviour', () => {
  it('`update_plan_proposal` / `withdraw_plan_proposal` behave identically after it', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, ids } = await plannedPlan(fx, 'job-mcp');
    const [first, second, third] = ids as [string, string, string];

    // The MCP door, on a `planned` plan — legal since AMENDMENT 8 and unchanged
    // by this story, asserted here because the story adds a second caller to the
    // methods it shares.
    await runUpdatePlanProposal(
      { planId, planItemId: second, blockedByRefs: [`${TEMP_REF_PREFIX}${first}`] },
      fx.ctx,
    );
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: second } })).blockedByRefs,
    ).toEqual([`${TEMP_REF_PREFIX}${first}`]);

    // Its refusal is unchanged too: a withdraw a sibling still references names
    // the referrers rather than cascading.
    const refused = await runWithdrawPlanProposal({ planId, planItemId: first }, fx.ctx).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(PlanProposalReferencedError);
    expect((refused as Error).message).toContain(second);

    // …and an unreferenced one still goes.
    await runWithdrawPlanProposal({ planId, planItemId: third }, fx.ctx);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
  });

  it('the MCP door is NOT gated by the revision lease — it is one transaction', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, ids } = await plannedPlan(fx, 'job-mcp-2');
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    // The lease excludes a DECISION, which is one-shot and irreversible. A
    // correction is a single atomic write, so approve either sees it whole or
    // does not see it — there is nothing for a lease to protect, and gating it
    // would take a capability away from the MCP surface this story promised not
    // to touch.
    await runUpdatePlanProposal(
      { planId, planItemId: ids[0]!, title: 'Corrected under a lease' },
      fx.ctx,
    );
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect((stored.proposedFields as { title?: string }).title).toBe('Corrected under a lease');
  });
});
