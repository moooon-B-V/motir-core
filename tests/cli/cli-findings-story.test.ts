import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import {
  makeCliWorkspace,
  writeFakeAgent,
  type CliWorkspace,
  type FakeAgent,
} from '../helpers/cliHarness';
import { randomToken } from '../helpers/random';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';

// motir-ai is the only thing stubbed — it mints the job id a plan and its
// conversation bind to. Everything else is real.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(async () => ({ jobId: `job_${randomToken(8)}` })),
}));

// STORY-CLOSING suite for MOTIR-3017 — what a run does when it finds trouble
// (Subtask MOTIR-3025).
//
//   built `motir` binary ──HTTP──▶ the real /api/v1 routes ──▶ real Postgres
//          └─ spawns ──▶ a scripted FAKE AGENT that reads $MOTIR_PROMPT_FILE and
//                        does what the PROMPT says: the key, the status, the
//                        `motir plan --detach` line and the bug's parentKey are
//                        all read OUT of the prompt, never supplied by this file
//
// ⚠️ THAT LAST CLAUSE IS THE WHOLE DESIGN. Every assertion below is therefore
// evidence about the PROMPT the server assembled, not about the fixture: an
// agent handed a `--disable-log-bug` prompt finds no `parentKey:` line and files
// nothing, and one handed `--disable-replan` finds no `status planning` step and
// leaves the card In Progress. A fixture that was told what to do per flag would
// prove only that the test knows the flags.
//
// `packages/cli/test/**` proves each module with the client and the launcher
// injected; `tests/integration/run-findings/` proves the server seams and the
// round-trip. Neither proves that a person typing `motir run --disable-log-bug`
// ends up with an agent that does not file — which is the story.
//
// ── THE LANE, and why this is NOT a Playwright spec ─────────────────────────
// The acceptance RECEIPT for this story is `tests/e2e/acceptance-run-findings.spec.ts`,
// which films the surfaces a reviewer decides on: a card sitting in Planning
// with its evidence, a filed bug, and a tree that changed itself. What CANNOT be
// filmed is the half that lives in a terminal — a refused flag's message, an
// exact submit count, a policy that reaches a prompt — and that half is here,
// in the lane that can actually drive the binary. Same split
// `cli-multi-repo-story.test.ts` makes, for the same reason.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

let server: McpTestServer;
let ws: CliWorkspace;
let agent: FakeAgent;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  ws = makeCliWorkspace();
  agent = writeFakeAgent(ws.path('agent'));
});

async function mintToken(fx: WorkItemFixture): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: `cli-${randomToken(6)}`,
    fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
  });
  return token;
}

/** A linked project, plus the env a dispatched agent needs to act as itself. */
async function linkedProject(): Promise<{ fx: WorkItemFixture; agentEnv: Record<string, string> }> {
  const fx = await makeWorkItemFixture();
  const token = await mintToken(fx);
  expect((await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode).toBe(
    0,
  );
  expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);
  // The agent gets its OWN credential, exactly as a sandboxed one does — it is
  // not reading the CLI's config.
  return {
    fx,
    agentEnv: { MOTIR_FAKE_AGENT_SERVER: server.url, MOTIR_FAKE_AGENT_TOKEN: token },
  };
}

/** A story with one dispatchable child — the shape a run actually meets. */
async function card(fx: WorkItemFixture, title: string) {
  const parent = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: `${title} (parent)` },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title, parentId: parent.id, type: 'code' },
    fx.ctx,
  );
  return { parent, item };
}

async function statusOf(fx: WorkItemFixture, key: string): Promise<string> {
  const detail = await workItemsService.getIssueDetail(fx.projectId, key, fx.ctx);
  return detail.item.status;
}

async function bugsIn(fx: WorkItemFixture) {
  const rows = await adminDb.workItem.findMany({
    where: { projectId: fx.projectId, kind: 'bug', archivedAt: null },
  });
  return rows;
}

async function plansIn(fx: WorkItemFixture) {
  return adminDb.plan.findMany({ where: { projectId: fx.projectId } });
}

/** How many comments the agent left on a card — the finding, on the record. */
async function commentsOn(fx: WorkItemFixture, workItemId: string): Promise<number> {
  return adminDb.comment.count({ where: { workItemId } });
}

