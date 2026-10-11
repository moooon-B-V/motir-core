import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-8149 · Subtask MOTIR-8157 — the hosted planner's BRIEFING reaches
// the plan's `summary` through the internal append seam's FINAL append, against
// real Postgres and through the real route.
//
// The hosted planner (motir-ai) closes its plan with `final: true` and has no
// other door to the plan's summary: `update_plan` (`correctPlanBrief`) is a
// person's / MCP door a job token does not reach, and it writes a
// `brief_edited` row that is wrong for the planner's own first write. So the
// briefing rides the close, exactly as `productName` does.
//
// Every assertion reads the stored row through `adminDb`, never the response —
// a route that dropped the field and answered 200 would satisfy the response.

const SERVICE_SECRET = 'core-callback-secret-test';

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

const ORIGINAL_TITLE = 'Plan for Acme';
const ORIGINAL_SUMMARY = 'What the plan said about itself when it was opened.';
const BRIEFING = [
  '## 1. What was asked and the problem found',
  'The export button is missing.',
  '## 6. Counts',
  '1 new, 0 changed, 0 removed.',
].join('\n');

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

/** A `generating` plan bound to `jobId`, opened with a summary of its own. */
async function openPlan(fx: WorkItemFixture, jobId: string): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { sourceJobId: jobId, summary: ORIGINAL_SUMMARY, title: ORIGINAL_TITLE },
    fx.ctx,
  );
  return plan.id;
}

const ONE_ADD = [{ op: 'add', proposedFields: { title: 'Add the export button', kind: 'task' } }];
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });

describe('the final append carries the planner’s briefing into the plan’s summary', () => {
  it('a final, non-revision append with `summary` stores it and leaves the plan `planned`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_briefing_final');

    const res = await append(fx, {
      jobId: 'job_briefing_final',
      proposals: ONE_ADD,
      final: true,
      summary: `  ${BRIEFING}\n`,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).planned).toBe(true);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    // Trimmed, as `correctPlanBrief` trims — the same rule, not a second one.
    expect(row.summary).toBe(BRIEFING);
  });

  it('a final append with NO summary leaves the plan’s summary exactly as it was', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_briefing_absent');

    const res = await append(fx, { jobId: 'job_briefing_absent', proposals: ONE_ADD, final: true });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.summary).toBe(ORIGINAL_SUMMARY);
  });

  it.each([
    ['a number', 42],
    ['an object', { text: BRIEFING }],
    ['null', null],
    ['a blank string', '   '],
  ])('a final append whose summary is %s is "no summary"', async (_label, summary) => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_briefing_nonstring');

    const res = await append(fx, {
      jobId: 'job_briefing_nonstring',
      proposals: ONE_ADD,
      final: true,
      summary,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.summary).toBe(ORIGINAL_SUMMARY);
  });

  it('a NON-final append carrying `summary` stores nothing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_briefing_nonfinal');

    const res = await append(fx, {
      jobId: 'job_briefing_nonfinal',
      proposals: ONE_ADD,
      summary: BRIEFING,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('generating');
    expect(row.summary).toBe(ORIGINAL_SUMMARY);
  });

  it('a REVISION append carrying `summary` stores nothing — a revision closes no plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_briefing_revision');
    await append(fx, { jobId: 'job_briefing_revision', proposals: ONE_ADD, final: true });
    expect((await planRow(planId)).status).toBe('planned');

    const res = await append(fx, {
      jobId: 'job_briefing_revision',
      proposals: [],
      final: true,
      revision: true,
      summary: BRIEFING,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.summary).toBe(ORIGINAL_SUMMARY);
  });

  it('the briefing and the status are ONE write — a rejected summary leaves the plan `generating`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_briefing_rejected');
    await append(fx, { jobId: 'job_briefing_rejected', proposals: ONE_ADD });

    // Postgres `text` refuses a NUL byte, so this summary cannot be written —
    // and since it rides the close's own write, the close must fail with it.
    await expect(
      plansService.markPlanned(planId, fx.ctx, { summary: 'the briefing\u0000cut short' }),
    ).rejects.toBeDefined();

    const row = await planRow(planId);
    expect(row.status).toBe('generating');
    expect(row.plannedAt).toBeNull();
    expect(row.summary).toBe(ORIGINAL_SUMMARY);
  });

  it('a zero-proposal close (discarded) still stores the briefing it was given', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_briefing_empty');

    const res = await append(fx, {
      jobId: 'job_briefing_empty',
      proposals: [],
      final: true,
      summary: BRIEFING,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).planned).toBe(false);
    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    expect(row.decisionReason).toBe('discarded');
    expect(row.summary).toBe(BRIEFING);
  });
});

