import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { PlanNotEditableError, PlanRevisionClassificationInvalidError } from '@/lib/plans/errors';
import {
  REASON_CLASSIFIED_KIND,
  REVISION_REASON_BRANCHES,
  REVISION_REASON_EVIDENCE_MAX,
  type RevisionReasonBranch,
} from '@/lib/plans/revisionReason';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-5543 · Subtask MOTIR-6083 — the INTERNAL `reason_classified`
// record, against real Postgres.
//
// Two halves, and the second is the one the card exists for.
//
// The WRITE half is an ordinary validation matrix: four branches, two of which
// owe a planning bug and two of which refuse one, plus the status refusal, the
// bug-identity rules and the evidence bound.
//
// The INVISIBILITY half is what makes this card different from every other
// trail card. `reason_classified` is Motir's own judgement about its own
// planner, so the deliverable is not only that the row is written — it is that
// NO tenant-facing read returns it. A test that asserted only the write would
// pass against an implementation that renders the classification on the plan
// review timeline, which is precisely the outcome the story forbids. So every
// tenant reader of `PlanRevision` gets its own assertion, by name, and each one
// is driven with a classification row actually present on the plan: an
// absence-assertion against a plan that has no such row proves nothing at all.
//
// The readers were enumerated on `origin/main` with TWO searches, per the
// caller-sweep lesson — the SYMBOL (`planRevisionRepository` importers) and the
// repository's own read METHODS — because a surface holding its own copy of a
// query is invisible to the first:
//   · planReviewService           → listByPlan            (the review timeline)
//   · planApprovalHandler         → listByPlan            (the plan gate's held check)
//   · plansService (lease reads)  → listByPlan            (the revision lease)
//   · subjectSummary              → listLeaseRowsByPlans  (the To-approve page)
//   · aiWorkItemsService          → countByPlanAndKind('bug_filed')
// The first four read the trail and are asserted below. The fifth cannot return
// a classification: it is narrowed to one named verb by its caller.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A `planned` plan carrying one proposal — the state a reviewer asks to change. */
async function plannedPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'Classifiable',
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      authorModel: 'claude-opus-5',
    },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The surface', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** A real `bug` work item in the fixture's own project, to point a rule branch at. */
async function planningBugFixture(fx: WorkItemFixture) {
  return createTestWorkItem(fx, { kind: 'bug', title: 'Planning bug: the repo was never checked' });
}

/** The stored rows, read through the ADMIN client so a tenant-side filter cannot hide one. */
const storedRows = (planId: string) =>
  adminDb.planRevision.findMany({ where: { planId }, orderBy: { changedAt: 'asc' } });

describe('the classification is recorded on EVERY branch — including the two that file nothing', () => {
  it.each([
    ['new_ask', false],
    ['different_solution', false],
    ['rule_gap', true],
    ['rule_not_followed', true],
  ] as const)('records `%s` with its branch, evidence and bug id', async (branch, filesABug) => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    const bug = filesABug ? await planningBugFixture(fx) : null;

    const result = await plansService.recordRevisionClassification(
      {
        planId,
        branch,
        evidenceMd: 'The conversation never raised export; searched `core` and found no rule.',
        planningBugId: bug?.id ?? null,
        actor: { source: 'mcp', harness: 'Claude Code', model: 'claude-opus-5' },
      },
      fx.ctx,
    );

    expect(result.branch).toBe(branch);
    expect(result.planningBugId).toBe(bug?.id ?? null);

    // Asserted against the TABLE, not the return value: a service that refused
    // and handed back a plausible object would satisfy the latter.
    const rows = (await storedRows(planId)).filter((r) => r.changeKind === REASON_CLASSIFIED_KIND);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.diff).toEqual({ branch, planningBugId: bug?.id ?? null });
    expect(row.noteMd).toBe(
      'The conversation never raised export; searched `core` and found no rule.',
    );
    // A classification is about the REQUEST, not about a proposal.
    expect(row.planItemId).toBeNull();
    expect(row.changedById).toBe(fx.ownerId);
    expect(row.actorSource).toBe('mcp');
    expect(row.actorHarness).toBe('Claude Code');
    expect(row.actorModel).toBe('claude-opus-5');
  });

  it('records against a plan that is still `generating`, not only a `planned` one', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);

    await plansService.recordRevisionClassification(
      { planId: plan.id, branch: 'new_ask', evidenceMd: 'Asked for CSV export mid-generation.' },
      fx.ctx,
    );

    const rows = (await storedRows(plan.id)).filter((r) => r.changeKind === REASON_CLASSIFIED_KIND);
    expect(rows).toHaveLength(1);
  });

  it('the branch tuple is the authority — every member is recordable', async () => {
    // Guards the shape the validator reads: if a fifth branch is added to
    // `REVISION_REASON_BRANCHES` without teaching the bug rule about it, this
    // fails rather than the matrix above silently not covering it.
    expect([...REVISION_REASON_BRANCHES]).toEqual([
      'new_ask',
      'different_solution',
      'rule_gap',
      'rule_not_followed',
    ]);
  });
});

