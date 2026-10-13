import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { PlanNotEditableError, PlanRevisionInFlightError } from '@/lib/plans/errors';
import { PLAN_REVISION_LEASE_MS } from '@/lib/planChange/revisionLease';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-3595 · Subtask MOTIR-3598 — the REVISION LEASE and the job-token
// correction door, against real Postgres.
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 10 is the decision this
// implements: D1 relaxes the append's `generating` assertion for a revision,
// D2 closes the approve / revise race with a lease held on the plan's own
// content trail.
//
// The assertions read the STORED rows through `adminDb` rather than the returned
// DTO wherever the claim is about persistence — a guard that refused and
// returned a plausible DTO would satisfy the return value and not the table.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const AGENT = { source: null, harness: 'Motir AI', model: 'claude-opus-5' };

/** A `planned` plan carrying one `add`, written the way a generation writes one. */
async function plannedPlan(fx: WorkItemFixture, title = 'The proposal') {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title, kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

async function trail(planId: string) {
  return adminDb.planRevision.findMany({ where: { planId }, orderBy: { changedAt: 'asc' } });
}

describe('the revision LEASE — a decision that races a revision is refused', () => {
  it('REFUSES approve while the lease is held, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);

    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanRevisionInFlightError,
    );

    // NOTHING happened: the plan is still the one the revision re-opened
    // (`generating`, MOTIR-8208), its proposal is still a proposal, and no work
    // item exists. The refusal is thrown inside the transaction, before
    // `materialize`, so this is the whole point of the card.
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('generating');
    const items = await adminDb.planItem.findMany({ where: { planId } });
    expect(items).toHaveLength(1);
    expect(items[0]!.workItemId).toBeNull();
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('NAMES the harness holding it and when the lease expires', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    const before = Date.now();
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRevisionInFlightError);
    const typed = err as PlanRevisionInFlightError;
    expect(typed.heldBy).toBe('Motir AI');
    expect(typed.code).toBe('PLAN_REVISION_IN_FLIGHT');
    // Retrying is a real instruction only if the caller is told when to retry.
    expect(typed.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + PLAN_REVISION_LEASE_MS - 5000,
    );
    expect(typed.message).toContain('Motir AI');
  });

  it('REFUSES decline too — a revision must not finish into a closed decision', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    await expect(plansService.declinePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanRevisionInFlightError,
    );
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'generating',
    );
  });

  it('APPROVES once the lease is RELEASED — the loser retries, and the tree is whole', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx, 'The revised proposal');
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanRevisionInFlightError,
    );

    const released = await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);
    expect(released.released).toBe(true);

    await plansService.approvePlan(planId, fx.ctx);
    const created = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
    expect(created.map((w) => w.title)).toEqual(['The revised proposal']);
  });

  it('is IDEMPOTENT to release, and a release with nothing held writes no row', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);

    const first = await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);
    expect(first.released).toBe(false);
    expect((await trail(planId)).some((r) => r.changeKind === 'revision_ended')).toBe(false);

    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    expect((await plansService.releaseRevisionLease(planId, fx.ctx, AGENT)).released).toBe(true);
    expect((await plansService.releaseRevisionLease(planId, fx.ctx, AGENT)).released).toBe(false);
    expect((await trail(planId)).filter((r) => r.changeKind === 'revision_ended')).toHaveLength(1);
  });

  it('REFUSES a SECOND acquire while one is held — one plan, one revision', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    await expect(plansService.acquireRevisionLease(planId, fx.ctx, AGENT)).rejects.toBeInstanceOf(
      PlanRevisionInFlightError,
    );
    expect((await trail(planId)).filter((r) => r.changeKind === 'revision_started')).toHaveLength(
      1,
    );
  });

  it('REFUSES to lease a DECIDED plan — there is nothing left to revise', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.declinePlan(planId, fx.ctx);

    await expect(plansService.acquireRevisionLease(planId, fx.ctx, AGENT)).rejects.toBeInstanceOf(
      PlanNotEditableError,
    );
  });

  it('BRACKETS the revision on the trail, with the acting harness on both rows', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);

    const rows = await trail(planId);
    const kinds = rows.map((r) => r.changeKind);
    expect(kinds.slice(-2)).toEqual(['revision_started', 'revision_ended']);
    // A reviewer must be able to see WHICH harness changed the tree under them —
    // the story's own criterion, and the reason the pair carries an actor at all.
    for (const row of rows.slice(-2)) {
      expect(row.actorHarness).toBe('Motir AI');
      expect(row.actorModel).toBe('claude-opus-5');
    }
  });

  it('an UNCONTENDED approve is untouched — the guard costs the ordinary path nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx, 'Ordinary');
    await plansService.approvePlan(planId, fx.ctx);
    expect(
      (await adminDb.workItem.findMany({ where: { projectId: fx.projectId } })).map((w) => w.title),
    ).toEqual(['Ordinary']);
  });
});

