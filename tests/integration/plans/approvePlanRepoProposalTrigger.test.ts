import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the repo-set proposer (the boundary-touching service approvePlan
// fires) — the plan lifecycle + materialize stay on the real Postgres path
// (CLAUDE.md). This proves the WIRING: the proposal fires on approve, with the
// project tenant, and BEST-EFFORT — a derivation failure must never fail an
// approve that already materialized the tree. The proposer's own derivation and
// idempotence are covered by tests/projectRepos/projectRepoProposal*.test.ts.
vi.mock('@/lib/services/projectRepoProposalService', () => ({
  projectRepoProposalService: { proposeRepositorySet: vi.fn() },
}));

// The sibling best-effort trigger on the same path, stubbed so it cannot reach
// motir-ai from this test (its own wiring is covered by
// approvePlanConventionTrigger.test.ts).
vi.mock('@/lib/services/conventionEstablishService', () => ({
  conventionEstablishService: { establishForFreshProject: vi.fn() },
}));

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { projectRepoProposalService } from '@/lib/services/projectRepoProposalService';
import { conventionEstablishService } from '@/lib/services/conventionEstablishService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

/** Create a plan, append the given proposals, and mark it `planned`. */
async function plannedPlan(
  fx: WorkItemFixture,
  proposals: Parameters<typeof plansService.addProposals>[1],
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.mocked(projectRepoProposalService.proposeRepositorySet).mockResolvedValue({
    proposed: true,
    rows: [],
    created: [],
  });
  vi.mocked(conventionEstablishService.establishForFreshProject).mockResolvedValue({
    submitted: false,
    reason: 'has_connected_repo',
  });
});

afterEach(() => vi.clearAllMocks());

afterAll(async () => {
  await db.$disconnect();
});

describe('plansService.approvePlan — repository-set proposal (MOTIR-1881)', () => {
  it('proposes the repository set on approve, with the project tenant', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'First tree', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    expect(projectRepoProposalService.proposeRepositorySet).toHaveBeenCalledTimes(1);
    expect(projectRepoProposalService.proposeRepositorySet).toHaveBeenCalledWith(
      fx.projectId,
      fx.ctx,
    );
  });

  it('fires on a LATER approve too — the proposer’s own emptiness guard is what makes that safe', async () => {
    const fx = await makeWorkItemFixture();

    const planA = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Tree A', kind: 'task' } },
    ]);
    await plansService.approvePlan(planA, fx.ctx);

    vi.mocked(projectRepoProposalService.proposeRepositorySet).mockClear();
    vi.mocked(projectRepoProposalService.proposeRepositorySet).mockResolvedValue({
      proposed: false,
      reason: 'set_exists',
    });

    const planB = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Tree B', kind: 'task' } },
    ]);
    await plansService.approvePlan(planB, fx.ctx);

    // Unlike the convention trigger (first onboarding only), this runs every time:
    // a project whose first attempt lost to a motir-ai hiccup would otherwise be
    // permanently setless, and a re-plan approve of an established project costs
    // one cheap read.
    expect(projectRepoProposalService.proposeRepositorySet).toHaveBeenCalledTimes(1);
  });

  it('is BEST-EFFORT — a derivation failure never fails the approve or the materialize', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(projectRepoProposalService.proposeRepositorySet).mockRejectedValue(
      new Error('derivation exploded'),
    );
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Resilient tree', kind: 'task' } },
    ]);

    const approved = await plansService.approvePlan(planId, fx.ctx);

    // Establishing repositories is important; it is not worth failing a plan
    // approval over. The user gets an empty-but-editable set, which MOTIR-1782
    // can complete later (ADR §4.4).
    expect(approved.status).toBe('approved');
    const item = await db.workItem.findFirst({ where: { title: 'Resilient tree' } });
    expect(item).not.toBeNull();
    const plan = await db.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('approved');
    // And the project has no set — honestly empty, not half-written.
    expect(await db.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('a proposal failure does not suppress the sibling convention trigger', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(projectRepoProposalService.proposeRepositorySet).mockRejectedValue(
      new Error('derivation exploded'),
    );
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Both triggers', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    // Two independent best-effort effects on one path: neither may take the other
    // down with it.
    expect(conventionEstablishService.establishForFreshProject).toHaveBeenCalledTimes(1);
  });
});
