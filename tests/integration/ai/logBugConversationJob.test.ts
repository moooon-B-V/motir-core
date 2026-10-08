import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { mintJobToken } from '@/lib/ai/jobToken';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import { planRepository } from '@/lib/repositories/planRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { PLANNER_BUG_FILED_CHANGE_KIND } from '@/lib/ai/plannerTenantBug';
import { POST as logBugPOST } from '@/app/api/internal/ai/log-bug/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-7799 (Story MOTIR-7797; decision MOTIR-7798 Q2) — the property the
// planning CONVERSATION's `log_bug` relies on, pinned on motir-core's side: a
// run that opens PART 1 has its plan BEFORE the model can file, because every
// submitter opens the Plan (`sourceJobId: jobId`) straight after motir-ai accepts
// the job. So the job-token route needs no planless arm — a job with no plan
// stays 404 `NO_PLAN_FOR_JOB` (`logBugRoute.test.ts`) — and that same `jobId`
// files through the route as any lay / author phase does.
//
// Real Postgres, the real route. The one mock is motir-ai's boundary client,
// as every submit-path integration test mocks it.

const SERVICE_SECRET = 'core-callback-secret-test';

let jobSeq = 0;
const submitJobMock = vi.fn(async () => ({ jobId: `job-convo-${++jobSeq}` }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { aiGenerationService } = await import('@/lib/services/aiGenerationService');

let fx: WorkItemFixture;

function pctx(): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** POST the route as motir-ai would from inside the job: the job token for the
 *  submitter's project, and the job id motir-ai was handed. */
function fileFromJob(jobId: string, title: string): Promise<Response> {
  return logBugPOST(
    new Request('http://core/api/internal/ai/log-bug', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SERVICE_SECRET}`,
        'x-motir-job-token': mintJobToken({
          userId: fx.ownerId,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
        }),
      },
      body: JSON.stringify({ jobId, title, descriptionMd: 'Found in the conversation.' }),
    }),
  );
}

/** The plan the route will resolve: by `sourceJobId`, under the bound read. */
function planOfJob(jobId: string) {
  return withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planRepository.findBySourceJobId(jobId, fx.workspaceId, tx),
  );
}

/** The submit's job resolves to its plan in the token's project; then that job
 *  files through the route and the filing is recorded on that plan. */
async function assertJobFiles(jobId: string, planId: string): Promise<void> {
  const res = await fileFromJob(jobId, `A defect confirmed under ${jobId}`);
  expect(res.status).toBe(201);
  const { id, key } = (await res.json()) as { id: string; key: string };

  const bug = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  expect(bug.kind).toBe('bug');
  expect(bug.projectId).toBe(fx.projectId);
  expect(bug.identifier).toBe(key);
  // No parent named → the project's bug destination (MOTIR-4937).
  expect(bug.parentId).toBeNull();
  expect(bug.folderId).toBe(await seededBugsFolderId(fx.projectId));

  const trail = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planRevisionRepository.listByPlan(planId, tx),
  );
  const filed = trail.filter((r) => r.changeKind === PLANNER_BUG_FILED_CHANGE_KIND);
  expect(filed).toHaveLength(1);
  expect(filed[0]!.diff).toMatchObject({ workItemId: id, workItemKey: key });
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
  submitJobMock.mockClear();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the CONVERSATION submit binds its plan before it returns', () => {
  it('`planChangeSessionsService.submit` → the job resolves to its plan in the token’s project', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      PROJECT_SCOPE,
      'the export drops its last row — and plan the fix',
    );
    const { jobId, planId } = await planChangeSessionsService.submit(pctx(), {
      sessionId: convo.id,
    });
    expect(submitJobMock).toHaveBeenCalledTimes(1);

    // By the time `submit` resolved — before motir-ai could run a single turn
    // of PART 1 — the plan the route resolves by `sourceJobId` exists.
    const plan = await planOfJob(jobId);
    expect(plan?.id).toBe(planId);
    expect(plan?.projectId).toBe(fx.projectId);
    expect(plan?.sessionId).toBe(convo.id);
  });

  it('that same `jobId` files through `POST /api/internal/ai/log-bug` → 201, a trail row, a bug', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      PROJECT_SCOPE,
      'search ignores the archived filter',
    );
    const { jobId, planId } = await planChangeSessionsService.submit(pctx(), {
      sessionId: convo.id,
    });
    await assertJobFiles(jobId, planId);
  });
});

describe('a GENERATION binds its plan before it returns', () => {
  it('`aiGenerationService.startGeneration` → the job resolves to its plan in the token’s project', async () => {
    const { jobId, planId } = await aiGenerationService.startGeneration(pctx(), {
      title: 'Checkout',
    });
    const plan = await planOfJob(jobId);
    expect(plan?.id).toBe(planId);
    expect(plan?.projectId).toBe(fx.projectId);
  });

  it('that same `jobId` files through the route → 201, a trail row, a bug', async () => {
    const { jobId, planId } = await aiGenerationService.startGeneration(pctx(), {
      title: 'Checkout',
    });
    await assertJobFiles(jobId, planId);
  });
});
