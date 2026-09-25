import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planGateHeldOf } from '@/lib/approvalGates/planApprovalHandler';
import { RECORD_PLAN_REVISION_REASON_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { GET_PLAN_STATUS_TOOL_NAME } from '@/lib/mcp/tools/expandItem';
import { REASON_CLASSIFIED_KIND } from '@/lib/plans/revisionReason';
import { NATIVE_PLANNER_HARNESS } from '@/lib/ai/plannerTenantBug';
import { POST as reasonPOST } from '@/app/api/internal/ai/plan-revision-reason/route';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE STORY GATE, motir-core's half (Story MOTIR-5543 · Subtask MOTIR-6090).
//
// Its three children each prove their own layer. This measures what only their
// COMPOSITION can be wrong about, and the story makes two promises across them:
//
//   1. A classification written through EITHER door lands as ONE internal
//      record, readable by the internal read, with the same branch, evidence
//      and bug.
//   2. ⚠️ AND NO TENANT EVER SEES IT. This is the harder promise and the reason
//      the gate exists: the timeline, the plan gate, the revision lease and the
//      To-approve page all walk the SAME revision table, so any one of them
//      could expose a row no card meant to show. A per-layer unit cannot catch
//      that, because each layer is individually correct.
//
// ── THE READER SET, ENUMERATED ON `origin/main` RATHER THAN RECALLED ─────────
//
// Two searches, per the caller-sweep lesson — the SYMBOL and the repository's
// own read METHODS — plus a third for the surfaces that might hold their own
// query:
//
//   git grep -l planRevisionRepository origin/main -- 'lib/**' 'app/**' 'components/**'
//   git grep -n '\.planRevision\b'      origin/main -- 'lib/**' 'app/**'
//   git grep -ln planRevisionRepository origin/main -- 'app/**' 'lib/mcp/**' 'lib/api/**'
//
// The third returns NOTHING: no route, no MCP tool and no `/api/v1` file reads
// the table directly — every path goes through a service. So the tenant-facing
// reader set is exactly:
//
//   · planReviewService.getPlanReview  → listByPlan            (the review TIMELINE)
//   · planApprovalHandler.planGateHeld → listByPlan            (the plan gate's held check)
//   · plansService lease reads (×3)    → listByPlan            (the revision lease)
//   · subjectSummary                   → listLeaseRowsByPlans  (the To-approve page)
//   · aiWorkItemsService               → countByPlanAndKind('bug_filed')
//
// and the last of those cannot return a classification at all: it is narrowed to
// one named verb by its caller.
//
// TWO MORE ARE ASSERTED THOUGH THEY ARE STRUCTURALLY CLEAN, because "it cannot
// happen today" is a fact about today's code and this gate outlives it:
//   · plansService.listPlanHistoryForWorkItem (MOTIR-5542's read on a work item)
//     reads `planRepository` + `planItemRepository` and never `planRevision`;
//   · MCP `get_plan` / `get_plan_status` carry no history field at all.
//
// ── HOW THE INVISIBILITY IS ASSERTED ────────────────────────────────────────
// A unique MARKER is planted in the evidence and every reader's whole serialised
// response is searched for it, for the branch values and for the kind. Searching
// the serialisation rather than a named field is deliberate: a field ADDED to a
// DTO later is exactly the regression this gate is for, and a test that looked
// only at `history[].kind` would not see it.
//
// ⚠️ AND EVERY CASE RUNS AGAINST A PLAN THAT HAS A CLASSIFICATION, confirmed
// through the admin client first. An absence asserted over an empty table is the
// one way a guard like this can be green and prove nothing.

const SERVICE_SECRET = 'core-callback-secret-test';

/** Planted in the evidence and hunted for in every tenant response. */
const MARKER = 'zz-classification-marker-9f3a2b';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'classification-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** A `planned` plan bound to a job — reachable by BOTH doors. */
async function plannedPlan(fx: WorkItemFixture, jobId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The picker', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

async function planningBug(fx: WorkItemFixture) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'bug', title: 'Planning bug: the check nobody made' },
    fx.ctx,
  );
}

