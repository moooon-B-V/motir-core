import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client a job submit would reach.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { submitJob } from '@/lib/ai/motirAiClient';
import { PLAN_ITEM_REASON_MAX } from '@/lib/dto/plans';
import { InvalidProposalError } from '@/lib/plans/errors';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  GET as proposalsGET,
  POST as proposalsPOST,
} from '@/app/api/internal/ai/plan-proposals/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { ProjectContext } from '@/lib/projects';

// MOTIR-6052 — a `remove` proposal carries its REASON
// (`agent-authored-plans.md` AMENDMENT 18 §3), against real Postgres.

const SERVICE_SECRET = 'core-callback-secret-remove-reason';
const JOB_ID = 'job_remove_reason';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedItem(fx: WorkItemFixture, title: string): Promise<string> {
  return (
    await workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx)
  ).id;
}

async function openPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Retiring' }, fx.ctx)).id;
}

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  let thrown: Error | undefined;
  try {
    await fn();
  } catch (err) {
    thrown = err as Error;
  }
  expect(thrown, 'the call must be rejected').toBeInstanceOf(Error);
  return thrown!;
}

describe('the column', () => {
  it('is a nullable TEXT with no default — so every legacy remove simply has none', async () => {
    const rows = await adminDb.$queryRawUnsafe<
      Array<{ data_type: string; is_nullable: string; column_default: string | null }>
    >(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'plan_item' AND column_name = 'reason'`,
    );
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });
});

describe('a `remove` round-trips its reason', () => {
  it('persists it trimmed, returns it on the plan read, and null on every other op', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedItem(fx, 'Obsolete');
    const kept = await seedItem(fx, 'Kept');
    const planId = await openPlan(fx);

    await plansService.addProposals(
      planId,
      [
        { op: 'remove', workItemId: card, reason: '  Superseded by the new story.  ' },
        { op: 'modify', workItemId: kept, patch: { title: 'Kept, renamed' } },
        { op: 'add', proposedFields: { title: 'New' } },
      ],
      fx.ctx,
    );

    const plan = await plansService.getPlan(planId, fx.ctx);
    const byOp = Object.fromEntries(plan.items.map((i) => [i.op, i.reason]));
    expect(byOp).toEqual({ remove: 'Superseded by the new story.', modify: null, add: null });
  });

  it('accepts a `remove` with NO reason exactly as before', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedItem(fx, 'Obsolete');
    const planId = await openPlan(fx);
    const plan = await plansService.addProposals(
      planId,
      [{ op: 'remove', workItemId: card }],
      fx.ctx,
    );
    expect(plan.items[0]!.reason).toBeNull();
  });
});

describe('what is refused, by name', () => {
  it.each([
    ['an `add`', { op: 'add' as const, proposedFields: { title: 'New' }, reason: 'why' }],
    ['a `modify`', { op: 'modify' as const, patch: { title: 'X' }, reason: 'why' }],
  ])('a reason on %s', async (_label, proposal) => {
    const fx = await makeWorkItemFixture();
    const card = await seedItem(fx, 'Target');
    const planId = await openPlan(fx);
    const err = await rejection(() =>
      plansService.addProposals(
        planId,
        [{ ...proposal, ...(proposal.op === 'modify' ? { workItemId: card } : {}) }],
        fx.ctx,
      ),
    );
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect(err.message).toContain('`reason`');
  });

  it('a blank reason, and one over the bound', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedItem(fx, 'Target');
    const planId = await openPlan(fx);

    const blank = await rejection(() =>
      plansService.addProposals(
        planId,
        [{ op: 'remove', workItemId: card, reason: '   ' }],
        fx.ctx,
      ),
    );
    expect(blank).toBeInstanceOf(InvalidProposalError);
    expect(blank.message).toContain('blank');

    const long = await rejection(() =>
      plansService.addProposals(
        planId,
        [{ op: 'remove', workItemId: card, reason: 'x'.repeat(PLAN_ITEM_REASON_MAX + 1) }],
        fx.ctx,
      ),
    );
    expect(long).toBeInstanceOf(InvalidProposalError);
    expect(long.message).toContain(String(PLAN_ITEM_REASON_MAX));

    // The bound itself is legal.
    await plansService.addProposals(
      planId,
      [{ op: 'remove', workItemId: card, reason: 'x'.repeat(PLAN_ITEM_REASON_MAX) }],
      fx.ctx,
    );
  });
});

describe('approve writes the reason onto the archived card’s history', () => {
  async function archivedDiff(workItemId: string): Promise<unknown> {
    const revision = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId, changeKind: 'archived' },
    });
    return revision.diff;
  }

  it('records { reason } when there is one, and {} when there is none', async () => {
    const fx = await makeWorkItemFixture();
    const withReason = await seedItem(fx, 'Obsolete, explained');
    const without = await seedItem(fx, 'Obsolete, unexplained');
    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [
        { op: 'remove', workItemId: withReason, reason: 'Replaced by the merge story.' },
        { op: 'remove', workItemId: without },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect(await archivedDiff(withReason)).toEqual({ reason: 'Replaced by the merge story.' });
    expect(await archivedDiff(without)).toEqual({});
  });
});

describe('the internal door — POST persists it, GET returns it', () => {
  function projectCtx(fx: WorkItemFixture): ProjectContext {
    return {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };
  }

  function authed(req: Request, fx: WorkItemFixture): Request {
    req.headers.set('authorization', `Bearer ${SERVICE_SECRET}`);
    req.headers.set('content-type', 'application/json');
    req.headers.set(
      'x-motir-job-token',
      mintJobToken({
        userId: fx.ctx.userId,
        workspaceId: fx.ctx.workspaceId,
        projectId: fx.projectId,
      }),
    );
    return req;
  }

  it('round-trips a remove’s reason through the route pair', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedItem(fx, 'Obsolete');
    vi.mocked(submitJob).mockResolvedValue({ jobId: JOB_ID });
    await aiPlanEditsService.submitAugment('retire the obsolete card', projectCtx(fx));

    const posted = await proposalsPOST(
      authed(
        new Request('http://core/api/internal/ai/plan-proposals', {
          method: 'POST',
          body: JSON.stringify({
            jobId: JOB_ID,
            proposals: [{ op: 'remove', workItemId: card, reason: 'No longer needed.' }],
          }),
        }),
        fx,
      ),
    );
    expect(posted.status).toBe(200);

    const read = await proposalsGET(
      authed(new Request(`http://core/api/internal/ai/plan-proposals?jobId=${JOB_ID}`), fx),
    );
    expect(read.status).toBe(200);
    const body = JSON.stringify(await read.json());
    expect(body).toContain('No longer needed.');
  });
});
