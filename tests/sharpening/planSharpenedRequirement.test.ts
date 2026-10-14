import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Task MOTIR-1101 · Subtask MOTIR-8183 — the plan's SHARPENED requirement
// column, on the real Postgres path: written through the repository, read back
// through `PlanDto` unchanged, and null on every plan nobody sharpened.

import { db } from '@/lib/db';
import type { SharpenedRequirementDto } from '@/lib/dto/plans';
import { planRepository } from '@/lib/repositories/planRepository';
import { plansService } from '@/lib/services/plansService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SHARPENED: SharpenedRequirementDto = {
  behaviour: '- Who exports? — Any project member',
  acceptance: '- A refused export? — Show why and keep the selection',
  scopeEdge: '- CSV as well as PDF? — PDF only',
  plannerAssumptions: [{ question: 'Over the size limit?', recommendation: 'Split into parts' }],
  settledAt: '2026-10-11T01:00:00.000Z',
};

describe('Plan.sharpenedRequirement', () => {
  it('reads back null on a plan nobody sharpened', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SHN' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Untouched' }, fx.ctx);
    expect(plan.sharpenedRequirement).toBeNull();
    expect((await plansService.getPlan(plan.id, fx.ctx)).sharpenedRequirement).toBeNull();
  });

  it('returns the stored value on PlanDto, unchanged, after setSharpenedRequirement', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SHS' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Sharpened' }, fx.ctx);
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.setSharpenedRequirement(plan.id, SHARPENED, tx),
    );
    expect((await plansService.getPlan(plan.id, fx.ctx)).sharpenedRequirement).toEqual(SHARPENED);
  });

  it('replaces the whole value on a second write, and clears it with null', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SHR' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Twice' }, fx.ctx);
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.setSharpenedRequirement(plan.id, SHARPENED, tx),
    );
    const smaller: SharpenedRequirementDto = {
      outcome: '- Who is it for? — Finance leads',
      plannerAssumptions: [],
      settledAt: '2026-10-11T02:00:00.000Z',
    };
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.setSharpenedRequirement(plan.id, smaller, tx),
    );
    expect((await plansService.getPlan(plan.id, fx.ctx)).sharpenedRequirement).toEqual(smaller);

    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.setSharpenedRequirement(plan.id, null, tx),
    );
    expect((await plansService.getPlan(plan.id, fx.ctx)).sharpenedRequirement).toBeNull();
  });
});
