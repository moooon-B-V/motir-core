import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary this
// test cannot and must not reach. Everything below it is real: a real Postgres,
// the real `plansService` transactions, the real routes, real job-token auth.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import {
  CORRECT_PROPOSAL_KEYS,
  UPDATE_PROPOSAL_KEYS,
  type CorrectProposalKey,
  type UpdateProposalKey,
} from '@/lib/dto/plans';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import {
  GET as proposalsGET,
  POST as proposalsPOST,
} from '@/app/api/internal/ai/plan-proposals/route';
import {
  PATCH as itemPATCH,
  DELETE as itemDELETE,
} from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-3595 · Subtask MOTIR-3598 — the JOB-TOKEN door onto
// `plansService.correctProposal` / `.withdrawProposal`, through the REAL routes.
//
// The service-level half lives in `tests/integration/plans/revisionLease.test.ts`;
// what is here is what only the transport can be wrong about: the explicit
// `mode` discriminator, the DELETE verb, and — the card's own criterion — that
// the service's frozen-status refusal arrives as a TYPED client-visible status
// rather than as a 500.

const SERVICE_SECRET = 'core-callback-secret-test';
const AGENT = { source: null, harness: 'Motir AI', model: 'claude-opus-5' };

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function tokenFor(fx: WorkItemFixture): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function patch(fx: WorkItemFixture, itemId: string, body: unknown): Promise<Response> {
  const req = new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
    body: JSON.stringify(body),
  });
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return itemPATCH(req, { params: Promise.resolve({ itemId }) });
}

function del(fx: WorkItemFixture, itemId: string, jobId: string): Promise<Response> {
  const req = new Request(
    `http://core/api/internal/ai/plan-proposals/${itemId}?jobId=${encodeURIComponent(jobId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${SERVICE_SECRET}` } },
  );
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return itemDELETE(req, { params: Promise.resolve({ itemId }) });
}

function append(fx: WorkItemFixture, body: unknown): Promise<Response> {
  const req = new Request('http://core/api/internal/ai/plan-proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
    body: JSON.stringify(body),
  });
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return proposalsPOST(req);
}

/** A `planned` plan bound to `jobId`, carrying two `add`s appended separately so
 *  both ids are refable. */
async function plannedPlan(fx: WorkItemFixture, jobId: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const first = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'story' } }],
    fx.ctx,
  );
  const second = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The dependent', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return { planId: plan.id, firstId: first.items[0]!.id, secondId: second.items[1]!.id };
}

/** The `generating` twin of {@link plannedPlan} — the status the DEEPEN mode
 *  gates on, so a key can be asserted on BOTH modes rather than only the one
 *  that happened to be under test. */
async function generatingPlan(fx: WorkItemFixture, jobId: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Still generating', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A skeleton card', kind: 'subtask' } }],
    fx.ctx,
  );
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

