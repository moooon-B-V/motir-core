import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { PLAN_NARRATION_READ_WINDOW } from '@/lib/plans/planNarration';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { consentedVisitor } from '../../visitor/_consentedVisitor';

// Story MOTIR-8060 · Subtask MOTIR-8063 — the planner's narration rides the plan
// REVIEW read (`GET /api/plans/[id]`, which the generating poll and every chat
// surface already use): every session's step words plus the newest window of
// sentences, at every status, and an earlier page through `listPlanNarration`
// behind the SAME gate. Real Postgres; the writes go through `plansService`
// wherever the case is about what a planner did, and through `adminDb` only to
// seed volume.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function generatingPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The picker story', kind: 'story' } }],
    fx.ctx,
  );
  return { planId: plan.id, addId: appended.items[0]!.id };
}

const step = (
  planId: string,
  fx: WorkItemFixture,
  sessionKey: string,
  kind: 'settle' | 'lay' | 'author',
  targetRef: string | null = null,
) => plansService.recordPlanStep(planId, { sessionKey, kind, targetRef }, fx.ctx);

const narrate = (planId: string, fx: WorkItemFixture, sessionKey: string, narration: string[]) =>
  plansService.recordPlanNarration(planId, { sessionKey, narration }, fx.ctx);

/** Seed `count` sentences for one session straight into the table, seq 1..count. */
async function seedSentences(planId: string, sessionKey: string, from: number, to: number) {
  await adminDb.planNarration.createMany({
    data: Array.from({ length: to - from + 1 }, (_, i) => ({
      planId,
      sessionKey,
      seq: from + i,
      body: `Sentence ${from + i}.`,
    })),
  });
}

const review = (planId: string, fx: WorkItemFixture) =>
  planReviewService.getPlanReview(planId, fx.ctx);

describe('the review read carries the narration', () => {
  it('a plan with none carries the empty block', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    expect((await review(planId, fx)).narration).toEqual({
      sessions: [],
      entries: [],
      earlierCount: 0,
    });
  });

  it('returns sentences in seq order with their sessionKey, and every session’s step words', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);
    await step(planId, fx, 'settle', 'settle');
    await step(planId, fx, 'author-1', 'author', `planItem:${addId}`);
    await narrate(planId, fx, 'settle', ['Reading the brief.']);
    await narrate(planId, fx, 'author-1', ['Drafting the picker.']);
    await narrate(planId, fx, 'settle', ['One epic is enough.']);

    const n = (await review(planId, fx)).narration!;
    expect(n.entries.map((e) => [e.seq, e.sessionKey, e.body])).toEqual([
      [1, 'settle', 'Reading the brief.'],
      [2, 'author-1', 'Drafting the picker.'],
      [3, 'settle', 'One epic is enough.'],
    ]);
    expect(n.earlierCount).toBe(0);
    expect(n.sessions.map((s) => [s.sessionKey, s.stepKind, s.targetRef, s.targetTitle])).toEqual([
      ['settle', 'settle', null, null],
      ['author-1', 'author', `planItem:${addId}`, 'The picker story'],
    ]);
    const stored = await adminDb.planNarrationSession.findFirstOrThrow({
      where: { planId, sessionKey: 'author-1' },
    });
    expect(n.sessions[1]).toEqual({
      sessionKey: 'author-1',
      stepKind: 'author',
      targetRef: `planItem:${addId}`,
      targetTitle: 'The picker story',
      firstReportedAt: stored.firstReportedAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
    });
  });

  it('a FINISHED session keeps its step words, after its end and after the plan is decided', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);
    await step(planId, fx, 'author-1', 'author', `planItem:${addId}`);
    await narrate(planId, fx, 'author-1', ['Drafting.']);
    await plansService.endPlanStep(planId, 'author-1', fx.ctx);

    const afterEnd = await review(planId, fx);
    expect(afterEnd.inFlightSteps).toEqual([]);
    expect(afterEnd.narration!.sessions).toMatchObject([
      { sessionKey: 'author-1', stepKind: 'author', targetTitle: 'The picker story' },
    ]);

    await plansService.markPlanned(planId, fx.ctx);
    await plansService.declinePlan(planId, fx.ctx);
    const decided = (await review(planId, fx)).narration!;
    expect(decided.sessions).toMatchObject([{ sessionKey: 'author-1', stepKind: 'author' }]);
    expect(decided.entries.map((e) => e.body)).toEqual(['Drafting.']);
  });

  it('a session with step words and no sentence appears with no entry — nothing invented', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await step(planId, fx, 'quiet', 'lay');
    const n = (await review(planId, fx)).narration!;
    expect(n.sessions.map((s) => s.sessionKey)).toEqual(['quiet']);
    expect(n.entries).toEqual([]);
  });

  it('a sentence whose session has no step-words row is returned as is, no session synthesised', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await seedSentences(planId, 'legacy', 1, 1);
    const n = (await review(planId, fx)).narration!;
    expect(n.entries.map((e) => e.sessionKey)).toEqual(['legacy']);
    expect(n.sessions).toEqual([]);
  });

  it('a re-report that changes the step words is reflected on the next read', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);
    const item = await createTestWorkItem(fx, { title: 'Billing', kind: 'story' });
    await step(planId, fx, 's', 'lay', item.id);
    expect((await review(planId, fx)).narration!.sessions[0]).toMatchObject({
      stepKind: 'lay',
      targetTitle: 'Billing',
    });
    await step(planId, fx, 's', 'author', `planItem:${addId}`);
    await narrate(planId, fx, 's', ['Now authoring.']);
    const n = (await review(planId, fx)).narration!;
    expect(n.sessions).toHaveLength(1);
    expect(n.sessions[0]).toMatchObject({ stepKind: 'author', targetTitle: 'The picker story' });
    expect(n.entries.map((e) => e.body)).toEqual(['Now authoring.']);
  });
});

