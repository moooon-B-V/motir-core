import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary this
// test cannot (and must not) reach. Everything below it is real: a real Postgres,
// the real `plansService` transaction, the real `POST /api/internal/ai/plan-proposals`
// route, real job-token auth. (Same boundary the unit suite stubs; the sanctioned
// analogue of CLAUDE.md's `getSession()` carve-out.)
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { submitJob } from '@/lib/ai/motirAiClient';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { makeWorkItemFixture as makeFixture, createTestWorkItem } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ProjectContext } from '@/lib/projects';
import type { WorkItemFixture } from '../../fixtures';

// CONTRACT TEST — the plan-EDIT half of the incremental-proposals seam
// (bug MOTIR-1743). `tests/integration/ai/generationProposals.test.ts` covers
// `generate_tree`, which opens its own Plan; the four 7.11/7.12 plan-edit submits
// (`augment` / contextual / `expand_item` / `replan`) did NOT — so every one of
// them died on its FIRST `addProposals` callback with NoPlanForJobError → 404.
//
// What was missing, and what this asserts: the submit → CALLBACK round trip, not
// just that the job fired. Each submit opens a `generating` Plan bound to the job
// via `sourceJobId`; motir-ai's callback then lands on the REAL internal route
// with that same jobId, its proposals persist as `PlanItem` rows on that plan, and
// `final: true` marks it `planned`. Plus the orphan case: a FAILED submit leaves
// no Plan row behind (the submit-then-open ordering), and nothing on this path
// ever creates a `work_item` (proposals only, per the 7.21 model).

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  vi.clearAllMocks();
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

function tokenFor(fx: WorkItemFixture): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function proposalsReq(body: unknown): Request {
  return new Request('http://core/api/internal/ai/plan-proposals', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SERVICE_SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

/** Drive the internal callback route as motir-ai's handler does. */
function callback(fx: WorkItemFixture, body: unknown): Promise<Response> {
  const req = proposalsReq(body);
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return proposalsPOST(req);
}

/** The ProjectContext a submit route hands the service (`getActiveProject()`). */
function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** A story to anchor `expand_item` / `replan` at (both reject non-containers). */
async function seedStory(fx: WorkItemFixture): Promise<string> {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story: Login' });
  return story.identifier;
}

interface SubmitCase {
  name: string;
  jobId: string;
  submit: (fx: WorkItemFixture, storyKey: string) => Promise<{ jobId: string; planId: string }>;
}

const CASES: SubmitCase[] = [
  {
    name: 'submitAugment',
    jobId: 'job_edit_augment',
    submit: (fx) => aiPlanEditsService.submitAugment('add a login flow', projectCtx(fx)),
  },
  {
    name: 'submitContextual',
    jobId: 'job_edit_contextual',
    submit: (fx, storyKey) =>
      aiPlanEditsService.submitContextual('split this story', [storyKey], projectCtx(fx)),
  },
  {
    name: 'submitExpand',
    jobId: 'job_edit_expand',
    submit: (fx, storyKey) => aiPlanEditsService.submitExpand(storyKey, projectCtx(fx)),
  },
  {
    name: 'submitReplan',
    jobId: 'job_edit_replan',
    submit: (fx, storyKey) => aiPlanEditsService.submitReplan(storyKey, projectCtx(fx)),
  },
];

describe('plan-edit submit → proposal callback (MOTIR-1743)', () => {
  for (const c of CASES) {
    it(`${c.name}: opens the job's Plan, and its proposal callback RESOLVES (no 404)`, async () => {
      const fx = await makeFixture();
      const storyKey = await seedStory(fx);
      vi.mocked(submitJob).mockResolvedValue({ jobId: c.jobId });

      const { jobId, planId } = await c.submit(fx, storyKey);
      expect(jobId).toBe(c.jobId);

      // The Plan the callback will resolve: `generating`, bound by sourceJobId.
      const opened = await planRepository.findBySourceJobId(jobId, fx.workspaceId);
      expect(opened).not.toBeNull();
      expect(opened!.id).toBe(planId);
      expect(opened!.status).toBe('generating');
      expect(opened!.projectId).toBe(fx.projectId);

      // The callback motir-ai's handler makes — the one that used to 404.
      const res = await callback(fx, {
        jobId,
        proposals: [
          { op: 'add', proposedFields: { title: 'Subtask: Login form', kind: 'subtask' } },
          { op: 'add', proposedFields: { title: 'Subtask: Session cookie', kind: 'subtask' } },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.planId).toBe(planId);
      expect(body.planItemIds).toHaveLength(2);
      expect(body.planned).toBe(false);

      // The proposals landed as PlanItems on the opened plan, in append order.
      const items = await planItemRepository.findByPlan(planId);
      expect(items.map((i) => i.id)).toEqual(body.planItemIds);
      expect(items.every((i) => i.op === 'add' && i.workItemId === null)).toBe(true);
      expect(items.map((i) => (i.proposedFields as { title: string }).title)).toEqual([
        'Subtask: Login form',
        'Subtask: Session cookie',
      ]);

      // `final: true` closes the frontier — generating → planned.
      const finalRes = await callback(fx, { jobId, final: true });
      expect(finalRes.status).toBe(200);
      expect((await finalRes.json()).planned).toBe(true);
      const closed = await db.plan.findFirstOrThrow({ where: { id: planId } });
      expect(closed.status).toBe('planned');

      // Proposals only — nothing materialized. The seeded story is the ONLY
      // work item; the four proposed subtasks exist as PlanItems alone.
      const workItems = await db.workItem.findMany({ where: { projectId: fx.projectId } });
      expect(workItems.map((w) => w.identifier)).toEqual([storyKey]);
    });

    it(`${c.name}: a FAILED submit leaves NO Plan row (no orphan)`, async () => {
      const fx = await makeFixture();
      const storyKey = await seedStory(fx);
      vi.mocked(submitJob).mockRejectedValue(new Error('motir-ai unreachable'));

      await expect(c.submit(fx, storyKey)).rejects.toThrow('motir-ai unreachable');

      expect(await db.plan.count({ where: { projectId: fx.projectId } })).toBe(0);
    });
  }

  it('a job whose submit never opened a plan still 404s (the regression this fixes)', async () => {
    const fx = await makeFixture();

    const res = await callback(fx, {
      jobId: 'job_never_opened',
      proposals: [{ op: 'add', proposedFields: { title: 'x' } }],
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NO_PLAN_FOR_JOB' });
  });

  it('each submit opens its OWN plan — two edits on one project never share a Plan', async () => {
    const fx = await makeFixture();
    const storyKey = await seedStory(fx);

    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_edit_one' });
    const first = await aiPlanEditsService.submitAugment('first edit', projectCtx(fx));
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_edit_two' });
    const second = await aiPlanEditsService.submitExpand(storyKey, projectCtx(fx));

    expect(second.planId).not.toBe(first.planId);

    // Each callback resolves strictly by its own jobId — no cross-append.
    await callback(fx, {
      jobId: first.jobId,
      proposals: [{ op: 'add', proposedFields: { title: 'From the augment' } }],
    });
    await callback(fx, {
      jobId: second.jobId,
      proposals: [{ op: 'add', proposedFields: { title: 'From the expand' } }],
    });

    const firstItems = await planItemRepository.findByPlan(first.planId);
    const secondItems = await planItemRepository.findByPlan(second.planId);
    expect(firstItems.map((i) => (i.proposedFields as { title: string }).title)).toEqual([
      'From the augment',
    ]);
    expect(secondItems.map((i) => (i.proposedFields as { title: string }).title)).toEqual([
      'From the expand',
    ]);
  });
});
