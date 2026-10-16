import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE LIVE STREAM'S PLAN READ (Story MOTIR-8542 · MOTIR-8730), on real Postgres —
// the LEAK FIXTURE. A Workbench stream that watches a plan reads its review
// version through `readReviewVersionForReader`, under the reader's own context
// and the review read's own admission. A plan the reader may not browse must
// answer `null` — the same answer a deleted plan gives — so the stream writes
// nothing that says the plan exists, let alone that it moved.

const DB_TEST_TIMEOUT_MS = 60_000;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  fx: WorkItemFixture;
  owner: { userId: string; workspaceId: string };
  member: { userId: string; workspaceId: string };
  /** In a `workspace` project: both readers browse it. */
  planA: string;
  /** In a `members` project the second member was never added to. */
  planB: string;
}

async function fixture(): Promise<Fixture> {
  const fx = await makeWorkItemFixture({ identifier: 'RVR' });
  const closed = await projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ctx.userId,
    name: 'Members only',
    identifier: 'RVRB',
  });
  await adminDb.$executeRaw`UPDATE "project" SET "access_mode" = 'members' WHERE "id" = ${closed.id}`;
  const user = await createTestUser({ email: 'rvr-member@ex.com', name: 'Second member' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });

  const planA = await plansService.createPlan(fx.projectId, { title: 'Open plan' }, fx.ctx);
  const planB = await plansService.createPlan(closed.id, { title: 'Closed plan' }, fx.ctx);
  return {
    fx,
    owner: fx.ctx,
    member: { userId: user.id, workspaceId: fx.workspaceId },
    planA: planA.id,
    planB: planB.id,
  };
}

function addItem(planId: string, fx: WorkItemFixture, title: string) {
  return plansService.addProposals(
    planId,
    [{ op: 'add' as const, proposedFields: { title, kind: 'task' as const } }],
    fx.ctx,
  );
}

describe('readReviewVersionForReader', () => {
  it(
    'answers a version for every plan the reader may browse, and NULL for one they may not',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { owner, member, planA, planB } = await fixture();

      const ownerA = await planReviewService.readReviewVersionForReader(planA, owner);
      const ownerB = await planReviewService.readReviewVersionForReader(planB, owner);
      const memberA = await planReviewService.readReviewVersionForReader(planA, member);
      const memberB = await planReviewService.readReviewVersionForReader(planB, member);

      expect(ownerA).toEqual({
        status: 'generating',
        reviewVersion: expect.stringMatching(/^rv1\./),
      });
      expect(ownerB).toEqual({
        status: 'generating',
        reviewVersion: expect.stringMatching(/^rv1\./),
      });
      // The same plan, the same answer, whichever admitted reader asks.
      expect(memberA).toEqual(ownerA);
      // ⚠️ THE LEAK CHECK: nothing at all — not an error that names the plan.
      expect(memberB).toBeNull();
    },
  );

  it('answers NULL for a plan that does not exist', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const { owner, planA } = await fixture();
    await adminDb.$executeRaw`DELETE FROM "plan" WHERE "id" = ${planA}`;

    expect(await planReviewService.readReviewVersionForReader(planA, owner)).toBeNull();
    expect(
      await planReviewService.readReviewVersionForReader('cmnotaplanatall0000000000', owner),
    ).toBeNull();
  });

  it(
    'moves after a write to the plan, and not after a write to an unrelated plan',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { fx, member, planA } = await fixture();
      const other = await plansService.createPlan(fx.projectId, { title: 'Another' }, fx.ctx);

      const before = await planReviewService.readReviewVersionForReader(planA, member);
      await addItem(other.id, fx, 'Somebody else’s card');
      const unrelated = await planReviewService.readReviewVersionForReader(planA, member);
      await addItem(planA, fx, 'A card on this plan');
      const after = await planReviewService.readReviewVersionForReader(planA, member);

      expect(unrelated).toEqual(before);
      expect(after!.reviewVersion).not.toBe(before!.reviewVersion);
    },
  );
});
