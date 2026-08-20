import { beforeEach, describe, expect, it, vi } from 'vitest';

// motir-ai is the only thing stubbed — it mints the job id a plan and its
// conversation both bind to. Every route, service, Plan row, session row and
// prompt below is real, against real Postgres.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
}));

import { GET as DISPATCH_PROMPT } from '@/app/api/v1/work-items/[key]/dispatch-prompt/route';
import { POST as APPROVE } from '@/app/api/v1/work-items/[key]/plan-approval/route';
import { POST as SESSION_SUBMIT } from '@/app/api/v1/projects/[projectKey]/plan-session/submissions/route';
import { POST as SESSION_TURN } from '@/app/api/v1/projects/[projectKey]/plan-session/turns/route';
import { submitJob } from '@/lib/ai/motirAiClient';
import { DuplicateLinkError } from '@/lib/workItems/linkErrors';
import { activityService } from '@/lib/services/activityService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { findingsPolicyOf } from '../../../packages/cli/src/dispatch';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// THE STORY'S INTEGRATION GATE (MOTIR-3017 · MOTIR-3024) — the seams no single
// card's tests can see, driven end to end against real Postgres.
//
// ── Why the ROUND-TRIP needs its own suite ──────────────────────────────────
// A findings flag crosses four modules: the CLI parses it, `findingsPolicyOf`
// turns it into a query value, the route parses that value, and a pure function
// two layers down renders different text. Each of those has a passing unit test
// on both sides of every seam, and the CHAIN can still be broken: a flag
// threaded to the wrong field produces a request the server accepts and a prompt
// that renders the FULL protocol — which is precisely what an operator who typed
// `--disable-log-bug` will not notice until an agent files something they did
// not want.
//
// So this asserts the PROMPT TEXT, from the CLI's own flag object. The CLI half
// is imported rather than restated: a re-expressed `findingsPolicyOf` here would
// test this file's idea of the vocabulary, which is the one thing that cannot
// drift into a defect.

const BASE = 'http://localhost:3000/api/v1';

/** The prompt an agent would receive for this card, under these CLI flags. */
async function promptUnderFlags(
  caller: V1ProjectCaller,
  key: string,
  flags: Parameters<typeof findingsPolicyOf>[0],
): Promise<{ prompt: string; query: string | null }> {
  const policy = findingsPolicyOf(flags);
  const query = policy === undefined ? '' : `?findingsPolicy=${encodeURIComponent(policy)}`;
  const res = await DISPATCH_PROMPT(
    new Request(`${BASE}/work-items/${key}/dispatch-prompt${query}`, { headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { prompt: string };
  return { prompt: body.prompt, query: policy ?? null };
}

async function makeCard(caller: V1ProjectCaller, title: string) {
  const parent = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title: `${title} (parent)` },
    caller.ctx,
  );
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'subtask', title, parentId: parent.id },
    caller.ctx,
  );
}

const OPERATOR = ['project:browse', 'work_item:edit', 'ai:plan', 'ai:view_plan'] as const;

