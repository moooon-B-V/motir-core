import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The Plan's AUTHORSHIP carrier (Story MOTIR-2982 · Subtask MOTIR-2986) — the
// vertical slice `schema → migration → planRepository.create → createPlan →
// toPlanDto → PlanDto`, proven end to end against real Postgres.
//
// The slice is worth proving as a slice rather than per layer, because the field
// is worthless in any one of them alone: a column no input sets and no DTO
// returns is exactly the stored-but-unreadable shape the surface card
// (MOTIR-2991) cannot build on. So every assertion below reads the value back
// through a path a CONSUMER actually uses — the `createPlan` return, a fresh
// `getPlan`, and the row itself — never through the input it was written from.
//
// Decided in `docs/decisions/agent-authored-plans.md` Q3.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('Plan REQUESTER — who asked, as distinct from who wrote and who decided', () => {
  it('records the requester when a producer passes one, and reads it back', async () => {
    const fx = await makeWorkItemFixture();

    const created = await plansService.createPlan(
      fx.projectId,
      { title: 'Somebody asked for this', createdById: fx.ownerId },
      fx.ctx,
    );

    expect(created.createdById).toBe(fx.ownerId);
    const read = await plansService.getPlan(created.id, fx.ctx);
    expect(read.createdById).toBe(fx.ownerId);
  });

  it('is NOT defaulted from the acting context — the cadence guarantee', async () => {
    const fx = await makeWorkItemFixture();

    // THE POINT OF THE WHOLE FIELD, and the reason it is explicit rather than
    // read from `ctx`. `createPlan` always HAS an acting user, and on the
    // auto-plan path that user is the PROJECT OWNER, substituted by
    // `autoPlanCadenceService` so the job has a credential — nobody clicked. A
    // service-side default would therefore record a request the owner never
    // made, on the one plan whose whole point is that no person asked.
    const created = await plansService.createPlan(fx.projectId, { title: 'cadence' }, fx.ctx);

    expect(created.createdById).toBeNull();
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.createdById).toBeNull();
    // …and the acting user was NOT null, so this is a real abstention rather
    // than a fixture that had nobody to record.
    expect(fx.ctx.userId).toBe(fx.ownerId);
  });

  it('is INDEPENDENT of who wrote it and who decided it — three parties, one row', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestUser({ email: 'writer@example.com' });

    const created = await plansService.createPlan(
      fx.projectId,
      {
        createdById: fx.ownerId,
        authorSource: 'mcp',
        authorHarness: 'Claude Code',
        authorModel: 'claude-opus-5',
      },
      fx.ctx,
    );

    const read = await plansService.getPlan(created.id, fx.ctx);
    expect(read.createdById).toBe(fx.ownerId);
    expect(read.authorSource).toBe('mcp');
    // `decidedById` stays null until somebody actually decides — the third axis
    // moves on its own clock and neither of the other two implies it.
    expect(read.decidedById).toBeNull();
    expect(other.id).not.toBe(fx.ownerId);
  });

  it('survives its requester being deleted — SET NULL, never a cascade', async () => {
    const fx = await makeWorkItemFixture();
    const requester = await createTestUser({ email: 'leaver@example.com' });
    const created = await plansService.createPlan(
      fx.projectId,
      { title: 'asked before leaving', createdById: requester.id },
      fx.ctx,
    );

    await adminDb.user.delete({ where: { id: requester.id } });

    // The plan is still there and still reviewable; it has simply become
    // unattributable, which is the honest reading of a departed requester.
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.createdById).toBeNull();
  });
});

