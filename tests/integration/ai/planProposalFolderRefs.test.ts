import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external boundary a submit would
// otherwise reach. Everything else is real: Postgres, the job-token auth, the
// `plansService` transaction, and the internal routes motir-ai calls.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { submitJob } from '@/lib/ai/motirAiClient';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { foldersService } from '@/lib/services/foldersService';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { PATCH as proposalPATCH } from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { ProjectContext } from '@/lib/projects';

// The INTERNAL doors take `folder:<id>` too (Story MOTIR-5310 · Subtask MOTIR-5414)
// — `POST /api/internal/ai/plan-proposals` and the correction `PATCH` on
// `plan-proposals/[itemId]` feed the same `ProposalInput` into the same service
// the MCP door does, so they needed no parsing change. What they did need is to
// ANSWER a refusal with the code the MCP door returns rather than an unmapped
// 500 — and that is what this file pins, beside the happy append.

const SERVICE_SECRET = 'core-callback-secret-folder-refs';
const JOB_ID = 'job_folder_refs';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

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

function append(fx: WorkItemFixture, body: unknown): Promise<Response> {
  return proposalsPOST(
    authed(
      new Request('http://core/api/internal/ai/plan-proposals', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      fx,
    ),
  );
}

function correct(fx: WorkItemFixture, itemId: string, body: unknown): Promise<Response> {
  return proposalPATCH(
    authed(
      new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
      fx,
    ),
    { params: Promise.resolve({ itemId }) },
  );
}

async function openJobPlan(fx: WorkItemFixture): Promise<string> {
  vi.mocked(submitJob).mockResolvedValue({ jobId: JOB_ID });
  const { planId } = await aiPlanEditsService.submitAugment('file some ideas', projectCtx(fx));
  return planId;
}

describe('POST /api/internal/ai/plan-proposals — `folder:` refs', () => {
  it('appends a folder-placed `add`', async () => {
    const fx = await makeWorkItemFixture();
    const backlog = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Backlog ideas' },
      fx.ctx,
    );
    const planId = await openJobPlan(fx);

    const res = await append(fx, {
      jobId: JOB_ID,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Filed idea', kind: 'subtask' },
          parentRef: `folder:${backlog.id}`,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { planItemIds: string[] };
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: body.planItemIds[0] } });
    expect(row.planId).toBe(planId);
    expect(row.parentRef).toBe(`folder:${backlog.id}`);
  });

  it('refuses an unknown folder with 422 and the MCP door’s code, appending nothing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openJobPlan(fx);

    const res = await append(fx, {
      jobId: JOB_ID,
      proposals: [
        { op: 'add', proposedFields: { title: 'Nowhere' }, parentRef: 'folder:fold_gone' },
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; reason: string; error: string };
    expect(body.code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(body.reason).toBe('dangling');
    expect(body.error).toContain('folder:fold_gone');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
  });
});

describe('PATCH /api/internal/ai/plan-proposals/[itemId] — a correction to a `folder:` ref', () => {
  it('re-points an `add` into a folder, and refuses an unknown folder with 422', async () => {
    const fx = await makeWorkItemFixture();
    const backlog = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Backlog ideas' },
      fx.ctx,
    );
    await openJobPlan(fx);
    const appended = await append(fx, {
      jobId: JOB_ID,
      proposals: [{ op: 'add', proposedFields: { title: 'Root story', kind: 'story' } }],
    });
    const [itemId] = ((await appended.json()) as { planItemIds: string[] }).planItemIds;

    const ok = await correct(fx, itemId!, {
      jobId: JOB_ID,
      mode: 'correct',
      parentRef: `folder:${backlog.id}`,
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).parentRef).toBe(
      `folder:${backlog.id}`,
    );

    const refused = await correct(fx, itemId!, {
      jobId: JOB_ID,
      mode: 'correct',
      parentRef: 'folder:fold_gone',
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { code: string }).code).toBe('INVALID_PLAN_REF_GRAPH');
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).parentRef).toBe(
      `folder:${backlog.id}`,
    );
  });
});
