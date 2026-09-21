import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { seedPlanChangeProposal } from '../e2e/_helpers/ai-augment-replan-seed';
import { seedContextualProposal } from '../e2e/_helpers/contextual-plan-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

let fx: WorkItemFixture;
beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// THE E2E SEEDS PRODUCE A REAL CONVERSATION SHAPE (bug MOTIR-5640).
//
// ⚠️ A TEST ABOUT TEST HELPERS, and it earns that unusual shape. The two cloud
// seeds stand in for motir-ai's handler, and they omitted the half of a submit
// that records the CONVERSATION — so the plans they built belonged to no
// session. Nothing read that link until a plan began parking its targets, and
// then five at-scale E2E cases failed in the MERGE QUEUE, which is the only
// place those legs run.
//
// This is the cheap version of that signal: it drives both helpers against real
// Postgres in seconds, where the browser legs cost a queue ejection to learn the
// same thing.
describe('the E2E seeds produce a REAL conversation shape', () => {
  it('two augment turns over ONE card do not collide', { timeout: 30_000 }, async () => {
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Notifications' },
      fx.ctx,
    );
    const first = await seedPlanChangeProposal(fx.ctx, fx.projectId, {
      jobId: 'job_e2e_plan_change_1',
      title: 'Add billing',
      adds: ['Billing'],
      rename: { workItemId: card.id, title: 'Renamed' },
    });
    const refined = await seedPlanChangeProposal(fx.ctx, fx.projectId, {
      jobId: 'job_e2e_plan_change_2',
      title: 'Add billing and reporting',
      adds: ['Billing', 'Reporting'],
      rename: { workItemId: card.id, title: 'Renamed' },
    });
    expect(first).not.toBe(refined);
    expect(await adminDb.planChangeSession.count({ where: { projectId: fx.projectId } })).toBe(1);
  });

  it(
    'a contextual turn does not fight the browser session-open on its anchor',
    { timeout: 30_000 },
    async () => {
      const anchor = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'Anchor' },
        fx.ctx,
      );
      await seedContextualProposal(fx.ctx, fx.projectId, {
        jobId: 'job_e2e_contextual_1',
        title: 'Plan it',
        adds: [{ title: 'A child', kind: 'story' }],
        anchorWorkItemId: anchor.id,
      });
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: anchor.id } });
      const session = await adminDb.planChangeSession.findFirstOrThrow({
        where: { projectId: fx.projectId },
      });
      // …and at page load NO TURN HAS BEEN SUBMITTED. The specs seed before the
      // user types, so a `lastJobId` left on the seeded job reads to the rail as a
      // finished turn awaiting review, and it shows the confirm bar on mount — the
      // merge queue's second ejection (`cloud-contextual-plan-confirm.spec.ts`,
      // "a failed run is recoverable in place").
      expect(session.lastJobId).toBeNull();
      // The browser then OPENS that same conversation — it must resume, not collide.
      await expect(
        planTargetLockService.acquireForScope(session.id, [row.identifier], {
          userId: fx.ctx.userId,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
        }),
      ).resolves.toBeDefined();
    },
  );
});