// Story MOTIR-8161 · Subtask MOTIR-8164 — the hosted planner NAMES its plan
// through the same seam: an optional `title` on ANY append of a generation,
// written while the plan is `generating` through `correctPlanBrief` (the
// `update_plan` door), so the rename is on the plan's trail as `brief_edited`.
describe('an append carrying `title` names the generating plan', () => {
  const briefEdits = (planId: string) =>
    adminDb.planRevision.findMany({ where: { planId, changeKind: 'brief_edited' } });

  it('a non-final append with `title` renames the generating plan and records the edit', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_title_first');

    const res = await append(fx, {
      jobId: 'job_title_first',
      proposals: ONE_ADD,
      title: '  Add an export button to the report page ',
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('generating');
    expect(row.title).toBe('Add an export button to the report page');
    // The same timeline row a person's `update_plan` title edit writes.
    const edits = await briefEdits(planId);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.diff).toMatchObject({ fields: ['title'], correction: true });
  });

  it('a final append with `title` AND `summary` stores both and closes the plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_title_final');

    const res = await append(fx, {
      jobId: 'job_title_final',
      proposals: ONE_ADD,
      final: true,
      title: 'Export the report as CSV',
      summary: BRIEFING,
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.title).toBe('Export the report as CSV');
    expect(row.summary).toBe(BRIEFING);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a blank string', '   '],
    ['a number', 7],
  ])('an append whose title is %s leaves the title unchanged', async (_label, title) => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_title_none');

    const res = await append(fx, {
      jobId: 'job_title_none',
      proposals: ONE_ADD,
      ...(title === undefined ? {} : { title }),
    });

    expect(res.status).toBe(200);
    expect((await planRow(planId)).title).toBe(ORIGINAL_TITLE);
    expect(await briefEdits(planId)).toHaveLength(0);
  });

  it('a title longer than 200 characters is stored cut to 200, not refused', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_title_long');

    const res = await append(fx, {
      jobId: 'job_title_long',
      proposals: ONE_ADD,
      title: 'x'.repeat(260),
    });

    expect(res.status).toBe(200);
    expect((await planRow(planId)).title).toBe('x'.repeat(200));
  });

  it('a `title` on a REVISION append is ignored and the append behaves as before', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_title_revision');
    await append(fx, { jobId: 'job_title_revision', proposals: ONE_ADD, final: true });
    expect((await planRow(planId)).status).toBe('planned');

    const res = await append(fx, {
      jobId: 'job_title_revision',
      proposals: [],
      final: true,
      revision: true,
      title: 'A revision does not rename',
    });

    expect(res.status).toBe(200);
    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.title).toBe(ORIGINAL_TITLE);
    expect(await briefEdits(planId)).toHaveLength(0);
  });

  it('a `title` sent to a plan that has left `generating` is ignored, not an error', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx, 'job_title_closed');
    await append(fx, { jobId: 'job_title_closed', proposals: ONE_ADD, final: true });
    expect((await planRow(planId)).status).toBe('planned');

    // A late, non-revision append: the title is dropped before the status gate
    // the proposals themselves meet, so the answer is that gate's, unchanged.
    const res = await append(fx, {
      jobId: 'job_title_closed',
      proposals: [],
      title: 'Too late to rename',
    });

    expect(res.status).toBe(200);
    expect((await planRow(planId)).title).toBe(ORIGINAL_TITLE);
    expect(await briefEdits(planId)).toHaveLength(0);
  });
});
