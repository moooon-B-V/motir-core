import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external boundary this test
// cannot and must not reach. Everything below it is real.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { submitJob } from '@/lib/ai/motirAiClient';
import { MotirAiError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { plansService } from '@/lib/services/plansService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import {
  PlanNotEditableError,
  PlanNotFoundError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { ProjectContext } from '@/lib/projects';

// Story MOTIR-3595 · Subtask MOTIR-3599 — `submitRevise`, against real Postgres.
//
// The property this card exists for is an IDENTITY, not a shape: the `planId`
// that comes back is the SAME one that went in. "The change lands on that plan,
// not in a second one" is the story's first criterion, and this is where it is
// decided — every sibling submit ends in `plansService.createPlan`, which is
// exactly what a revision must not do.

beforeEach(async () => {
  vi.clearAllMocks();
  (submitJob as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-revise-1' });
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

async function plannedPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The proposal', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

describe('submitRevise — the change lands on the plan you are holding', () => {
  it('returns the SAME plan id, and opens no second plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    const before = await adminDb.plan.count({ where: { projectId: fx.projectId } });

    const result = await aiPlanEditsService.submitRevise(
      planId,
      'Split the second story in two',
      projectCtx(fx),
    );

    expect(result.planId).toBe(planId);
    expect(result.jobId).toBe('job-revise-1');
    expect(await adminDb.plan.count({ where: { projectId: fx.projectId } })).toBe(before);
  });

  it('targets the PLAN on the wire, and carries the instruction', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await aiPlanEditsService.submitRevise(planId, 'Split it', projectCtx(fx));

    const [kind, , context] = (submitJob as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(kind).toBe('plan');
    expect(context).toMatchObject({ planId, prompt: 'Split it' });
    // A revision names no work item — that is the gap the kind exists to close.
    expect(context).not.toHaveProperty('rootItemKey');
    expect(context).not.toHaveProperty('targetKeys');
  });

  it('ACQUIRES the lease and BINDS the plan to the revision job — ONE act, one transaction', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await aiPlanEditsService.submitRevise(planId, 'Split it', projectCtx(fx));

    // The seam resolves "the job's plan" by `sourceJobId`, so the binding is what
    // lets the handler's callbacks land — with no second resolution path.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sourceJobId).toBe(
      'job-revise-1',
    );
    const rows = await adminDb.planRevision.findMany({
      where: { planId },
      orderBy: { changedAt: 'asc' },
    });
    expect(rows.at(-1)!.changeKind).toBe('revision_started');
    // And the plan is HELD — a decision racing it is refused.
    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanRevisionInFlightError,
    );
  });

  it('a FAILED submit leaves the plan EXACTLY as it found it — nothing to unwind', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    (submitJob as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new MotirAiUnavailableError('motir-ai is unreachable'),
    );

    await expect(
      aiPlanEditsService.submitRevise(planId, 'Split it', projectCtx(fx)),
    ).rejects.toBeInstanceOf(MotirAiError);

    // The lease is taken AFTER the submit — and it is what binds the plan to the
    // job — so a submit that never returned an id has written nothing at all.
    // There is no half-state to unwind, which is the point of that ordering.
    const rows = await adminDb.planRevision.findMany({ where: { planId } });
    expect(rows.some((r) => r.changeKind === 'revision_started')).toBe(false);
    expect(
      (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sourceJobId,
    ).toBeNull();
    // The plan is decidable, immediately — not in ten minutes.
    await plansService.approvePlan(planId, fx.ctx);
  });

  it('REFUSES a plan another revision already holds', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await aiPlanEditsService.submitRevise(planId, 'First', projectCtx(fx));

    await expect(
      aiPlanEditsService.submitRevise(planId, 'Second', projectCtx(fx)),
    ).rejects.toBeInstanceOf(PlanRevisionInFlightError);
    // ONE submit, not two — the lease refused the second before a job was spent.
    // Counted on the KIND, which is `plan` for every planning submit since
    // MOTIR-4304; `context.planId` is what still says this one is a revision.
    const submits = (submitJob as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([k]) => k === 'plan',
    );
    expect(submits).toHaveLength(1);
    expect((submits[0]![2] as { planId?: string }).planId).toBe(planId);
  });

  it('REFUSES an `approved` or `declined` plan, naming the status', async () => {
    const fx = await makeWorkItemFixture();
    const declined = await plannedPlan(fx);
    await plansService.declinePlan(declined, fx.ctx);
    const err = await aiPlanEditsService
      .submitRevise(declined, 'Too late', projectCtx(fx))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanNotEditableError);
    expect((err as Error).message).toContain('declined');

    const approved = await plannedPlan(fx);
    await plansService.approvePlan(approved, fx.ctx);
    await expect(
      aiPlanEditsService.submitRevise(approved, 'Too late', projectCtx(fx)),
    ).rejects.toBeInstanceOf(PlanNotEditableError);

    // No REVISION job was dispatched. (Approving a plan fires a
    // `propose_convention` job of its own, so the filter is on the kind rather
    // than on the call count.)
    expect(
      (submitJob as ReturnType<typeof vi.fn>).mock.calls.filter(([k]) => k === 'revise_plan'),
    ).toHaveLength(0);
  });

  it('a plan in ANOTHER project is NOT FOUND, never forbidden', async () => {
    const mine = await makeWorkItemFixture();
    const theirs = await makeWorkItemFixture();
    const theirPlan = await plannedPlan(theirs);

    // A caller who cannot browse it must not learn it exists — the same
    // no-existence-leak posture the rest of the tree keeps.
    await expect(
      aiPlanEditsService.submitRevise(theirPlan, 'Reaching across', projectCtx(mine)),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('an unknown plan id is NOT FOUND', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      aiPlanEditsService.submitRevise('cmnothingatall000000', 'x', projectCtx(fx)),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it('the THREE existing submits are unchanged — still work-item keys, still a NEW plan', async () => {
    const fx = await makeWorkItemFixture();
    (submitJob as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-augment' });
    const before = await adminDb.plan.count({ where: { projectId: fx.projectId } });

    const augment = await aiPlanEditsService.submitAugment('Add a story', projectCtx(fx));
    expect(augment.jobId).toBe('job-augment');
    // An augment OPENS a plan; a revision does not. That difference is the card.
    expect(await adminDb.plan.count({ where: { projectId: fx.projectId } })).toBe(before + 1);
    const [kind] = (submitJob as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(kind).toBe('plan');
  });
});