function routeReq(token: string, body: unknown): Request {
  return new Request('http://core/api/internal/ai/plan-revision-reason', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SERVICE_SECRET}`,
      'x-motir-job-token': token,
    },
    body: JSON.stringify(body),
  });
}

const jobTokenFor = (fx: WorkItemFixture) =>
  mintJobToken({ userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId: fx.projectId });

const readClassifications = (fx: WorkItemFixture, planId: string) =>
  withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planRevisionRepository.listReasonClassifications({ planId }, tx),
  );

const storedClassifications = (planId: string) =>
  adminDb.planRevision.findMany({
    where: { planId, changeKind: REASON_CLASSIFIED_KIND },
    orderBy: { changedAt: 'asc' },
  });

// ─────────────────────────────────────────────────────────────────────────────
describe('door → record: the MCP tool', () => {
  it.each(['new_ask', 'different_solution', 'rule_gap', 'rule_not_followed'] as const)(
    'records `%s` and the INTERNAL read hands it back whole',
    async (branch) => {
      const fx = await makeWorkItemFixture();
      const client = await connectClient(fx.ctx);
      const planId = await plannedPlan(fx, `job_gate_mcp_${branch}`);
      const needsBug = branch === 'rule_gap' || branch === 'rule_not_followed';
      const bug = needsBug ? await planningBug(fx) : null;

      await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
        planId,
        branch,
        evidenceMd: `${MARKER} — the evidence for ${branch}.`,
        ...(bug ? { planningBugKey: bug.identifier } : {}),
      });

      const rows = await readClassifications(fx, planId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.diff as { branch: string; planningBugId: string | null }).toEqual({
        branch,
        planningBugId: bug?.id ?? null,
      });
      expect(rows[0]!.noteMd).toContain(MARKER);
    },
  );
});

describe('door → record: the internal AI route', () => {
  it.each(['new_ask', 'different_solution', 'rule_gap', 'rule_not_followed'] as const)(
    'records `%s` identically, attributed to the AI agent',
    async (branch) => {
      const fx = await makeWorkItemFixture();
      const jobId = `job_gate_route_${branch}`;
      const planId = await plannedPlan(fx, jobId);
      const needsBug = branch === 'rule_gap' || branch === 'rule_not_followed';
      const bug = needsBug ? await planningBug(fx) : null;

      const res = await reasonPOST(
        routeReq(jobTokenFor(fx), {
          jobId,
          branch,
          evidenceMd: `${MARKER} — the evidence for ${branch}.`,
          planningBugId: bug?.id ?? null,
          model: 'deepseek-v4-pro',
        }),
      );
      expect(res.status).toBe(201);

      const rows = await readClassifications(fx, planId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.diff as { branch: string; planningBugId: string | null }).toEqual({
        branch,
        planningBugId: bug?.id ?? null,
      });
      // The ACTOR is the difference between the two doors, and it is the whole
      // reason Motir can later tell its two planners apart from one table.
      expect(rows[0]!.actorSource).toBe('native');
      expect(rows[0]!.actorHarness).toBe(NATIVE_PLANNER_HARNESS);
      expect(rows[0]!.actorModel).toBe('deepseek-v4-pro');
    },
  );
});

describe('both doors on ONE plan', () => {
  it('reads back as two records in time order, distinguishable by actor', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const jobId = 'job_gate_both';
    const planId = await plannedPlan(fx, jobId);

    // The runbook first…
    await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'different_solution',
      evidenceMd: `${MARKER} — runbook: they prefer a side panel.`,
    });
    // …then the shipped planner.
    const res = await reasonPOST(
      routeReq(jobTokenFor(fx), {
        jobId,
        branch: 'new_ask',
        evidenceMd: `${MARKER} — revise pass: export was never raised.`,
        model: 'deepseek-v4-pro',
      }),
    );
    expect(res.status).toBe(201);

    // The internal read is newest-first.
    const rows = await readClassifications(fx, planId);
    expect(rows.map((r) => (r.diff as { branch: string }).branch)).toEqual([
      'new_ask',
      'different_solution',
    ]);
    expect(rows[0]!.actorSource).toBe('native');
    expect(rows[1]!.actorSource).toBeNull();
    // Stored order is oldest-first; the two views agree about WHICH came first.
    const stored = await storedClassifications(planId);
    expect(stored.map((r) => (r.diff as { branch: string }).branch)).toEqual([
      'different_solution',
      'new_ask',
    ]);
  });
});

describe('the status guard holds at BOTH doors, with the same code', () => {
  it.each(['approved', 'declined'] as const)(
    'refuses on a `%s` plan through the tool AND the route',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const client = await connectClient(fx.ctx);
      const jobId = `job_gate_status_${status}`;
      const planId = await plannedPlan(fx, jobId);
      await adminDb.plan.update({ where: { id: planId }, data: { status } });

      const viaTool = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
        planId,
        branch: 'new_ask',
        evidenceMd: `${MARKER} — too late.`,
      });
      expect(viaTool.isError).toBe(true);
      expect(textOf(viaTool)).toContain('PLAN_NOT_EDITABLE');

      const viaRoute = await reasonPOST(
        routeReq(jobTokenFor(fx), {
          jobId,
          branch: 'new_ask',
          evidenceMd: `${MARKER} — too late.`,
        }),
      );
      expect(viaRoute.status).toBe(409);
      // THE SAME CODE from both doors — one refusal, two transports.
      expect(((await viaRoute.json()) as { code: string }).code).toBe('PLAN_NOT_EDITABLE');

      expect(await storedClassifications(planId)).toHaveLength(0);
    },
  );
});

describe('isolation — a credential from another workspace reaches neither door', () => {
  it('refuses the MCP tool and the internal route, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const jobId = 'job_gate_isolation';
    const planId = await plannedPlan(fx, jobId);

    const outsiderClient = await connectClient(other.ctx);
    const viaTool = await call(outsiderClient, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'new_ask',
      evidenceMd: `${MARKER} — not yours.`,
    });
    expect(viaTool.isError).toBe(true);

    const viaRoute = await reasonPOST(
      routeReq(jobTokenFor(other), {
        jobId,
        branch: 'new_ask',
        evidenceMd: `${MARKER} — not yours.`,
      }),
    );
    expect(viaRoute.status).toBe(404);

    expect(await storedClassifications(planId)).toHaveLength(0);
  });
});

describe('the count-shaped `diff` contract survives', () => {
  it('never carries the evidence — that is what `noteMd` is for', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(fx, 'job_gate_diff');

    await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'new_ask',
      evidenceMd: `${MARKER} — prose that must not reach the count-shaped payload.`,
    });

    const rows = await storedClassifications(planId);
    expect(JSON.stringify(rows[0]!.diff)).not.toContain(MARKER);
    expect(Object.keys(rows[0]!.diff as object).sort()).toEqual(['branch', 'planningBugId']);
    expect(rows[0]!.noteMd).toContain(MARKER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT-INVISIBILITY GUARD — the story's constraint.
// ─────────────────────────────────────────────────────────────────────────────
describe('NO tenant-facing read returns a classification', () => {
  /** A plan carrying BOTH doors' classifications, with the marker planted. */
  async function planWithBoth(fx: WorkItemFixture, jobId: string): Promise<string> {
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(fx, jobId);
    const bug = await planningBug(fx);

    await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'rule_not_followed',
      evidenceMd: `${MARKER} — the pack required the check and the pass skipped it.`,
      planningBugKey: bug.identifier,
    });
    const res = await reasonPOST(
      routeReq(jobTokenFor(fx), {
        jobId,
        branch: 'rule_gap',
        evidenceMd: `${MARKER} — searched the corpus; nothing asks for it.`,
        planningBugId: bug.id,
      }),
    );
    expect(res.status).toBe(201);

    // ⚠️ THE CONTROL. Without it every assertion below would pass on an empty
    // table, which is the one way an invisibility guard can lie.
    expect(await storedClassifications(planId)).toHaveLength(2);
    return planId;
  }

  /** The claim, asked of one reader's whole serialised response. */
  function expectClean(label: string, serialised: string): void {
    expect(serialised, `${label} leaked the marker`).not.toContain(MARKER);
    expect(serialised, `${label} leaked the kind`).not.toContain(REASON_CLASSIFIED_KIND);
    for (const branch of ['rule_gap', 'rule_not_followed', 'new_ask', 'different_solution']) {
      expect(serialised, `${label} leaked the branch \`${branch}\``).not.toContain(branch);
    }
  }

  it('planReviewService.getPlanReview — the plan review TIMELINE', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWithBoth(fx, 'job_invis_review');

    const model = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(model.history.length).toBeGreaterThan(0); // the ordinary events are still there
    expectClean('the plan review model', JSON.stringify(model));
  });

  it('planApprovalHandler — the plan GATE’s held check', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWithBoth(fx, 'job_invis_gate');

    // The gate's own reading of the trail. A classification must not make a
    // plan look busy: a held gate is a claim that a revision is RUNNING, and
    // recording why a change was asked is not doing the change.
    const trail = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listByPlan(planId, tx),
    );
    expect(trail.length).toBeGreaterThan(0);
    expect(planGateHeldOf(trail)).toBeNull();
    expectClean('the plan gate held check', JSON.stringify(trail));
  });

  it('planRevisionRepository.listLeaseRowsByPlans — the To-approve page’s read', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWithBoth(fx, 'job_invis_toapprove');

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listLeaseRowsByPlans([planId], tx),
    );
    expect(rows.length).toBeGreaterThan(0);
    expectClean('the To-approve lease rows', JSON.stringify(rows));
  });

  it('planRevisionRepository.listByPlan — the shared trail read every service goes through', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planWithBoth(fx, 'job_invis_trail');

    const trail = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listByPlan(planId, tx),
    );
    expect(trail.length).toBeGreaterThan(0);
    expectClean('the shared trail read', JSON.stringify(trail));
  });

  it('MCP get_plan / get_plan_status', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await planWithBoth(fx, 'job_invis_mcp');

    const plan = await call(client, GET_PLAN_TOOL_NAME, { planId });
    const status = await call(client, GET_PLAN_STATUS_TOOL_NAME, { planId });

    // Asserted although both are structurally clean today — they carry no
    // history field at all. "It cannot happen" is a fact about today's code,
    // and this gate outlives it.
    expectClean('get_plan', JSON.stringify(plan));
    expectClean('get_plan_status', JSON.stringify(status));
  });

  it('plansService.listPlanHistoryForWorkItem — a work item’s plan history (MOTIR-5542)', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const jobId = 'job_invis_workitem';

    // The card this plan SHAPES, and a `modify` against it appended while the
    // plan is still `generating` — so the history read has a row to return and
    // the assertion is not vacuous. Built here rather than on `planWithBoth`'s
    // plan so the case turns on nothing but the read under test.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A shaped card' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: item.id, patch: { title: 'A reshaped card' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const bug = await planningBug(fx);
    await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId: plan.id,
      branch: 'rule_gap',
      evidenceMd: `${MARKER} — searched the corpus; nothing asks for it.`,
      planningBugKey: bug.identifier,
    });
    // THE CONTROL, as everywhere else in this block.
    expect(await storedClassifications(plan.id)).toHaveLength(1);

    const page = await plansService.listPlanHistoryForWorkItem(fx.projectId, item.id, {}, fx.ctx);

    // The read returns this plan…
    expect(JSON.stringify(page)).toContain(plan.id);
    // …and no trace of the classification on it. It reads `planRepository` +
    // `planItemRepository` and never `planRevision`, so it is clean by
    // construction — asserted so a reader added to it later cannot quietly
    // change that.
    expectClean('the work item’s plan history', JSON.stringify(page));

    await client.close();
  });
});