describe('the findings policy round-trips from a CLI FLAG to the PROMPT TEXT', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('no flags → no parameter, and the COMPLETE protocol', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'ordinary work');

    const { prompt, query } = await promptUnderFlags(caller, card.identifier, {});

    expect(query).toBeNull();
    expect(prompt).toContain('FOUND A DEFECT');
    expect(prompt).toContain('create_work_item');
    expect(prompt).toContain('motir plan --detach');
  });

  it('--disable-log-bug → the bug branch is GONE from the text an agent receives', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'no filing please');

    const { prompt, query } = await promptUnderFlags(caller, card.identifier, {
      disableLogBug: true,
    });

    expect(query).toBe('log-bug');
    expect(prompt).not.toContain('create_work_item');
    expect(prompt).toContain('Comment the finding on');
    // The other capability is untouched — a switch that took both would pass a
    // one-sided assertion.
    expect(prompt).toContain('motir plan --detach');
  });

  it('--disable-replan → no submit step, and the card is left In Progress', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'no replanning please');

    const { prompt, query } = await promptUnderFlags(caller, card.identifier, {
      disableReplan: true,
    });

    expect(query).toBe('replan');
    expect(prompt).not.toContain('motir plan --detach');
    expect(prompt).toContain('leave the card In Progress');
    expect(prompt).toContain('create_work_item');
  });

  it('both → both branches gone, the FINISHED branch whole', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'a quiet run');

    const { prompt, query } = await promptUnderFlags(caller, card.identifier, {
      disableLogBug: true,
      disableReplan: true,
    });

    expect(query).toBe('log-bug,replan');
    expect(prompt).not.toContain('create_work_item');
    expect(prompt).not.toContain('motir plan --detach');
    expect(prompt).toContain('FINISHED — the work is done');
    expect(prompt).toContain('status implemented');
  });

  it('the --no-* ALIASES round-trip to byte-identical PROMPTS', async () => {
    // The seam a unit test on either side cannot see: commander's negated
    // boolean is a different attribute, so this is the assertion that the two
    // spellings reach the same agent with the same words.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'either spelling');

    const viaDisable = await promptUnderFlags(caller, card.identifier, {
      disableLogBug: true,
      disableReplan: true,
    });
    const viaAlias = await promptUnderFlags(caller, card.identifier, {
      logBug: false,
      replan: false,
    });

    expect(viaAlias.query).toBe(viaDisable.query);
    expect(viaAlias.prompt).toBe(viaDisable.prompt);
  });

  it('DEFAULT TOTALITY: no flags renders BYTE-IDENTICALLY to an all-permitted policy', async () => {
    // The property this story most has to preserve. Someone who passes no flags,
    // or reads `motir run --print` to learn the contract, must see the whole
    // protocol — and "omitted means full" has to be ONE decision, not two
    // implementations that agree today.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'the default');

    const omitted = await promptUnderFlags(caller, card.identifier, {});
    const res = await DISPATCH_PROMPT(
      new Request(`${BASE}/work-items/${card.identifier}/dispatch-prompt?findingsPolicy=`, {
        headers: caller.headers,
      }),
      { params: Promise.resolve({ key: card.identifier }) },
    );
    const empty = (await res.json()) as { prompt: string };

    expect(empty.prompt).toBe(omitted.prompt);
  });

  it('THE PROMPT STAYS PURE: same card, same policy, identical bytes across calls', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'twice');

    const first = await promptUnderFlags(caller, card.identifier, { disableLogBug: true });
    const second = await promptUnderFlags(caller, card.identifier, { disableLogBug: true });

    expect(second.prompt).toBe(first.prompt);
    // …and a DIFFERENT policy differs, so the equality above is not vacuous.
    const other = await promptUnderFlags(caller, card.identifier, { disableReplan: true });
    expect(other.prompt).not.toBe(first.prompt);
  });

  it('an unrecognised capability is REFUSED, not rendered as the full protocol', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'a typo');

    const res = await DISPATCH_PROMPT(
      new Request(
        `${BASE}/work-items/${card.identifier}/dispatch-prompt?findingsPolicy=no-log-bug`,
        { headers: caller.headers },
      ),
      { params: Promise.resolve({ key: card.identifier }) },
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_FINDINGS_POLICY');
  });
});

describe('the bug an agent files lands as a REAL row, wired the way the prompt says', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('is parented under the in-flight card’s PARENT and related back to the card', async () => {
    // The prompt names a concrete `parentKey`; this asserts the rule that key
    // comes from, against the shipped service an agent's `create_work_item`
    // reaches — so a prompt that named the wrong parent would be caught by the
    // shape of what lands, not by re-reading the text.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'the card in flight');
    const detail = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      card.identifier,
      caller.ctx,
    );
    const parentKey = detail.ancestors.at(-1)?.identifier ?? card.identifier;

    // Exactly what the prompt instructs, through the shipped service.
    const bug = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'bug',
        title: 'the defect it found elsewhere',
        parentId: detail.item.parentId,
        descriptionMd: [
          '## Reproduction',
          'Drive /ready with no sprint.',
          '## Evidence',
          '`pnpm vitest run tests/x.test.ts` → 1 failed',
          `## Seen on`,
          `${card.identifier}, branch subtask/${card.identifier}-x`,
        ].join('\n'),
      },
      caller.ctx,
    );
    // ⚠️ THE EDGE IS ALREADY THERE, and finding that out is worth more than the
    // assertion it replaced. The description NAMES the card (the prompt requires
    // it — "WHERE IT WAS SEEN"), and `createWorkItem` auto-relates a mention, so
    // the `relates_to` the prompt tells the agent to create in step 4 exists
    // before that step runs. The service throws `DuplicateLinkError` on a second
    // one; the MCP tool an agent actually calls CATCHES it and answers a success
    // no-op, so a dispatched agent following the prompt literally is fine — and
    // the prompt now says so, rather than leaving it to be discovered.
    await expect(
      workItemsService.linkWorkItems(
        { fromId: bug.id, toId: card.id, kind: 'relates_to' },
        caller.ctx,
      ),
    ).rejects.toThrow(DuplicateLinkError);

    const filed = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      bug.identifier,
      caller.ctx,
    );
    expect(filed.item.kind).toBe('bug');
    expect(filed.ancestors.at(-1)?.identifier).toBe(parentKey);
    expect(filed.relatesTo.map((l) => l.item.identifier)).toContain(card.identifier);
    // ⚠️ IT BLOCKS NOTHING. Filing is purely additive — that is what makes it
    // safe for an unattended run to do at all, and a bug that acquired a
    // `blocked_by` edge would hold up work nobody scheduled.
    expect(filed.blockedBy).toEqual([]);
    expect(filed.item.sprintId).toBeNull();
  });

  it('filing does NOT change the in-flight card’s own outcome', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const card = await makeCard(caller, 'finishes anyway');
    await workItemsService.updateStatus(card.id, 'in_progress', caller.ctx);

    await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'bug', title: 'something else', parentId: null },
      caller.ctx,
    );
    await workItemsService.updateStatus(card.id, 'implemented', caller.ctx);

    const after = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      card.identifier,
      caller.ctx,
    );
    expect(after.item.status).toBe('implemented');
  });
});