describe('the branch and the planning bug must agree', () => {
  it('REFUSES a rule branch with no planning bug', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);

    for (const branch of ['rule_gap', 'rule_not_followed'] as const) {
      await expect(
        plansService.recordRevisionClassification(
          { planId, branch, evidenceMd: 'A check nothing asked for.' },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(PlanRevisionClassificationInvalidError);
    }

    expect(
      await storedRows(planId).then((r) =>
        r.filter((x) => x.changeKind === REASON_CLASSIFIED_KIND),
      ),
    ).toHaveLength(0);
  });

  it('REFUSES a no-bug branch that carries one', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    const bug = await planningBugFixture(fx);

    for (const branch of ['new_ask', 'different_solution'] as const) {
      await expect(
        plansService.recordRevisionClassification(
          { planId, branch, evidenceMd: 'They prefer a side panel.', planningBugId: bug.id },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(PlanRevisionClassificationInvalidError);
    }
  });

  it('REFUSES a `planningBugId` that is not a `bug`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    const notABug = await createTestWorkItem(fx, { kind: 'task', title: 'A task, not a bug' });

    const err = await plansService
      .recordRevisionClassification(
        {
          planId,
          branch: 'rule_gap',
          evidenceMd: 'No rule covers it.',
          planningBugId: notABug.id,
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanRevisionClassificationInvalidError);
    expect((err as Error).message).toContain('task');
  });

  it('REFUSES a `planningBugId` that does not exist', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);

    await expect(
      plansService.recordRevisionClassification(
        {
          planId,
          branch: 'rule_not_followed',
          evidenceMd: 'The pack required it.',
          planningBugId: 'ckzzzzzzzzzzzzzzzzzzzzzzzz',
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanRevisionClassificationInvalidError);
  });

  // ── THE CROSS-PROJECT RULE, settled by reading the shipped filer ───────────
  //
  // `bugDestinationService.resolvePlannerBug(projectId)` resolves the PROJECT's
  // own planner-bug folder, else its own product bug destination, else its own
  // root — so a planning bug always lands in the SAME project as the plan it was
  // filed about. The rule implemented is therefore SAME-PROJECT, and this is the
  // test that pins it: a bug in another project is refused rather than quietly
  // accepted, because a classification pointing at a row the plan's own reader
  // cannot open is worse than no classification.
  it('REFUSES a planning bug from a DIFFERENT project (the same-project rule)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planId = await plannedPlan(fx);
    const foreignBug = await createTestWorkItem(other, {
      kind: 'bug',
      title: 'Planning bug: elsewhere',
    });

    const err = await plansService
      .recordRevisionClassification(
        {
          planId,
          branch: 'rule_gap',
          evidenceMd: 'No rule covers it.',
          planningBugId: foreignBug.id,
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanRevisionClassificationInvalidError);
  });
});

describe('the evidence is required and bounded', () => {
  it('REFUSES empty evidence on every branch — a verdict with no working shown', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);

    for (const branch of REVISION_REASON_BRANCHES) {
      await expect(
        plansService.recordRevisionClassification(
          { planId, branch: branch as RevisionReasonBranch, evidenceMd: '   ' },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(PlanRevisionClassificationInvalidError);
    }
  });

  it('REFUSES evidence past the bound, and ACCEPTS evidence exactly at it', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);

    await expect(
      plansService.recordRevisionClassification(
        { planId, branch: 'new_ask', evidenceMd: 'x'.repeat(REVISION_REASON_EVIDENCE_MAX + 1) },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanRevisionClassificationInvalidError);

    await plansService.recordRevisionClassification(
      { planId, branch: 'new_ask', evidenceMd: 'x'.repeat(REVISION_REASON_EVIDENCE_MAX) },
      fx.ctx,
    );
    const rows = (await storedRows(planId)).filter((r) => r.changeKind === REASON_CLASSIFIED_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.noteMd).toHaveLength(REVISION_REASON_EVIDENCE_MAX);
  });

  it('TRIMS the evidence it stores', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);

    await plansService.recordRevisionClassification(
      { planId, branch: 'different_solution', evidenceMd: '  a side panel, not a modal  ' },
      fx.ctx,
    );

    const rows = (await storedRows(planId)).filter((r) => r.changeKind === REASON_CLASSIFIED_KIND);
    expect(rows[0]!.noteMd).toBe('a side panel, not a modal');
  });
});

