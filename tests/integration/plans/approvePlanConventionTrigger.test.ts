import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the motir-ai-bound convention trigger (the 7.1.5-client boundary) — the
// plan lifecycle + materialize stay on the real Postgres path (CLAUDE.md). This
// proves the WIRING in approvePlan: the trigger fires exactly on the first
// onboarding approve, with the project tenant, and best-effort (a throw never
// fails the approve). The trigger's own gating/dispatch logic is covered by
// tests/conventionEstablishService.test.ts.
vi.mock('@/lib/services/conventionEstablishService', () => ({
  conventionEstablishService: { establishForFreshProject: vi.fn() },
}));

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
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
  vi.mocked(conventionEstablishService.establishForFreshProject).mockResolvedValue({
    submitted: true,
    jobId: 'job_x',
    stackHint: 'typescript',
  });
});

afterEach(() => vi.clearAllMocks());

afterAll(async () => {
  await db.$disconnect();
});

describe('plansService.approvePlan — fresh-establish convention trigger (MOTIR-839)', () => {
  it('fires establishForFreshProject on the FIRST onboarding approve, with the project tenant', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'First tree', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    expect(conventionEstablishService.establishForFreshProject).toHaveBeenCalledTimes(1);
    expect(conventionEstablishService.establishForFreshProject).toHaveBeenCalledWith({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectKey: fx.projectIdentifier,
    });
  });

  it('does NOT fire on a LATER approve (onboardingRanAt already stamped)', async () => {
    const fx = await makeWorkItemFixture();

    const planA = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Tree A', kind: 'task' } },
    ]);
    await plansService.approvePlan(planA, fx.ctx);
    expect(conventionEstablishService.establishForFreshProject).toHaveBeenCalledTimes(1);

    vi.mocked(conventionEstablishService.establishForFreshProject).mockClear();

    const planB = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Tree B', kind: 'task' } },
    ]);
    await plansService.approvePlan(planB, fx.ctx);

    // The second approve is a re-plan, not onboarding — markOnboardingRan is a
    // no-op (count 0), so the trigger must NOT fire again.
    expect(conventionEstablishService.establishForFreshProject).not.toHaveBeenCalled();
  });

  it('is best-effort — a trigger failure never fails the approve or the materialize', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(conventionEstablishService.establishForFreshProject).mockRejectedValue(
      new Error('motir-ai unreachable'),
    );
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Resilient tree', kind: 'task' } },
    ]);

    const approved = await plansService.approvePlan(planId, fx.ctx);

    // The approve still committed: the plan is approved and the add materialized.
    expect(approved.status).toBe('approved');
    const item = await db.workItem.findFirst({ where: { title: 'Resilient tree' } });
    expect(item).not.toBeNull();
    // The onboarding marker is stamped despite the trigger throwing.
    const project = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.onboardingRanAt).toBeInstanceOf(Date);
  });
});