describe('AMENDMENT 10 D1 — a revision may APPEND to a `planned` plan', () => {
  it('REFUSES an ordinary append to a `planned` plan, exactly as before', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await expect(
      plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Sneaked in', kind: 'task' } }],
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_GENERATING' });
  });

  it('ACCEPTS the same append when it DECLARES itself a revision, and records it', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);

    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'The split half', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );

    const items = await adminDb.planItem.findMany({ where: { planId } });
    expect(items).toHaveLength(2);
    // The relaxation is bound to VISIBILITY: the append writes its `appended` row
    // on the trail, which is what makes a `planned` plan growing legible to the
    // reviewer holding it.
    expect((await trail(planId)).filter((r) => r.changeKind === 'appended')).toHaveLength(2);
    // And the plan is STILL `planned` — the APPEND does not re-open one; the
    // revision's lease does (MOTIR-8208), and this append took none.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
  });

  it('REFUSES a revision append to a DECIDED plan, naming the status', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.declinePlan(planId, fx.ctx);

    await expect(
      plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Too late', kind: 'task' } }],
        fx.ctx,
        { revision: true },
      ),
    ).rejects.toBeInstanceOf(PlanNotEditableError);
  });
});

describe('the job-token door — the SECOND caller of two one-caller methods', () => {
  /** Bind a plan to a job the way a submit does, so the seam can resolve it. */
  async function bindJob(planId: string, jobId: string) {
    await adminDb.plan.update({ where: { id: planId }, data: { sourceJobId: jobId } });
  }

  it('CORRECTS a proposal through the job seam, structural fields included', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlan(fx);
    await bindJob(planId, 'job-correct-1');

    const result = await aiGenerationService.correctProposalForJob(
      'job-correct-1',
      itemId,
      { title: 'Renamed by the revision', parentRef: null },
      fx.ctx,
    );

    expect(result.planId).toBe(planId);
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((stored.proposedFields as { title?: string }).title).toBe('Renamed by the revision');
  });

  it('WITHDRAWS a proposal through the job seam and reports what remains', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlan(fx);
    await bindJob(planId, 'job-withdraw-1');

    const result = await aiGenerationService.withdrawProposalForJob(
      'job-withdraw-1',
      itemId,
      fx.ctx,
    );
    expect(result.itemCount).toBe(0);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
  });

  it('cannot reach a plan that is not its job’s — a cross-job token gets a 404 shape', async () => {
    const fx = await makeWorkItemFixture();
    const mine = await plannedPlan(fx);
    const theirs = await plannedPlan(fx, 'Somebody else’s');
    await bindJob(mine.planId, 'job-mine');
    await bindJob(theirs.planId, 'job-theirs');

    // The second job's token, addressing the FIRST job's proposal. The plan is
    // resolved from the JOB, so the item simply is not on the plan this job owns.
    await expect(
      aiGenerationService.correctProposalForJob(
        'job-theirs',
        mine.itemId,
        { title: 'Reaching across' },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_ITEM_NOT_FOUND' });

    // And a job nobody bound to a plan resolves to nothing at all.
    await expect(
      aiGenerationService.correctProposalForJob('job-nobody', mine.itemId, { title: 'x' }, fx.ctx),
    ).rejects.toMatchObject({ code: 'NO_PLAN_FOR_JOB' });
  });

  it('`final` on a REVISION closes the plan it re-opened through markPlanned, then releases', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await bindJob(planId, 'job-final-1');
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    // The shape a revision that touched nothing sends — byte-identical to
    // MOTIR-3193's CLOSE.
    const result = await aiGenerationService.appendProposals('job-final-1', [], fx.ctx, {
      final: true,
      revision: true,
      actor: AGENT,
    });

    // MOTIR-8208: the revision re-opened the plan, so its `final` CLOSES it — the
    // same close a generation takes — and `planned` is reported truthfully.
    expect(result.planned).toBe(true);
    expect(result.released).toBe(true);
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    // …and the plan is decidable again.
    await plansService.approvePlan(planId, fx.ctx);
  });

  it('the MCP path is UNMOVED — `correctProposal` keeps its own contract', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlan(fx);

    // The same method, reached directly, on a `planned` plan: still legal, still
    // sparse, still recorded as `edited` with `correction: true`. This story adds
    // a second CALLER, never a second behaviour.
    await plansService.correctProposal(planId, itemId, { title: 'Via the service' }, fx.ctx);
    const edited = (await trail(planId)).filter((r) => r.changeKind === 'edited');
    expect(edited).toHaveLength(1);
    expect(edited[0]!.diff).toMatchObject({ correction: true });
  });
});