describe('a frozen plan refuses a classification', () => {
  it.each(['approved', 'declined'] as const)(
    'REFUSES on a `%s` plan, naming the status',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const planId = await plannedPlan(fx);
      // Set the terminal status directly: the point under test is the refusal,
      // not the decision path that produced the status.
      await adminDb.plan.update({ where: { id: planId }, data: { status } });

      const err = await plansService
        .recordRevisionClassification(
          { planId, branch: 'new_ask', evidenceMd: 'Too late.' },
          fx.ctx,
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PlanNotEditableError);
      expect((err as Error).message).toContain(status);
    },
  );
});

describe('the INTERNAL read returns what was recorded', () => {
  it('lists the classifications with branch, evidence, bug id, actor and time', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    const bug = await planningBugFixture(fx);

    await plansService.recordRevisionClassification(
      { planId, branch: 'new_ask', evidenceMd: 'Nobody raised export.' },
      fx.ctx,
    );
    await plansService.recordRevisionClassification(
      {
        planId,
        branch: 'rule_gap',
        evidenceMd: 'Searched the corpus; nothing asks for it.',
        planningBugId: bug.id,
        actor: { source: 'mcp', harness: 'Claude Code', model: 'claude-opus-5' },
      },
      fx.ctx,
    );

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listReasonClassifications({ planId }, tx),
    );

    // Newest first — a reader of classifications is asking a recency question.
    expect(rows.map((r) => (r.diff as { branch: string }).branch)).toEqual(['rule_gap', 'new_ask']);
    expect(rows[0]!.noteMd).toBe('Searched the corpus; nothing asks for it.');
    expect((rows[0]!.diff as { planningBugId: string | null }).planningBugId).toBe(bug.id);
    expect(rows[0]!.actorModel).toBe('claude-opus-5');
    expect(rows[0]!.changedAt).toBeInstanceOf(Date);
  });

  it('filters by BRANCH', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    const bug = await planningBugFixture(fx);

    await plansService.recordRevisionClassification(
      { planId, branch: 'different_solution', evidenceMd: 'Prefers a panel.' },
      fx.ctx,
    );
    await plansService.recordRevisionClassification(
      {
        planId,
        branch: 'rule_not_followed',
        evidenceMd: 'The pack asked for it.',
        planningBugId: bug.id,
      },
      fx.ctx,
    );

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listReasonClassifications({ planId, branch: 'rule_not_followed' }, tx),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.diff as { branch: string }).branch).toBe('rule_not_followed');
  });

  it('returns ONLY classifications — never an ordinary trail row', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await plansService.recordRevisionClassification(
      { planId, branch: 'new_ask', evidenceMd: 'Nobody raised it.' },
      fx.ctx,
    );

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listReasonClassifications({ planId }, tx),
    );

    // The plan already carries `created` / `appended` / `planned` rows from the
    // fixture, so this is a real exclusion rather than a vacuous one.
    const all = await storedRows(planId);
    expect(all.length).toBeGreaterThan(rows.length);
    expect(rows.every((r) => r.changeKind === REASON_CLASSIFIED_KIND)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NO TENANT-FACING READ RETURNS A CLASSIFICATION
//
// One assertion per reader found by the sweep at the head of this file. Each
// runs against a plan that HAS a classification row — confirmed through the
// admin client first, so an assertion of absence can never pass because nothing
// was written.
// ─────────────────────────────────────────────────────────────────────────────
describe('no tenant-facing read returns a classification', () => {
  async function planWithAClassification(fx: WorkItemFixture): Promise<string> {
    const planId = await plannedPlan(fx);
    const bug = await planningBugFixture(fx);
    await plansService.recordRevisionClassification(
      {
        planId,
        branch: 'rule_not_followed',
        evidenceMd: 'The pack required the check and the pass skipped it.',
        planningBugId: bug.id,
      },
      fx.ctx,
    );
    // THE CONTROL. Without this the assertions below would pass on an empty
    // table, which is the one way an invisibility test can lie.
    const stored = (await storedRows(planId)).filter(
      (r) => r.changeKind === REASON_CLASSIFIED_KIND,
    );
    expect(stored).toHaveLength(1);
    return planId;
  }

  it('planReviewService — the plan review TIMELINE shows no trace of it', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWithAClassification(fx);

    const model = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(model.history.map((e) => e.kind)).not.toContain(REASON_CLASSIFIED_KIND);
    // And nothing anywhere in the serialised model carries the kind, the branch
    // or the evidence — the widest form of the claim, which catches a field
    // added to a DTO as well as an event added to the timeline.
    const serialised = JSON.stringify(model);
    expect(serialised).not.toContain(REASON_CLASSIFIED_KIND);
    expect(serialised).not.toContain('rule_not_followed');
    expect(serialised).not.toContain('The pack required the check');
  });

  it('planRevisionRepository.listByPlan — the shared trail read excludes it', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWithAClassification(fx);

    const trail = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listByPlan(planId, tx),
    );

    expect(trail.length).toBeGreaterThan(0); // the ordinary rows are still there
    expect(trail.map((r) => r.changeKind)).not.toContain(REASON_CLASSIFIED_KIND);
  });

  it('planRevisionRepository.listLeaseRowsByPlans — the To-approve page read excludes it', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWithAClassification(fx);

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listLeaseRowsByPlans([planId], tx),
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.changeKind)).not.toContain(REASON_CLASSIFIED_KIND);
  });

  it('the classification does not HOLD a revision lease', async () => {
    // The sharpest consequence of excluding at the query rather than at a
    // mapper: a lease means a revision is RUNNING, and recording why a change
    // was asked is not doing the change. A classification written long after a
    // revision ended must not make the plan look busy — which would hold the
    // reviewer's Approve button.
    const fx = await makeWorkItemFixture();
    const planId = await planWithAClassification(fx);

    // `revision` is non-null exactly when a lease IS held, so null is the
    // assertion: the classification wrote a trail row and the plan is still
    // idle.
    const model = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(model.revision).toBeNull();
  });

  it('countByPlanAndKind is unaffected — it is narrowed to one named verb', async () => {
    // Asserted rather than assumed: the exclusion is deliberately NOT spread
    // here, because a count narrowed to `reason_classified` by name must not
    // answer 0 while rows exist. A read that lies is the failure the trail's own
    // contract forbids.
    const fx = await makeWorkItemFixture();
    const planId = await planWithAClassification(fx);

    const count = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.countByPlanAndKind(planId, REASON_CLASSIFIED_KIND, tx),
    );
    expect(count).toBe(1);

    const bugFiled = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.countByPlanAndKind(planId, 'bug_filed', tx),
    );
    expect(bugFiled).toBe(0);
  });
});