describe('PATCH — `mode: "correct"` reaches the correction door', () => {
  it('carries the STRUCTURAL fields the deepen turn may not touch', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await plannedPlan(fx, 'job-1');

    const res = await patch(fx, secondId, {
      jobId: 'job-1',
      mode: 'correct',
      parentRef: `planItem:${firstId}`,
      blockedByRefs: [`planItem:${firstId}`],
      patch: { title: 'The dependent, renamed' },
    });
    expect(res.status).toBe(200);

    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } });
    expect(stored.parentRef).toBe(`planItem:${firstId}`);
    expect(stored.blockedByRefs).toEqual([`planItem:${firstId}`]);
    // The CONTENT bag still rides `patch`, exactly as it does on the deepen path
    // — one key, one meaning, on both modes.
    expect((stored.proposedFields as { title?: string }).title).toBe('The dependent, renamed');
    expect(await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      status: 'planned',
    });
  });

  it('WITHOUT the mode it is the DEEPEN route, byte-identical — and a `planned` plan is refused', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId } = await plannedPlan(fx, 'job-2');

    // The deepen gate is `generating`, and this plan is not. The mode is
    // EXPLICIT precisely so a body that happens to carry `parentRef` cannot
    // silently become a correction and slip past it.
    const res = await patch(fx, firstId, {
      jobId: 'job-2',
      parentRef: 'something',
      patch: { descriptionMd: 'Deepened' },
    });
    expect(res.status).toBe(409);
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: firstId } });
    expect(stored.parentRef).toBeNull();
  });

  it('a `modify`’s patch rides `modifyPatch`, which is a DIFFERENT thing from the content bag', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'With a modify', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const target = await createTestWorkItem(fx, { kind: 'story', title: 'A committed story' });
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-modify' } });
    const modifyId = appended.items[0]!.id;

    const res = await patch(fx, modifyId, {
      jobId: 'job-modify',
      mode: 'correct',
      modifyPatch: { priority: 'highest' },
    });
    expect(res.status).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } })).patch,
    ).toMatchObject({ priority: 'highest' });
  });

  it('a FROZEN plan is refused with a TYPED 409, never a 500', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId } = await plannedPlan(fx, 'job-3');
    await plansService.declinePlan(planId, fx.ctx);

    const res = await patch(fx, firstId, {
      jobId: 'job-3',
      mode: 'correct',
      patch: null,
      title: 'Too late',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_EDITABLE' });
  });

  it('an UNRESOLVABLE corrected ref is a typed 422', async () => {
    const fx = await makeWorkItemFixture();
    const { secondId } = await plannedPlan(fx, 'job-4');

    const res = await patch(fx, secondId, {
      jobId: 'job-4',
      mode: 'correct',
      blockedByRefs: ['planItem:nothing-at-all'],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'UNRESOLVED_PLAN_REF' });
  });

  // ── MOTIR-3865 · THE TRANSPORT PARITY GUARD ─────────────────────────────────
  //
  // ⚠️ THE FAILURE THIS ENDS IS SILENT AT EVERY LAYER. A key declared on
  // `UpdateProposalInput` / `CorrectProposalInput` that this route's parser never
  // picks off the body is dropped without a word: the request succeeds, the
  // response is a `200`, and the proposal simply keeps the value it had. That is
  // how `explanationMd` sat DECLARED-and-unread here while
  // `lib/mcp/tools/authorPlan.ts` — the door an EXTERNAL agent uses — parsed it,
  // so an outside MCP client could rewrite a landed plan's rationale and Motir's
  // own hosted planner could not.
  //
  // So the samples below are typed `satisfies Record<…Key, unknown>` — TOTAL over
  // the declared constant in both directions, checked by `tsc` — and asserted
  // total again at runtime. A field added to either input with no parser reaching
  // it fails HERE, in the pull request that adds it, rather than being discovered
  // months later by a re-plan that quietly under-delivered. (The compile-time half
  // — the constants against the INTERFACES — is in `lib/dto/plans.ts`; this is the
  // half that was missing, because the interfaces and the parser were each
  // internally consistent and had never been compared.)
  const CONTENT_SAMPLE = {
    title: 'The dependent, corrected',
    kind: 'task',
    descriptionMd: 'The corrected spec.',
    type: 'code',
    priority: 'high',
    storyPoints: 3,
    estimateMinutes: 45,
    explanationMd: 'The corrected WHY — the key this route never read.',
    executor: 'human',
    // The card's proposed STEPS (MOTIR-4616). Present here because the
    // compile-time half of the guard REQUIRES it — `UPDATE_PROPOSAL_KEYS` gained
    // `todos` with the interface, and this object `satisfies` that key set — and
    // because the runtime half is exactly the assertion this story owes: the
    // internal correction route's parser has to carry the key through into
    // `proposedFields`, which is the door MOTIR-4619 opens.
    todos: [{ text: 'Create the restricted API key', executor: 'human' }],
  } satisfies Record<UpdateProposalKey, unknown>;

  /** Each STRUCTURAL key → where the correction lands it, or `null` for a key
   *  this test does not exercise (with the reason, by name). */
  const STRUCTURAL_LANDS_IN: Record<
    Exclude<CorrectProposalKey, UpdateProposalKey>,
    string | null
  > = {
    parentRef: 'planItem.parentRef',
    blockedByRefs: 'planItem.blockedByRefs',
    targetRepo: 'proposedFields.targetRepo',
    targetRepoRole: 'proposedFields.targetRepoRole',
    // `modify` ONLY, and mutually exclusive with an `add`'s content bag — the
    // service refuses the two together by design. Its own transport (the
    // `modifyPatch` rename) is asserted by the `a modify's patch rides
    // modifyPatch` test above.
    patch: null,
  };

  it('every key `UpdateProposalInput` declares SURVIVES from the request body into the proposal (MOTIR-3865)', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId, secondId } = await plannedPlan(fx, 'job-keys');
    expect(Object.keys(CONTENT_SAMPLE).sort()).toEqual([...UPDATE_PROPOSAL_KEYS].sort());
    expect(Object.keys(STRUCTURAL_LANDS_IN).sort()).toEqual(
      [...CORRECT_PROPOSAL_KEYS].filter((k) => !UPDATE_PROPOSAL_KEYS.includes(k as never)).sort(),
    );

    const res = await patch(fx, secondId, {
      jobId: 'job-keys',
      mode: 'correct',
      patch: CONTENT_SAMPLE,
      parentRef: `planItem:${firstId}`,
      blockedByRefs: [`planItem:${firstId}`],
      // A ROLE needs no repository to exist — the closed vocabulary is exactly
      // what makes it pinnable this early, and it is the pin an ONBOARDING plan
      // carries.
      targetRepoRole: 'api',
    });
    expect(res.status).toBe(200);

    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } });
    expect(stored.proposedFields).toMatchObject({ ...CONTENT_SAMPLE, targetRepoRole: 'api' });
    expect(stored.parentRef).toBe(`planItem:${firstId}`);
    expect(stored.blockedByRefs).toEqual([`planItem:${firstId}`]);
  });

  it('`explanationMd` reaches the proposal on the DEEPEN mode too, not only on `correct`', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await generatingPlan(fx, 'job-deepen');

    // No `mode` — the generation-time deepen seam, which is where a titles-first
    // proposal gains its body. One parser serves both modes, so the key has to
    // land on both or the deepen turn keeps writing a description with no WHY.
    const res = await patch(fx, itemId, {
      jobId: 'job-deepen',
      patch: {
        descriptionMd: 'The body.',
        explanationMd: 'And the WHY beside it.',
        type: 'code',
        executor: 'coding_agent',
      },
    });
    expect(res.status).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields,
    ).toMatchObject({
      descriptionMd: 'The body.',
      explanationMd: 'And the WHY beside it.',
      type: 'code',
      executor: 'coding_agent',
    });
  });

  it('`targetRepoRole` is SPARSE — an explicit `null` unpins, an absent key leaves the pin alone', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Pinned', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Pinned to a role', kind: 'task', targetRepoRole: 'web' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-role' } });
    const itemId = appended.items[0]!.id;

    // ABSENT — a correction that touches something else must not disturb the pin.
    // Collapsing "absent" and "null" is the bug this shape exists to avoid.
    expect(
      (await patch(fx, itemId, { jobId: 'job-role', mode: 'correct', patch: { title: 'Renamed' } }))
        .status,
    ).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields,
    ).toMatchObject({ targetRepoRole: 'web' });

    // EXPLICIT `null` — the unpin, which is unsayable if the two collapse.
    expect(
      (await patch(fx, itemId, { jobId: 'job-role', mode: 'correct', targetRepoRole: null }))
        .status,
    ).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields,
    ).toMatchObject({ targetRepoRole: null });
  });

  it('an UNKNOWN `targetRepoRole` is a typed 422, never a 500 — the same refusal the append gives', async () => {
    const fx = await makeWorkItemFixture();
    const { secondId } = await plannedPlan(fx, 'job-badrole');

    const res = await patch(fx, secondId, {
      jobId: 'job-badrole',
      mode: 'correct',
      targetRepoRole: 'backend',
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE' });
    // …and NOTHING was written: the role is validated before the update, so a
    // refused correction leaves the proposal exactly as it was.
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } })).proposedFields,
    ).not.toHaveProperty('targetRepoRole');
  });
});