describe('a run whose agent REFUSES the card', () => {
  it('leaves it in Planning with the finding on it, and reports a correct outcome', async () => {
    const { fx, agentEnv } = await linkedProject();
    const { item } = await card(fx, 'its premise is false');
    agent.script([
      { refuseCard: { finding: 'The route it names does not exist on origin/main.' } },
    ]);

    const run = await ws.run(['run', item.identifier, '--agent', agent.command], {
      env: agentEnv,
    });

    // A correctly-refused card is a correct outcome, not a failed run.
    expect(run.exitCode, run.stderr).toBe(0);
    expect(await statusOf(fx, item.identifier)).toBe('planning');
    expect(run.stderr).toContain('submitted a re-plan');
    expect(run.stderr).toContain('not a failure');
    // The evidence is ON the card, where a person reading it will meet it.
    expect(await commentsOn(fx, item.id), run.stderr).toBeGreaterThan(0);
    // …and a plan is waiting.
    expect(await plansIn(fx)).toHaveLength(1);
  });

  it('`motir auto` STOPS on it rather than picking up other work', async () => {
    const { fx, agentEnv } = await linkedProject();
    const first = await card(fx, 'the wrong one');
    const second = await card(fx, 'a perfectly good one');
    agent.script([{ refuseCard: { finding: 'Its precondition never shipped.' } }]);

    const run = await ws.run(['auto', '--agent', agent.command, '--max', '5'], { env: agentEnv });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('refused its card and submitted a re-plan');
    // The loop stopped: exactly one card was dispatched.
    expect(agent.invocations()).toHaveLength(1);
    expect(await statusOf(fx, second.item.identifier)).toBe('todo');
    void first;
  });
});

describe('a run whose agent FILES A BUG', () => {
  it('files it under the card’s PARENT, and the card still reaches its own outcome', async () => {
    const { fx, agentEnv } = await linkedProject();
    const { parent, item } = await card(fx, 'finishes anyway');
    agent.script([{ fileBug: { title: 'The empty state renders twice' } }]);

    const run = await ws.run(['run', item.identifier, '--agent', agent.command], {
      env: agentEnv,
    });

    expect(run.exitCode).toBe(0);
    const bugs = await bugsIn(fx);
    expect(bugs).toHaveLength(1);
    // The parent the PROMPT named — this card's own parent.
    expect(bugs[0]?.parentId).toBe(parent.id);
    // It carries what the prompt required.
    expect(bugs[0]?.descriptionMd).toContain('Reproduction');
    expect(bugs[0]?.descriptionMd).toContain('Evidence');
    expect(bugs[0]?.descriptionMd).toContain(item.identifier);
    // ⚠️ FILING CHANGED NOTHING ABOUT THE CARD'S OWN RESULT. It blocks nothing
    // and joins no sprint, which is what makes it safe mid-run.
    expect(bugs[0]?.sprintId).toBeNull();
    const filed = await workItemsService.getIssueDetail(fx.projectId, bugs[0]!.identifier, fx.ctx);
    expect(filed.blockedBy).toEqual([]);
  });
});

describe('the flags SWITCH THE AGENT OFF, and absence is the assertion', () => {
  it('--disable-log-bug: the agent files NOTHING, because its prompt names no parent', async () => {
    const { fx, agentEnv } = await linkedProject();
    const { item } = await card(fx, 'no filing please');
    agent.script([{ fileBug: { title: 'would have been filed' } }]);

    const run = await ws.run(
      ['run', item.identifier, '--agent', agent.command, '--disable-log-bug'],
      { env: agentEnv },
    );

    expect(run.exitCode).toBe(0);
    // ⚠️ THE ABSENCE, in the product. A disabled policy that quietly still fires
    // is the failure this story would most regret, and it is invisible in a log.
    expect(await bugsIn(fx)).toHaveLength(0);
    // The run SAYS which policy it used, so a quiet result is legible.
    expect(run.stderr).toContain('bug filing DISABLED');
  });

  it('--disable-replan: the card stays In Progress and NO plan is submitted', async () => {
    const { fx, agentEnv } = await linkedProject();
    const { item } = await card(fx, 'no replanning please');
    agent.script([{ refuseCard: { finding: 'Its precondition never shipped.' } }]);

    const run = await ws.run(
      ['run', item.identifier, '--agent', agent.command, '--disable-replan'],
      { env: agentEnv },
    );

    expect(run.exitCode).toBe(0);
    // The comment still lands — a disabled policy was never asking the agent to
    // forget what it saw.
    expect(await commentsOn(fx, item.id)).toBeGreaterThan(0);
    // But nothing was parked and nothing was submitted.
    expect(await statusOf(fx, item.identifier)).not.toBe('planning');
    expect(await plansIn(fx)).toHaveLength(0);
    expect(run.stderr).toContain('re-planning DISABLED');
  });

  it('the --no-* alias does exactly what its --disable-* form does', async () => {
    const { fx, agentEnv } = await linkedProject();
    const { item } = await card(fx, 'the house spelling');
    agent.script([{ fileBug: { title: 'would have been filed' } }]);

    const run = await ws.run(['run', item.identifier, '--agent', agent.command, '--no-log-bug'], {
      env: agentEnv,
    });

    expect(run.exitCode).toBe(0);
    expect(await bugsIn(fx)).toHaveLength(0);
  });
});

