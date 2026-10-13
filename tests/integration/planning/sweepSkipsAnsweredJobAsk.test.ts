import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE SWEEP DOES NOT ASK motir-ai ABOUT A JOB ITS SESSION ALREADY ANSWERS (Bug
// MOTIR-8407) — against a REAL Postgres.
//
// A plan waiting in To resume stays `generating` for ever (MOTIR-7912 / 8132), and the
// 5-minute sweep used to ask motir-ai (`GET /v1/jobs/:id`) about its dead job on every
// pass. Any request but `/health` resets motir-ai's 300 s idle clock, so a planning
// machine never reached its suspend. The ask can no longer change the outcome once the
// session holds the failure for that very job, so it is not made.

const T = { timeout: 60_000 };

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const failedJob = {
  status: 'failed' as const,
  reachable: true,
  failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'gateway 503' },
};

/** The sweep's deps, counting every job ask it makes. */
function countingDeps() {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      resolveJobState: async (jobId: string) => {
        asked.push(jobId);
        return failedJob;
      },
      getFailedJobFacts: async () => ({ walkStop: null, lostMachine: false }),
    },
  };
}

async function seedPlan(sessionData: Record<string, unknown> = {}, sourceJobId = 'job-dead') {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ctx.userId,
      scopeKey: card.identifier,
      targetKeys: [card.identifier],
      origin: 'conversation',
      ...sessionData,
    },
  });
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: session.id,
      status: 'generating',
      sourceJobId,
    },
  });
  return { session, plan };
}

describe('the abandoned-plan sweep — a waiting session already answers for its job', () => {
  it('asks once to record the failure, then never again for the same waiting plan', T, async () => {
    const { plan } = await seedPlan();
    const { asked, deps } = countingDeps();

    const first = await abandonedPlanService.reconcileAbandoned({ deps });
    expect(first.outcomes).toMatchObject([{ planId: plan.id, outcome: 'awaiting_resume' }]);
    expect(asked).toEqual(['job-dead']);

    const second = await abandonedPlanService.reconcileAbandoned({ deps });
    const third = await abandonedPlanService.reconcileAbandoned({ deps });

    for (const pass of [second, third]) {
      expect(pass.outcomes).toEqual([
        {
          planId: plan.id,
          projectId: fx.projectId,
          outcome: 'left_as_is',
          reason: 'session_waiting',
        },
      ]);
    }
    expect(asked).toEqual(['job-dead']);
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe(
      'generating',
    );
  });

  it('makes no ask for a session awaiting its person', T, async () => {
    const { plan } = await seedPlan({
      awaitingPersonSince: new Date(),
      awaitingPersonCause: 'question',
    });
    const { asked, deps } = countingDeps();

    const out = await abandonedPlanService.reconcileAbandoned({ deps });

    expect(out.outcomes).toMatchObject([
      { planId: plan.id, outcome: 'left_as_is', reason: 'session_waiting' },
    ]);
    expect(asked).toEqual([]);
  });

  it(
    'COUNTERFACTUAL: a failure recorded for ANOTHER job still asks about this one',
    T,
    async () => {
      await seedPlan({
        failedAt: new Date(),
        failedJobId: 'job-older',
        failureReason: 'internal',
      });
      const { asked, deps } = countingDeps();

      await abandonedPlanService.reconcileAbandoned({ deps });

      expect(asked).toEqual(['job-dead']);
    },
  );

  it('COUNTERFACTUAL: an open session that is not waiting still asks', T, async () => {
    await seedPlan();
    const { asked, deps } = countingDeps();

    await abandonedPlanService.reconcileAbandoned({ deps });

    expect(asked).toEqual(['job-dead']);
  });
});