describe('the approval BOUNDS hold from the outside', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  /** The shape a refused run leaves behind: an anchored conversation, submitted,
   *  with a `planned` plan carrying one proposal. */
  async function refusedCardWithPlan(caller: V1ProjectCaller, opts: { anchored?: boolean } = {}) {
    const card = await makeCard(caller, 'its premise is false');
    vi.mocked(submitJob).mockResolvedValue({ jobId: `job_${card.identifier}` } as Awaited<
      ReturnType<typeof submitJob>
    >);
    const args = { params: Promise.resolve({ projectKey: caller.projectKey }) };
    const targetKeys = opts.anchored === false ? [] : [card.identifier];
    const req = (suffix: string, body: unknown) =>
      new Request(`${BASE}/projects/${caller.projectKey}/plan-session${suffix}`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    await SESSION_TURN(req('/turns', { body: 'it cannot be built', targetKeys }), args);
    const submitted = await SESSION_SUBMIT(req('/submissions', { targetKeys }), args);
    const { planId } = (await submitted.json()) as { planId: string };
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'the corrected card', kind: 'task' } }],
      caller.ctx,
    );
    await plansService.markPlanned(planId, caller.ctx);
    return { key: card.identifier, planId };
  }

  function approve(caller: V1ProjectCaller, key: string): Promise<Response> {
    return APPROVE(
      new Request(`${BASE}/work-items/${key}/plan-approval`, {
        method: 'POST',
        headers: caller.headers,
      }),
      { params: Promise.resolve({ key }) },
    );
  }

  it('refuse → submit → approve: the proposals become REAL ROWS', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    const before = await workItemsService.countProjectWorkItems(
      caller.fixture.projectId,
      {},
      caller.ctx,
    );

    expect((await approve(caller, key)).status).toBe(200);

    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('approved');
    const after = await workItemsService.countProjectWorkItems(
      caller.fixture.projectId,
      {},
      caller.ctx,
    );
    // A proposal became a row — counted, not inferred from the response.
    expect(after).toBe(before + 1);
  });

  it('CROSS-TENANT: a token cannot approve another workspace’s plan', async () => {
    // ⚠️ A DISTINCT project prefix, and it is load-bearing: both fixtures
    // default to `PROD`, so the other tenant's key would RESOLVE inside this one
    // — to a different card sharing the number — and the test would assert a
    // refusal it never made.
    const mine = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const theirs = await createV1ProjectCaller({
      permissions: [...OPERATOR],
      workspaceName: 'another tenant',
      identifier: 'ACME',
    });
    const { key, planId } = await refusedCardWithPlan(theirs);

    const foreign = await approve(mine, key);
    const unknown = await approve(mine, 'ACME-9999');

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(((await foreign.json()) as { code: string }).code).toBe(
      ((await unknown.json()) as { code: string }).code,
    );
    expect((await plansService.getPlan(planId, theirs.ctx)).status).toBe('planned');
  });

  it('the ANCHOR bound: a plan from the project-wide thread is not approvable', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller, { anchored: false });

    expect((await approve(caller, key)).status).toBe(422);

    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('planned');
  });

  it('NO RAW WRITES: every card the flow creates or moves records a revision', async () => {
    // The shipped services are what write revisions, so a path that reached
    // Prisma directly would leave a row with no history — invisible in the
    // result and fatal to the activity stream.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    expect((await approve(caller, key)).status).toBe(200);

    const plan = await plansService.getPlan(planId, caller.ctx);
    const materializedId = plan.items[0]?.workItemId;
    expect(materializedId, 'the proposal materialized into a row').toBeTruthy();

    const history = await activityService.listHistory(materializedId!, {}, caller.ctx);
    expect(history.entries.length).toBeGreaterThan(0);
  });
});