describe('Plan authorship — the `source · harness · model` triple on a Plan', () => {
  it('round-trips create → DTO, and survives a fresh read through getPlan', async () => {
    const fx = await makeWorkItemFixture();

    const created = await plansService.createPlan(
      fx.projectId,
      {
        title: 'An agent-authored plan',
        // `authorSource` is passed by the WRITE SEAM (the `create_plan` tool),
        // not by that seam's caller — this test stands where the tool stands.
        authorSource: 'mcp',
        authorHarness: 'Claude Code',
        authorModel: 'claude-opus-5',
      },
      fx.ctx,
    );

    expect(created.authorSource).toBe('mcp');
    expect(created.authorHarness).toBe('Claude Code');
    expect(created.authorModel).toBe('claude-opus-5');

    // The READ-BACK is the half that matters: `createPlan` could return its own
    // input and still leave the surface with nothing. This goes to the database
    // and back out through the mapper.
    const read = await plansService.getPlan(created.id, fx.ctx);
    expect(read.authorSource).toBe('mcp');
    expect(read.authorHarness).toBe('Claude Code');
    expect(read.authorModel).toBe('claude-opus-5');

    // …and the columns really hold it, rather than the mapper echoing something.
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.authorSource).toBe('mcp');
    expect(row.authorHarness).toBe('Claude Code');
    expect(row.authorModel).toBe('claude-opus-5');
  });

  it('leaves all three NULL when the caller supplies none — every shipped producer', async () => {
    const fx = await makeWorkItemFixture();

    // This is the shape `aiGenerationService` / `aiPlanEditsService` call with:
    // generation, augment, expand, replan, contextual and cadence all reach
    // `createPlan` without the triple and MUST be unaffected by this change.
    const created = await plansService.createPlan(
      fx.projectId,
      { title: 'A Motir generation', sourceJobId: 'job_1' },
      fx.ctx,
    );

    expect(created.authorSource).toBeNull();
    expect(created.authorHarness).toBeNull();
    expect(created.authorModel).toBeNull();

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.authorSource).toBeNull();
    expect(row.authorHarness).toBeNull();
    expect(row.authorModel).toBeNull();

    // The two states the Plans surface has to tell apart (MOTIR-2985) are
    // BOTH expressible on this row: a generation is `sourceJobId != null` with a
    // null author (the generator path is not retrofitted here — MOTIR-2996);
    // *unattributed* is both null. Asserted so the surface card cannot be built
    // against an `authorSource === 'native'` that no shipped writer produces.
    expect(row.sourceJobId).toBe('job_1');
  });

  it('is a NULL-safe write: an unattributed plan differs from a generation only by its job', async () => {
    const fx = await makeWorkItemFixture();

    const generated = await plansService.createPlan(fx.projectId, { sourceJobId: 'job_2' }, fx.ctx);
    const unattributed = await plansService.createPlan(fx.projectId, {}, fx.ctx);

    expect(generated.authorSource).toBeNull();
    expect(unattributed.authorSource).toBeNull();
    expect(generated.sourceJobId).toBe('job_2');
    expect(unattributed.sourceJobId).toBeNull();
  });

  it('normalizes the self-reported halves: whitespace-only becomes null, a real value is trimmed', async () => {
    const fx = await makeWorkItemFixture();

    // `harness` / `model` are free text stored as-supplied
    // (`work-item-provenance.md` Decision 2). The ONE normalization is the one
    // that decision itself names — trimmed, empty → null — and it is load-bearing
    // for the surface: a blank attribution renders as a gap the reader cannot
    // distinguish from a real harness name.
    const created = await plansService.createPlan(
      fx.projectId,
      { authorSource: 'mcp', authorHarness: '   ', authorModel: '  Codex  ' },
      fx.ctx,
    );

    expect(created.authorHarness).toBeNull();
    expect(created.authorModel).toBe('Codex');
  });

  it('records the source the seam passed, whichever member of the closed set it is', async () => {
    const fx = await makeWorkItemFixture();

    // The enum is REUSED from `WorkItemPlanningSource` rather than duplicated
    // (ADR Q3), so a plan can speak every member its items can. Proven over the
    // whole set rather than over `mcp` alone: a hand-written second list is
    // exactly what the reuse exists to prevent, and this is what would fail if
    // one crept back in one member short.
    for (const source of ['native', 'mcp', 'manual', 'api'] as const) {
      const plan = await plansService.createPlan(fx.projectId, { authorSource: source }, fx.ctx);
      const read = await plansService.getPlan(plan.id, fx.ctx);
      expect(read.authorSource).toBe(source);
    }
  });
});

describe('Plan attribution reaches BOTH surface reads (MOTIR-2991)', () => {
  it('the review DTO carries the requester NAME, the author triple, origin and sourceJobId', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      {
        title: 'An agent-authored plan',
        createdById: fx.ownerId,
        authorSource: 'mcp',
        authorHarness: 'Claude Code',
        authorModel: 'claude-opus-5',
      },
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // The DETAIL is fed by `PlanReviewDto`, NOT by `PlanDto` — two shapes,
    // maintained separately, which is exactly why one can be right while the
    // other is empty. This asserts the one the header actually reads.
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.createdByName).toBe(fx.owner.name);
    expect(review.authorSource).toBe('mcp');
    expect(review.authorHarness).toBe('Claude Code');
    expect(review.authorModel).toBe('claude-opus-5');
    expect(review.origin).toBe('user');
    expect(review.sourceJobId).toBeNull();
  });

  it('carries `sourceJobId` so the header can tell Motir-generated from unattributed', async () => {
    const fx = await makeWorkItemFixture();
    // The two states are identical in the authorship columns — both are all-null
    // — and are told apart ONLY by the job. Without this field on the DTO the
    // header cannot distinguish them however complete the carrier is.
    const generated = await plansService.createPlan(
      fx.projectId,
      { sourceJobId: 'job_1', createdById: fx.ownerId },
      fx.ctx,
    );
    const legacy = await plansService.createPlan(fx.projectId, {}, fx.ctx);

    const a = await planReviewService.getPlanReview(generated.id, fx.ctx);
    const b = await planReviewService.getPlanReview(legacy.id, fx.ctx);
    expect(a.authorSource).toBeNull();
    expect(b.authorSource).toBeNull();
    expect(a.sourceJobId).toBe('job_1');
    expect(b.sourceJobId).toBeNull();
  });

  it('reports a cadence plan as origin=cadence with no requester name', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { sourceJobId: 'job_2', origin: 'cadence' },
      fx.ctx,
    );

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.origin).toBe('cadence');
    expect(review.createdByName).toBeNull();
  });

  it('leaves the requester name NULL when the person has been deleted', async () => {
    const fx = await makeWorkItemFixture();
    const requester = await createTestUser({ email: 'gone@example.com' });
    const plan = await plansService.createPlan(fx.projectId, { createdById: requester.id }, fx.ctx);
    await adminDb.user.delete({ where: { id: requester.id } });

    // `ON DELETE SET NULL` empties the column, so the read degrades to the
    // unattributed treatment rather than throwing or rendering a dangling id.
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.createdByName).toBeNull();
  });
});