describe('DELETE — the withdraw verb', () => {
  it('takes a proposal off the plan and reports what remains', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await plannedPlan(fx, 'job-5');

    const res = await del(fx, secondId, 'job-5');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ planId, itemCount: 1 });
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('REFUSES a withdraw a sibling still references, naming the referrers', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId, secondId } = await plannedPlan(fx, 'job-6');
    // Wire the dependent at the prerequisite, then try to remove the prerequisite.
    expect(
      (
        await patch(fx, secondId, {
          jobId: 'job-6',
          mode: 'correct',
          blockedByRefs: [`planItem:${firstId}`],
        })
      ).status,
    ).toBe(200);

    const res = await del(fx, firstId, 'job-6');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('PLAN_PROPOSAL_REFERENCED');
    expect(body.error).toContain(secondId);
  });

  it('requires a `jobId`, and cannot reach another job’s plan', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId } = await plannedPlan(fx, 'job-7');

    const req = new Request(`http://core/api/internal/ai/plan-proposals/${firstId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SERVICE_SECRET}` },
    });
    req.headers.set('x-motir-job-token', tokenFor(fx));
    expect((await itemDELETE(req, { params: Promise.resolve({ itemId: firstId }) })).status).toBe(
      400,
    );

    expect((await del(fx, firstId, 'job-nobody')).status).toBe(404);
  });
});

