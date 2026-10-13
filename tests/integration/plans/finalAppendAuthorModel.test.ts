import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { presentMcpPlan } from '@/lib/mcp/payloads/workLoop';
import type { PlanAuthorSourceDto } from '@/lib/dto/plans';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-8420 — the hosted planner's resolved PLANNING MODEL reaches the
// plan's `authorModel` through the internal append seam's FINAL append, against
// real Postgres and through the real route.
//
// Core opens a native plan BEFORE motir-ai has resolved the job's model, so the
// close is the first write that can carry it. It is recorded only on a NATIVE
// plan whose column is still empty: an `mcp` plan's self-reported model is never
// overwritten from this seam, and the first model to close a plan wins. Recorded
// is not exposed — every tenant read still answers `authorModel: null`
// (`work-item-provenance.md` Decision 6, MOTIR-7225).
//
// Every write assertion reads the stored row through `adminDb`, never the
// response — a route that dropped the field and answered 200 would satisfy it.

const SERVICE_SECRET = 'core-callback-secret-test';
const MODEL = 'deepseek-flash';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function append(fx: WorkItemFixture, body: Record<string, unknown>): Promise<Response> {
  return proposalsPOST(
    new Request('http://core/api/internal/ai/plan-proposals', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SERVICE_SECRET}`,
        'x-motir-job-token': mintJobToken({
          userId: fx.ctx.userId,
          workspaceId: fx.ctx.workspaceId,
          projectId: fx.projectId,
        }),
      },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * A `generating` plan bound to `jobId`, authored the way each door opens one: a
 * native plan as `aiGenerationService` does (no model), an `mcp` plan as
 * `create_plan` does (its own self-reported model).
 */
async function openPlan(
  fx: WorkItemFixture,
  jobId: string,
  source: PlanAuthorSourceDto = 'native',
  authorModel: string | null = null,
): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      sourceJobId: jobId,
      title: 'Plan for Acme',
      authorSource: source,
      authorHarness: source === 'native' ? 'Motir' : 'Codex',
      authorModel,
    },
    fx.ctx,
  );
  return plan.id;
}

const ONE_ADD = [{ op: 'add', proposedFields: { title: 'Add the export button', kind: 'task' } }];
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });

describe('the final append records the planning model on a native plan', () => {
  it('a final append with `authorModel` stores it on a native plan whose model is empty', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_final');
    expect((await planRow(planId)).authorModel).toBeNull();

    const res = await append(fx, {
      jobId: 'job_model_final',
      proposals: ONE_ADD,
      final: true,
      authorModel: MODEL,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.authorSource).toBe('native');
    expect(row.authorModel).toBe(MODEL);
  });

  it('a zero-proposal close (discarded) still records the model — the plan with no `add` is the one that had none anywhere', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_empty');

    const res = await append(fx, {
      jobId: 'job_model_empty',
      proposals: [],
      final: true,
      authorModel: MODEL,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    expect(row.authorModel).toBe(MODEL);
  });

  it('a NON-final append carrying `authorModel` stores nothing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_nonfinal');

    const res = await append(fx, {
      jobId: 'job_model_nonfinal',
      proposals: ONE_ADD,
      authorModel: MODEL,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('generating');
    expect(row.authorModel).toBeNull();
  });

  it('an `mcp` plan keeps its own self-reported model', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_mcp', 'mcp', 'gpt-5');

    const res = await append(fx, {
      jobId: 'job_model_mcp',
      proposals: ONE_ADD,
      final: true,
      authorModel: MODEL,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.authorModel).toBe('gpt-5');
  });

  it('an `mcp` plan with no model of its own is not given one from this seam', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_mcp_none', 'mcp', null);

    await append(fx, {
      jobId: 'job_model_mcp_none',
      proposals: ONE_ADD,
      final: true,
      authorModel: MODEL,
    });

    expect((await planRow(planId)).authorModel).toBeNull();
  });

  it('a native plan that already records a model keeps it — the first model to close a plan wins', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_kept');
    await append(fx, {
      jobId: 'job_model_kept',
      proposals: ONE_ADD,
      final: true,
      authorModel: MODEL,
    });
    await plansService.acquireRevisionLease(planId, fx.ctx, {
      source: null,
      harness: 'Motir AI',
      model: null,
    });

    const res = await append(fx, {
      jobId: 'job_model_kept',
      proposals: [],
      final: true,
      revision: true,
      authorModel: 'claude-opus-5-5',
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.authorModel).toBe(MODEL);
  });

  it('a REVISION’s final append records the model on a native plan that had none', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_revision');
    // A plan closed before this change: no model on its first close.
    await append(fx, { jobId: 'job_model_revision', proposals: ONE_ADD, final: true });
    expect((await planRow(planId)).authorModel).toBeNull();
    await plansService.acquireRevisionLease(planId, fx.ctx, {
      source: null,
      harness: 'Motir AI',
      model: null,
    });

    const res = await append(fx, {
      jobId: 'job_model_revision',
      proposals: [],
      final: true,
      revision: true,
      authorModel: MODEL,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ planned: true, released: true });
    expect((await planRow(planId)).authorModel).toBe(MODEL);
  });

  it.each([
    ['a number', 42],
    ['an object', { model: MODEL }],
    ['null', null],
    ['a blank string', '   '],
  ])('a final append whose authorModel is %s records no model', async (_label, authorModel) => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_nonstring');

    const res = await append(fx, {
      jobId: 'job_model_nonstring',
      proposals: ONE_ADD,
      final: true,
      authorModel,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.authorModel).toBeNull();
  });
});

describe('a recorded native model is still never READ by a tenant (MOTIR-7225)', () => {
  it('getPlan, the review DTO and MCP get_plan answer `authorModel: null`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_model_redacted');
    await append(fx, {
      jobId: 'job_model_redacted',
      proposals: ONE_ADD,
      final: true,
      authorModel: MODEL,
    });
    expect((await planRow(planId)).authorModel).toBe(MODEL);

    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.authorModel).toBeNull();
    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(review.authorModel).toBeNull();
    const payload = presentMcpPlan(plan);
    expect(payload.authorModel).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(MODEL);
  });
});
