import { beforeEach, describe, expect, it, vi } from 'vitest';

// motir-ai is the only thing stubbed — it is what mints the job id the plan and
// the conversation both bind to. Every route, service, Plan row, session row and
// response below is real, against real Postgres.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
  getJob: vi.fn(),
}));

import { POST as APPROVE } from '@/app/api/v1/work-items/[key]/plan-approval/route';
import { POST as SESSION_SUBMIT } from '@/app/api/v1/projects/[projectKey]/plan-session/submissions/route';
import { POST as SESSION_TURN } from '@/app/api/v1/projects/[projectKey]/plan-session/turns/route';
import { submitJob } from '@/lib/ai/motirAiClient';
import { DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import { planSchema, type V1Plan } from '@/lib/api/v1/workLoop/schema';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  createV1ProjectCaller,
  withTokenFor,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/work-items/{key}/plan-approval (MOTIR-3021 / MOTIR-3023) — the
// bounded public entrance `motir auto --auto-approve-replan` drives, against
// real Postgres. `docs/decisions/run-findings-protocol.md` Q2 is its spec.
//
// This endpoint reverses a deliberate absence, so the tests that matter are the
// ones about what it REFUSES:
//
//   • THE ANCHOR (B1), and it is STRUCTURAL here rather than checked: the route
//     takes no plan id at all, so a caller cannot name a plan the card did not
//     produce. Every other plan — a cadence plan, an onboarding generation, one
//     submitted from the project-wide panel — keeps the human decision it was
//     written under, because none of them is reachable from a card's key.
//   • NO SECOND IMPLEMENTATION. The one-shot guard, the confirmation gate and
//     the `ai:view_plan` assertion are the shipped service's; a 409 on a second
//     approve is the SAME 409 the in-app route answers.
//   • NO EXISTENCE LEAK. Another tenant's plan and an invented id are one answer.
//   • A DISPATCHED AGENT CANNOT REACH IT. `CLI_TOKEN_GRANT` omits the key, and
//     that is asserted here rather than left as a property of a constant nobody
//     reads next to this route.

const BASE = 'http://localhost:3000/api/v1';

/** The permission set an OPERATOR driving `motir auto` holds. */
const OPERATOR = ['project:browse', 'work_item:edit', 'ai:plan', 'ai:view_plan'] as const;

function approve(caller: V1ProjectCaller, key: string): Promise<Response> {
  return APPROVE(
    new Request(`${BASE}/work-items/${key}/plan-approval`, {
      method: 'POST',
      headers: caller.headers,
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function makeItem(caller: V1ProjectCaller, title: string) {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title },
    caller.ctx,
  );
}

function sessionReq(caller: V1ProjectCaller, suffix: string, body: unknown): Request {
  return new Request(`${BASE}/projects/${caller.projectKey}/plan-session${suffix}`, {
    method: 'POST',
    headers: { ...caller.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Build the exact shape a refused run leaves behind: an ANCHORED plan-change
 * conversation about one card, submitted, with a `planned` plan carrying one
 * proposal.
 *
 * Driven through the REAL submit path rather than by writing rows, because the
 * anchor this endpoint checks is DERIVED — `plan.sourceJobId` → the session
 * whose `lastJobId` is that job → its `targetKeys` — and a hand-built fixture
 * could satisfy the check while the real path did not produce it.
 */
async function refusedCardWithPlan(
  caller: V1ProjectCaller,
  opts: { jobId?: string; anchored?: boolean; close?: boolean } = {},
): Promise<{ key: string; planId: string }> {
  const item = await makeItem(caller, 'the card the agent refused');
  const jobId = opts.jobId ?? `job_${item.identifier}`;
  vi.mocked(submitJob).mockResolvedValue({ jobId } as Awaited<ReturnType<typeof submitJob>>);

  const args = { params: Promise.resolve({ projectKey: caller.projectKey }) };
  const targetKeys = opts.anchored === false ? [] : [item.identifier];
  await SESSION_TURN(
    sessionReq(caller, '/turns', { body: 'its premise is false', targetKeys }),
    args,
  );
  const submitted = await SESSION_SUBMIT(sessionReq(caller, '/submissions', { targetKeys }), args);
  expect(submitted.status).toBe(202);
  const { planId } = (await submitted.json()) as { planId: string };

  // The proposals a planner would have appended, then closed into `planned`.
  await plansService.addProposals(
    planId,
    // A `task`, not a `subtask`: the confirmation gate applies the same
    // kind-parent matrix a human create is gated on, and a parentless subtask is
    // refused by it — correctly, and not what these tests are about.
    [{ op: 'add', proposedFields: { title: 'the corrected card', kind: 'task' } }],
    caller.ctx,
  );
  // `close: false` leaves the plan `generating` — the state a run actually meets,
  // because the agent submits with `--detach` and the planner is still writing.
  if (opts.close !== false) await plansService.markPlanned(planId, caller.ctx);
  return { key: item.identifier, planId };
}

describe('POST /api/v1/work-items/{key}/plan-approval', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('approves the plan the card produced, and materializes its proposals', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);

    const res = await approve(caller, key);

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1Plan;
    expect(() => planSchema.parse(body)).not.toThrow();
    expect(body.status).toBe('approved');
    // The proposal became a row — asserted through the payload, which is what a
    // client reads, rather than by counting the table behind it.
    expect(body.proposals[0]?.workItemKey).not.toBeNull();
    // And the plan's own id comes back, which is how a caller that never knew it
    // reports WHAT it approved.
    expect(body.id).toBeTruthy();
  });

  it('accepts the key case-insensitively — a caller types either', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);

    expect((await approve(caller, key.toLowerCase())).status).toBe(200);
  });

  // ── B1, the bound ─────────────────────────────────────────────────────────

  it('REFUSES a card with no plan of its own, and says why', async () => {
    // The card exists and the caller may edit it; there is simply no plan its
    // own refusal produced. A DIFFERENT card's plan is not reachable from here
    // at all — the route takes no plan id — which is what makes this bound
    // structural rather than a check.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    await refusedCardWithPlan(caller);
    const other = await makeItem(caller, 'a different card entirely');

    const res = await approve(caller, other.identifier);

    expect(res.status).toBe(DOMAIN_ERROR_STATUS['NO_PLAN_FOR_WORK_ITEM']);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('NO_PLAN_FOR_WORK_ITEM');
    // Actionable, not a bare refusal: it names the card and where to go instead.
    expect(body.error).toContain(other.identifier);
    expect(body.error).toContain('approve any other plan in Motir');
  });

  it('REFUSES when the plan came from the PROJECT-WIDE thread — unanchored is not unrestricted', async () => {
    // The case the bound most protects: a project-wide plan is the shape a
    // cadence plan and an onboarding generation both have. Treating "no anchor"
    // as "no restriction" would invert the bound at exactly the plans a person
    // is most expected to decide on.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller, { anchored: false });

    const res = await approve(caller, key);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('NO_PLAN_FOR_WORK_ITEM');
    // And nothing was approved: the plan is where it was.
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('planned');
  });

  it('REFUSES a card whose conversation exists but has never submitted', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const item = await makeItem(caller, 'talked about, never submitted');
    await SESSION_TURN(
      sessionReq(caller, '/turns', { body: 'thinking about it', targetKeys: [item.identifier] }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );

    const res = await approve(caller, item.identifier);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('NO_PLAN_FOR_WORK_ITEM');
  });

  // ── B2 / B3, inherited from the service ───────────────────────────────────

  it('answers 409 on a SECOND approve — the same one-shot guard the app hits', async () => {
    // Mirrored, not softened into a no-op. Two entrances answering one condition
    // two ways is what "no second approval implementation" exists to prevent.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);

    expect((await approve(caller, key)).status).toBe(200);
    const second = await approve(caller, key);

    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('PLAN_NOT_IN_EXPECTED_STATUS');
  });

  it('carries the plan STATUS on the 409 — the field a loop branches on', async () => {
    // ⚠️ THE REFUSAL TEACHES. An agent submits with `--detach` and exits within
    // milliseconds, so an unattended run routinely arrives while the planner is
    // still WRITING the plan. `generating` means wait; `approved` / `declined`
    // mean somebody already decided and the run must stop. They are one word
    // apart in the sentence, and a client must not be parsing sentences
    // (`public-api-conventions.md` §8) — so the status is DATA, and this is the
    // test that keeps it there.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller, { close: false });

    const generating = await approve(caller, key);

    expect(generating.status).toBe(409);
    expect(await generating.json()).toMatchObject({
      code: 'PLAN_NOT_IN_EXPECTED_STATUS',
      planStatus: 'generating',
    });

    // …and the OTHER side of the same field, so the two are provably distinct.
    await plansService.markPlanned(planId, caller.ctx);
    expect((await approve(caller, key)).status).toBe(200);
    const decided = await approve(caller, key);
    expect(decided.status).toBe(409);
    expect(await decided.json()).toMatchObject({ planStatus: 'approved' });
  });

  it('answers 409 for a DECLINED plan, without changing it', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    await plansService.declinePlan(planId, caller.ctx);

    const res = await approve(caller, key);

    expect(res.status).toBe(409);
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('declined');
  });

  // ── B4, and the scope ─────────────────────────────────────────────────────

  it('404s an unknown card and another tenant’s card IDENTICALLY — no existence leak', async () => {
    const mine = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    // ⚠️ A DISTINCT project prefix, and it is load-bearing. Both fixtures
    // default to `PROD`, so the other tenant's `PROD-1` would RESOLVE inside
    // this one — to a different card that happens to share the number — and the
    // test would assert a cross-tenant refusal it never made.
    const theirs = await createV1ProjectCaller({
      permissions: [...OPERATOR],
      workspaceName: 'the other tenant',
      identifier: 'ACME',
    });
    const { key, planId } = await refusedCardWithPlan(theirs);

    const foreign = await approve(mine, key);
    const invented = await approve(mine, 'ACME-9999');

    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(((await foreign.json()) as { code: string }).code).toBe(
      ((await invented.json()) as { code: string }).code,
    );
    // And theirs is untouched.
    expect((await plansService.getPlan(planId, theirs.ctx)).status).toBe('planned');
  });

  it('403s a token without `ai:view_plan`', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    // A SECOND token in the SAME project — the narrower grant, not a second
    // tenant, so the refusal is about the permission and nothing else.
    const reader = await withTokenFor(caller.fixture.owner, caller.fixture.workspace, {
      projectId: caller.fixture.projectId,
      permissions: ['project:browse', 'work_item:edit', 'ai:plan'],
    });

    const res = await approve({ ...caller, ...reader }, key);

    expect(res.status).toBe(403);
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('planned');
  });

  it('a DISPATCHED AGENT’s grant cannot reach this route at all', async () => {
    // The structural half of the design: the operator approves, never the agent
    // whose card was refused. Enforced by `CLI_TOKEN_GRANT` omitting the key —
    // asserted HERE, beside the route, so widening that constant fails a test
    // that says why rather than quietly opening this door.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');

    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);
    const agent = await withTokenFor(caller.fixture.owner, caller.fixture.workspace, {
      projectId: caller.fixture.projectId,
      permissions: [...CLI_TOKEN_GRANT],
    });

    expect((await approve({ ...caller, ...agent }, key)).status).toBe(403);
  });

  // ── the contract ──────────────────────────────────────────────────────────

  it('is DECLARED in the operation registry, with the permission the route enforces', () => {
    const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === 'approveWorkItemPlan');
    expect(op).toBeDefined();
    expect(op?.method).toBe('POST');
    expect(op?.path).toBe('/api/v1/work-items/{key}/plan-approval');
    expect(op?.permission).toBe('ai:view_plan');
    // The statuses it can actually answer, all of them exercised above.
    expect(op?.errorStatuses).toEqual(expect.arrayContaining([404, 409, 422]));
    // It takes NO request body: the card in the path is the whole address, which
    // is the bound. A body would be somewhere for a plan id to creep back in.
    expect(op?.requestBody).toBeUndefined();
  });

  it('leaves the IN-APP approve exactly as it was', async () => {
    // Nothing about the session route changes — the same service, reached the
    // way it always was, on a plan this endpoint never touched.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { planId } = await refusedCardWithPlan(caller);

    expect((await plansService.approvePlan(planId, caller.ctx)).status).toBe('approved');
  });
});