describe('GET — reading what the plan currently PROPOSES', () => {
  function read(fx: WorkItemFixture, jobId: string): Promise<Response> {
    const req = new Request(
      `http://core/api/internal/ai/plan-proposals?jobId=${encodeURIComponent(jobId)}`,
      { headers: { authorization: `Bearer ${SERVICE_SECRET}` } },
    );
    req.headers.set('x-motir-job-token', tokenFor(fx));
    return proposalsGET(req);
  }

  it('answers with the plan’s OWN proposals — the read every other internal seam cannot make', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx, 'job-read');

    const res = await read(fx, 'job-read');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; items: { id: string; op: string }[] };
    expect(body.id).toBe(planId);
    // Proposals, not work items: this is what a revising pass seeds its registry
    // from, and it is empty in every committed-tree read.
    expect(body.items).toHaveLength(2);
    expect(body.items.every((i) => i.op === 'add')).toBe(true);
  });

  it('cannot read a plan that is not its job’s', async () => {
    const fx = await makeWorkItemFixture();
    await plannedPlan(fx, 'job-read-2');
    expect((await read(fx, 'job-somebody-else')).status).toBe(404);
  });

  it('requires a `jobId`', async () => {
    const fx = await makeWorkItemFixture();
    const req = new Request('http://core/api/internal/ai/plan-proposals', {
      headers: { authorization: `Bearer ${SERVICE_SECRET}` },
    });
    req.headers.set('x-motir-job-token', tokenFor(fx));
    expect((await proposalsGET(req)).status).toBe(400);
  });
});

describe('POST — the REVISION pass', () => {
  it('APPENDS to a `planned` plan when it declares itself a revision, and `final` RELEASES', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx, 'job-8');
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    const res = await append(fx, {
      jobId: 'job-8',
      revision: true,
      actor: { harness: 'Motir AI', model: 'claude-opus-5' },
      proposals: [{ op: 'add', proposedFields: { title: 'The split half', kind: 'task' } }],
      final: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ planId, planned: false, released: true });

    // The plan is still `planned` — a revision does not open one and does not
    // close one — and it is decidable again.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(3);
    const rows = await adminDb.planRevision.findMany({
      where: { planId },
      orderBy: { changedAt: 'asc' },
    });
    expect(rows.at(-1)).toMatchObject({ changeKind: 'revision_ended', actorHarness: 'Motir AI' });
  });

  it('WITHOUT the flag a `planned` plan still refuses the append', async () => {
    const fx = await makeWorkItemFixture();
    await plannedPlan(fx, 'job-9');
    const res = await append(fx, {
      jobId: 'job-9',
      proposals: [{ op: 'add', proposedFields: { title: 'Sneaked in', kind: 'task' } }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_GENERATING' });
  });
});