describe('`motir auto --auto-approve-replan`', () => {
  it('WAITS for the planner, then reports precisely what it was waiting for', async () => {
    // ⚠️ THE SHAPE THIS SUITE CAN PROVE, and it is the one the story got wrong
    // first. The agent submits with `--detach` — it must not sit on a planner —
    // and exits within milliseconds, so the loop arrives while motir-ai is still
    // WRITING the plan. There is no motir-ai here (its client is stubbed to mint
    // a job id and nothing more), so the plan stays `generating` forever, which
    // is the pathological end of the same case: the run waits its bounded
    // budget, then says exactly what it was waiting for and stops.
    //
    // The happy continuation — the planner finishes, the approval succeeds, the
    // loop takes the next card — is proven in `packages/cli/test/replanSignal.test.ts`,
    // where the wait is an injectable seam and a scripted server can answer
    // `generating` once and then succeed. Splitting it that way is deliberate: a
    // binary-driven suite cannot make a planner finish, and faking one HERE
    // would be this file pretending to be motir-ai.
    const { fx, agentEnv } = await linkedProject();
    const wrong = await card(fx, 'the wrong one');
    agent.script([{ refuseCard: { finding: 'Its precondition never shipped.' } }]);

    const run = await ws.run(
      // A single attempt's worth of patience: the budget is what is under test,
      // not how long a test is willing to sit.
      ['auto', '--agent', agent.command, '--max', '5', '--auto-approve-replan'],
      { env: { ...agentEnv, MOTIR_APPROVE_ATTEMPTS: '1' } },
    );

    expect(run.exitCode).toBe(0);
    // It TRIED, and it says what stopped it — naming the card and the state.
    expect(run.stderr).toContain(wrong.item.identifier);
    expect(run.stderr).toContain('could NOT be approved');
    expect(run.stderr).toContain('generating');
    // And it did NOT continue against a tree nobody approved.
    expect(run.stderr).toContain('Stopping rather than continuing');
    const plans = await plansIn(fx);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.status).toBe('generating');
  });

  it('dispatches a card that refuses itself ONCE, however long the run is', async () => {
    // ⚠️ THE GUARD THAT COSTS MONEY. Approve → ready again → dispatched again →
    // refused again → another submit, and every submit spends the token owner's
    // AI credits. The agent here ALWAYS refuses, so a missing hold-out is an
    // unbounded loop rather than one extra turn — asserted as a COUNT, because a
    // run that took it twice looks identical in the final state.
    const { fx, agentEnv } = await linkedProject();
    await card(fx, 'refuses itself forever');
    agent.script([{ refuseCard: { finding: 'Still false.' } }]);

    const run = await ws.run(
      ['auto', '--agent', agent.command, '--max', '10', '--auto-approve-replan'],
      { env: agentEnv },
    );

    expect(run.exitCode).toBe(0);
    expect(agent.invocations()).toHaveLength(1);
    expect(await plansIn(fx)).toHaveLength(1);
  });

  it('is REFUSED by `motir run`, with the guard’s own message and no approval', async () => {
    const { fx, agentEnv } = await linkedProject();
    const { item } = await card(fx, 'not here');

    const run = await ws.run(
      ['run', item.identifier, '--agent', agent.command, '--auto-approve-replan'],
      { env: agentEnv },
    );

    expect(run.exitCode).not.toBe(0);
    // The guard's sentence, never commander's bare `unknown option`.
    expect(run.stderr).toContain('`motir auto` flag');
    expect(run.stderr).not.toContain('unknown option');
    // Nothing ran and nothing was approved.
    expect(agent.invocations()).toHaveLength(0);
    expect(await plansIn(fx)).toHaveLength(0);
  });

  it('is REFUSED alongside --disable-replan, naming the spelling that was typed', async () => {
    const { fx, agentEnv } = await linkedProject();
    await card(fx, 'contradiction');

    const run = await ws.run(
      ['auto', '--agent', agent.command, '--auto-approve-replan', '--no-replan'],
      { env: agentEnv },
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('contradict each other');
    expect(run.stderr).toContain('--no-replan');
    expect(agent.invocations()).toHaveLength(0);
  });
});

describe('the approval BOUND holds from the terminal', () => {
  it('a plan the card did not produce is not reachable from a run at all', async () => {
    // The bound is structural: the CLI addresses the CARD, so there is no
    // argument through which a run could name another plan. This asserts the
    // consequence — a plan submitted from the PROJECT-WIDE thread is left alone
    // by a run that approves everything it can.
    const { fx, agentEnv } = await linkedProject();
    const { item } = await card(fx, 'has its own plan');

    // A project-wide plan, submitted by somebody else, sitting in review.
    const other = await plansService.createPlan(
      fx.projectId,
      { title: 'somebody else’s plan', summary: null },
      fx.ctx,
    );
    await plansService.addProposals(
      other.id,
      [{ op: 'add', proposedFields: { title: 'not this run’s business', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(other.id, fx.ctx);

    agent.script([{ refuseCard: { finding: 'Its precondition never shipped.' } }]);
    await ws.run(['run', item.identifier, '--agent', agent.command], { env: agentEnv });

    // The run's own plan exists; the stranger's is untouched and still awaiting
    // a human.
    const after = await plansService.getPlan(other.id, fx.ctx);
    expect(after.status).toBe('planned');
  });
});