// Bug MOTIR-8208 — a revision RE-OPENS the plan it rewrites (`planned` →
// `generating`) and closes it again when it ends, so its steps and notes land, and
// a failed or abandoned revision never leaves the plan `generating` with nobody
// writing it.
describe('MOTIR-8208 — a revision re-opens the plan and closes it again', () => {
  const gatesOf = (planId: string) =>
    adminDb.approvalGate.findMany({ where: { kind: 'plan_approval', subjectId: planId } });
  const statusOf = async (planId: string) =>
    (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status;

  it('the acquire moves a `planned` plan to `generating`, records where from, and keeps its gate', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    expect((await gatesOf(planId)).map((g) => g.state)).toEqual(['awaiting']);

    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    expect(await statusOf(planId)).toBe('generating');
    const started = (await trail(planId)).filter((r) => r.changeKind === 'revision_started');
    expect(started).toHaveLength(1);
    expect(started[0]!.diff).toMatchObject({ revision: true, reopenedFrom: 'planned' });
    // The question is the SAME question: held, never superseded or re-asked.
    expect((await gatesOf(planId)).map((g) => g.state)).toEqual(['awaiting']);
  });

  it('a step and a narration land on the revised plan — no PLAN_NOT_GENERATING', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    const step = await plansService.reportPlanStep(
      planId,
      { sessionKey: 'revise-1', targetRef: null, step: 'settle' },
      fx.ctx,
    );
    expect(step.kind).toBe('step');
    const note = await plansService.reportPlanStep(
      planId,
      { sessionKey: 'revise-1', targetRef: null, narration: ['Splitting the story.'] },
      fx.ctx,
    );
    expect(note.kind).toBe('narration');
  });

  it('the close goes through markPlanned — briefing written, one `planned` row, the gate unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    const gateBefore = (await gatesOf(planId))[0]!;
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'The split half', kind: 'story' } }],
      fx.ctx,
      { revision: true },
    );

    const closed = await plansService.closeRevision(planId, fx.ctx, AGENT, {
      summary: 'Split the story in two.',
    });

    expect(closed).toMatchObject({ planned: true, released: true, status: 'planned' });
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('planned');
    expect(plan.summary).toBe('Split the story in two.');
    const kinds = (await trail(planId)).map((r) => r.changeKind);
    expect(kinds.filter((k) => k === 'planned')).toHaveLength(2);
    expect(kinds.slice(-2)).toEqual(['planned', 'revision_ended']);
    const gates = await gatesOf(planId);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.id).toBe(gateBefore.id);
    expect(gates[0]!.state).toBe('awaiting');
    // …and it is decidable again.
    await plansService.approvePlan(planId, fx.ctx);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(2);
  });

  it('a revision that withdrew every proposal closes into the empty close — discarded', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await plansService.withdrawProposal(planId, itemId, fx.ctx);
    expect(await statusOf(planId)).toBe('generating');

    const closed = await plansService.closeRevision(planId, fx.ctx, AGENT);
    expect(closed.status).toBe('declined');
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.decisionReason).toBe('discarded');
  });

  it('a release that is not a close (a failure) gives the plan back `planned` as it stands', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Half-written', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );

    const released = await plansService.releaseRevisionLease(planId, fx.ctx, AGENT, {
      failed: true,
    });

    expect(released.released).toBe(true);
    expect(await statusOf(planId)).toBe('planned');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
    const ended = (await trail(planId)).filter((r) => r.changeKind === 'revision_ended');
    expect(ended[0]!.diff).toMatchObject({ failed: true, restoredTo: 'planned' });
    expect((await gatesOf(planId)).map((g) => g.state)).toEqual(['awaiting']);
    // The person can ask for the revision again.
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    expect(await statusOf(planId)).toBe('generating');
  });

  it('a lease taken AGAIN after it lapsed still gives the plan back when it ends', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    for (const row of await trail(planId)) {
      await adminDb.planRevision.update({
        where: { id: row.id },
        data: { changedAt: new Date(row.changedAt.getTime() - PLAN_REVISION_LEASE_MS - 1000) },
      });
    }
    // Retaken over the still-`generating` plan: this start re-opens nothing itself.
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    const starts = (await trail(planId)).filter((r) => r.changeKind === 'revision_started');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.diff).not.toHaveProperty('reopenedFrom');

    await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);
    expect(await statusOf(planId)).toBe('planned');
  });

  it('a revision of a plan that was still `generating` re-opens and restores nothing', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Still writing', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    await plansService.acquireRevisionLease(plan.id, fx.ctx, AGENT);
    expect(await statusOf(plan.id)).toBe('generating');
    await plansService.releaseRevisionLease(plan.id, fx.ctx, AGENT);
    expect(await statusOf(plan.id)).toBe('generating');
  });
});
