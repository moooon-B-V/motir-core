import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The MATERIALIZE arm of the plan-tree embedding write path (Story MOTIR-2694 ·
// Subtask MOTIR-2696, `docs/decisions/plan-tree-embeddings.md` §6.3.1). The plan
// lifecycle and materialize stay on the real Postgres path (CLAUDE.md); the two
// external seams are stubbed — the Inngest client (no dev server in tests, and it
// is the assertion surface) and the motir-ai-bound convention trigger the approve
// also fires.
//
// WHY THIS ARM NEEDS ITS OWN TEST. An approved plan is how the AI planning layer
// puts work into the tree, and materialize composes the leaf repositories
// DIRECTLY — it cannot nest `workItemsService.createWorkItem`'s transaction, so
// it does not inherit that path's post-commit emit. An item born here would
// otherwise be permanently invisible to semantic search until a human happened to
// edit it, which is the exact false-negative GATE 1 already suffers from.
vi.mock('@/lib/services/conventionEstablishService', () => ({
  conventionEstablishService: { establishForFreshProject: vi.fn() },
}));

import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { plansService } from '@/lib/services/plansService';
import { conventionEstablishService } from '@/lib/services/conventionEstablishService';
import type { WorkItemEmbeddingRequestedData } from '@/lib/jobs/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

/** Capture every `work-item/embedding.requested` publish (and block the network). */
function captureEmbeddingEvents(): WorkItemEmbeddingRequestedData[] {
  const events: WorkItemEmbeddingRequestedData[] = [];
  vi.spyOn(inngest, 'send').mockImplementation((async (payload: unknown) => {
    for (const entry of Array.isArray(payload) ? payload : [payload]) {
      const evt = entry as { name?: string; data?: WorkItemEmbeddingRequestedData };
      if (evt?.name === 'work-item/embedding.requested' && evt.data) events.push(evt.data);
    }
    return { ids: [] as string[] };
  }) as typeof inngest.send);
  return events;
}

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
    submitted: false,
    reason: 'has_connected_repo',
  });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('plansService.approvePlan — the embedding trigger (ADR §6.3.1)', () => {
  it('enqueues one embedding request per MATERIALIZED item', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MAT' });
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'First card', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Second card', kind: 'task' } },
    ]);
    const events = captureEmbeddingEvents();

    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId },
      select: { id: true },
    });
    expect(events.map((e) => e.workItemId).sort()).toEqual(created.map((c) => c.id).sort());
    expect(events.every((e) => e.workspaceId === fx.workspaceId)).toBe(true);
  });

  it('emits AFTER the commit — every id it names is a row that really exists', async () => {
    // The ordering that matters: a rolled-back approve must not leave jobs
    // embedding rows that were never written. Asserted by resolving each emitted
    // id against the committed tree rather than by inspecting the call order.
    const fx = await makeWorkItemFixture({ identifier: 'CMT' });
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Committed card', kind: 'task' } },
    ]);
    const events = captureEmbeddingEvents();

    await plansService.approvePlan(planId, fx.ctx);

    for (const event of events) {
      const workItemRow = await adminDb.workItem.findUnique({ where: { id: event.workItemId } });
      expect(workItemRow).not.toBeNull();
    }
    expect(events).toHaveLength(1);
  });

  it('enqueues for a MODIFY too — a proposal can rewrite a live card’s text', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOD' });
    const seedPlan = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Original', kind: 'task' } },
    ]);
    await plansService.approvePlan(seedPlan, fx.ctx);
    const target = await adminDb.workItem.findFirstOrThrow({ where: { projectId: fx.projectId } });

    const modifyPlan = await plannedPlan(fx, [
      { op: 'modify', workItemId: target.id, patch: { title: 'Rewritten by the planner' } },
    ]);
    const events = captureEmbeddingEvents();
    await plansService.approvePlan(modifyPlan, fx.ctx);

    expect(events).toEqual([{ workspaceId: fx.workspaceId, workItemId: target.id }]);
  });

  it('does NOT enqueue for a REMOVE — archiving keeps the embedding (ADR §5)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'RM' });
    const seedPlan = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Doomed', kind: 'task' } },
    ]);
    await plansService.approvePlan(seedPlan, fx.ctx);
    const target = await adminDb.workItem.findFirstOrThrow({ where: { projectId: fx.projectId } });

    const removePlan = await plannedPlan(fx, [{ op: 'remove', workItemId: target.id }]);
    const events = captureEmbeddingEvents();
    await plansService.approvePlan(removePlan, fx.ctx);

    expect(events).toEqual([]);
  });
});
