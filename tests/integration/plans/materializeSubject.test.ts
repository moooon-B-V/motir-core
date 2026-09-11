import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { PlanGrammarError } from '@/lib/plans/errors';
import type { PlanItemProposedFields } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The SUBJECT axis crosses the boundary (Story MOTIR-5062 · MOTIR-5065).
//
// This is the CONSUMER half of a two-repository contract, and it lands first for
// the reason `core.md`'s cross-repo rule gives: the consumer accepts before the
// producer emits, because a field the boundary silently discards fails
// invisibly — the plan looks authored and the coordinate is simply not there
// when anything reads it.
//
// ── The pair that matters most ─────────────────────────────────────────────
// The first two tests are written as a PAIR on purpose: a payload carrying
// `subject` persists it, and the same payload without one persists nothing new.
// Optional in BOTH directions is what makes the axis purely additive, and a
// suite that asserted only the first would leave the compatibility claim
// untested — which is the claim every already-shipped producer depends on.
//
// Real Postgres, per CLAUDE.md: the assertions are about a column and a DTO, and
// a mock would prove neither.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Author + approve a one-`add` plan, returning the created row. */
async function approveOneAdd(fx: WorkItemFixture, proposedFields: PlanItemProposedFields) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'add', proposedFields }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  return adminDb.workItem.findFirstOrThrow({
    where: { projectId: fx.projectId, title: proposedFields.title },
  });
}

/** Author + CLOSE a one-`add` plan without approving it, and read its review model. */
async function reviewOneAdd(fx: WorkItemFixture, proposedFields: PlanItemProposedFields) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'add', proposedFields }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
  return review.items.find((i) => i.title === proposedFields.title)!;
}

describe('subject — the value ROUND-TRIPS through approve', () => {
  it('a proposal carrying `subject` materializes it onto the work item', async () => {
    const fx = await makeWorkItemFixture();

    const row = await approveOneAdd(fx, {
      title: 'Make the webhook handler idempotent',
      kind: 'task',
      subject: 'jobs',
    });

    // Asserted on the COLUMN, through the approve path — not at the schema.
    // The schema accepting a field says nothing about materialize writing it,
    // and `materialize` dropping a proposed value is this seam's own recorded
    // failure mode (`targetRepositoryRef` was emitted for weeks and read by
    // nothing).
    expect(row.subject).toBe('jobs');
  });

  it('a proposal carrying NO subject persists nothing new — the axis is ADDITIVE', async () => {
    const fx = await makeWorkItemFixture();

    // Every producer shipped before this field exists sends exactly this shape.
    // If this row came back with anything but `null`, the axis would not be
    // additive and every existing plan would have acquired a coordinate nobody
    // derived.
    const row = await approveOneAdd(fx, { title: 'Rename a label', kind: 'task' });

    expect(row.subject).toBeNull();
  });
});

describe('subject — what the boundary REFUSES, and what it deliberately does not', () => {
  it('REFUSES a malformed value with a typed error naming the field', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A card', kind: 'task', subject: 'Not A Slug' } }],
      fx.ctx,
    );
    // ⚠️ REFUSED AT THE CLOSE, not at approve — and that is the classification
    // working rather than a detail of where the assertion landed. A malformed
    // subject is decided by the PROPOSAL ALONE, needing no read of the tree, so
    // `runPersistGate` refuses it in `markPlanned` and a reviewer is never handed
    // a plan approve would reject. `lib/plans/approveRefusals.ts` classifies every
    // `PLAN_GRAMMAR_VIOLATION` as `plan-internal` for exactly this reason, and
    // both new reasons inherit that classification automatically.
    await expect(plansService.markPlanned(plan.id, fx.ctx)).rejects.toMatchObject({
      code: 'PLAN_GRAMMAR_VIOLATION',
      reason: 'malformed_subject',
    });
  });

  it('REFUSES a subject on a CONTAINER kind — a KIND question IS this repository’s domain', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A story', kind: 'story', subject: 'data' } }],
      fx.ctx,
    );
    // Refused at the CLOSE, like its shape twin above.
    await expect(plansService.markPlanned(plan.id, fx.ctx)).rejects.toBeInstanceOf(
      PlanGrammarError,
    );
  });

  it('ACCEPTS an unrecognised but well-formed member ON PURPOSE — the vocabulary is the rule-pack file set, not this repository’s', async () => {
    // ⚠️ DO NOT "FIX" THIS INTO A MEMBERSHIP CHECK. See
    // `tests/plans/proposedSubject.test.ts`, which carries the full argument.
    // Short form: a member exists iff `subject-<name>.md` exists in the corpus,
    // so a vocabulary gate HERE would put a migration and a platform deploy in
    // front of every new rule pack. The stated cost is that a typo persists and
    // is refused one hop later, BY NAME, at the resolver that owns the list.
    const fx = await makeWorkItemFixture();

    const row = await approveOneAdd(fx, {
      title: 'A card about nothing in the corpus',
      kind: 'task',
      subject: 'quantum-telepathy',
    });

    expect(row.subject).toBe('quantum-telepathy');
  });
});

describe('subject — what the REVIEW surface shows before anybody approves', () => {
  it('renders the subject for an `add`, in the provenance grouping', async () => {
    const fx = await makeWorkItemFixture();

    // This is the whole reason the field is TOP-LEVEL rather than tucked inside
    // `planningProvenance`: the parity guard reads top-level keys, so a nested
    // member would be invisible to it and could reach the proposal without ever
    // reaching the surface a person approves on — which is exactly how
    // `planningProvenance` itself shipped missing once.
    const item = await reviewOneAdd(fx, {
      title: 'Wire the provider through the gateway',
      kind: 'task',
      subject: 'llm',
    });

    expect(item.subject).toBe('llm');
  });

  it('renders NOTHING where the proposal carries none — the common case, and it stays common', async () => {
    const fx = await makeWorkItemFixture();

    const item = await reviewOneAdd(fx, { title: 'An ordinary card', kind: 'task' });

    expect(item.subject).toBeNull();
  });
});