describe('the window and the paged read', () => {
  it('250 sentences: the review read carries 151..250, pages reach 51..150 then 1..50', async () => {
    expect(PLAN_NARRATION_READ_WINDOW).toBe(100);
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await step(planId, fx, 'early', 'settle');
    await step(planId, fx, 'late', 'lay');
    await seedSentences(planId, 'early', 1, 120);
    await seedSentences(planId, 'late', 121, 250);

    const n = (await review(planId, fx)).narration!;
    expect(n.entries[0]!.seq).toBe(151);
    expect(n.entries.at(-1)!.seq).toBe(250);
    expect(n.entries).toHaveLength(100);
    expect(n.earlierCount).toBe(150);
    // `early`'s sentences all fall before 151, and its head is still here.
    expect(n.sessions.map((s) => s.sessionKey)).toEqual(['early', 'late']);

    const p1 = await planReviewService.listPlanNarration(planId, fx.ctx, {
      beforeSeq: 151,
      limit: 100,
    });
    expect(p1.entries.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => 51 + i));
    expect(p1.earlierCount).toBe(50);

    const p2 = await planReviewService.listPlanNarration(planId, fx.ctx, { beforeSeq: 51 });
    expect(p2.entries.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 1 + i));
    expect(p2.earlierCount).toBe(0);

    const none = await planReviewService.listPlanNarration(planId, fx.ctx, { beforeSeq: 1 });
    expect(none).toEqual({ entries: [], earlierCount: 0 });
  });

  it('the paged read refuses an unknown plan as not found', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      planReviewService.listPlanNarration('cm-not-a-plan', fx.ctx, { beforeSeq: 10 }),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});

describe('the Visitor gate — the review read’s own', () => {
  // A Visitor exists only on the cloud build — the same switch `visitorRooms` flips.
  let previousCloud: string | undefined;
  beforeEach(() => {
    previousCloud = process.env['MOTIR_CLOUD'];
    process.env['MOTIR_CLOUD'] = 'true';
  });
  afterEach(() => {
    if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
    else process.env['MOTIR_CLOUD'] = previousCloud;
  });

  async function publicPlans() {
    const fx = await makeWorkItemFixture({ name: 'Public', identifier: 'PUBN' });
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('public'),
    });
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic' });
    const hidden = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Hidden story',
      parentId: epic.id,
    });
    await adminDb.workItem.update({ where: { id: epic.id }, data: { publicChildrenHidden: true } });

    const visible = await generatingPlan(fx);
    await step(visible.planId, fx, 's', 'settle');
    await narrate(visible.planId, fx, 's', ['Public words.']);

    const secret = await generatingPlan(fx);
    await step(secret.planId, fx, 's', 'lay', hidden.id);
    await narrate(secret.planId, fx, 's', ['Secret words.']);
    await plansService.addProposals(
      secret.planId,
      [{ op: 'modify', workItemId: hidden.id, patch: { title: 'Renamed' } }],
      fx.ctx,
    );
    return { fx, visible: visible.planId, secret: secret.planId };
  }

  it('a consented Visitor reads a visible plan’s narration — both reads, sessions included', async () => {
    const t = await publicPlans();
    const visitor = await consentedVisitor(t.fx.projectIdentifier);
    const n = (await planReviewService.getPlanReview(t.visible, visitor)).narration!;
    expect(n.entries.map((e) => e.body)).toEqual(['Public words.']);
    expect(n.sessions.map((s) => s.sessionKey)).toEqual(['s']);
    const page = await planReviewService.listPlanNarration(t.visible, visitor, { beforeSeq: 2 });
    expect(page.entries.map((e) => e.body)).toEqual(['Public words.']);
  });

  it('a plan touching a private-epic descendant is the same not-found from both reads', async () => {
    const t = await publicPlans();
    const visitor = await consentedVisitor(t.fx.projectIdentifier);
    await expect(planReviewService.getPlanReview(t.secret, visitor)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    await expect(
      planReviewService.listPlanNarration(t.secret, visitor, { beforeSeq: 100 }),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
    // …while a member reads it.
    const member = await planReviewService.listPlanNarration(t.secret, t.fx.ctx, {
      beforeSeq: 100,
    });
    expect(member.entries.map((e) => e.body)).toEqual(['Secret words.']);
  });
});
