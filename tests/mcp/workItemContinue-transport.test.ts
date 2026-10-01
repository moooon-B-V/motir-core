import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import type { WorkItemContinueOutcome, WorkItemContinueRefusal } from '@/lib/dto/workItemContinue';
import { buildMcpServer } from '@/lib/mcp/registry';
import { isRunAlive } from '@/lib/runs/runLiveness';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem } from '../fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { withTokenFor } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { setStatus } from '../helpers/repairFixtures';

// Story MOTIR-7261 · MOTIR-7264 — the STORY'S INTEGRATION GATE for the three
// continue tools and `dispatch_prompt`'s `continueFrom`. Every MCP call goes
// through the assembled path an agent meets:
//
//   MCP client → transport → the registry's server (strict input + the per-token
//   PERMISSION gate) → tool → `workItemContinueService` / `dispatchRunService` /
//   `dispatchPromptService` → repositories → a real Postgres.
//
// Every REST call goes through the real route handler with a real bearer PAT —
// the door `motir continue` knocks on. The unit tier
// (`workItemContinueTool.test.ts`) enters at the adapters; this file asserts the
// story's criteria across the SEAM between the two doors onto one lock, and each
// case reads the database back as well as the answers.
//
// It tests the DOOR, not the continue rules: the refusal ORDER is MOTIR-6532's
// matrix (`tests/ready/claimWorkItemContinue.test.ts`); here each outcome and
// reason is seeded twice, once per door, and the two answers must agree.

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const BASE = 'http://localhost:3000/api/v1';
const BRANCH = 'subtask/the-dead-run';

/** Connect an in-memory MCP client to a server bound to `ctx`, every permission. */
async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...GRANTABLE_PERMISSIONS],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'continue-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function ok<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function refusal(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return (result.content[0] as { text: string }).text;
}

interface ClaimOut {
  key: string;
  outcome: WorkItemContinueOutcome;
  reason: WorkItemContinueRefusal | null;
  parentKey: string | null;
  runId: string | null;
  holder: { id: string; name: string } | null;
  deadRun: { id: string } | null;
  branch: string | null;
}
interface RunOut {
  runId: string;
  open: boolean;
  status: string;
  stopReason: string | null;
  lastHeartbeatAt: string | null;
}

interface Caller {
  ctx: ServiceContext;
  mcp: Client;
  headers: Record<string, string>;
}

async function caller(fx: WorkItemFixture, user: User, ctx: ServiceContext): Promise<Caller> {
  const rest = await withTokenFor(user, fx.workspace, {
    projectId: fx.projectId,
    scopes: ['read', 'work_items:write'],
  });
  return { ctx, mcp: await connect(ctx), headers: rest.headers };
}

async function member(fx: WorkItemFixture, name: string): Promise<Caller & { user: User }> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const ctx = { userId: user.id, workspaceId: fx.workspaceId };
  return { user, ...(await caller(fx, user, ctx)) };
}

/** REST: `POST /api/v1/work-items/{key}/continue`, as `motir continue` sends it. */
async function restClaim(key: string, headers: Record<string, string>): Promise<ClaimOut> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/continue/route');
  const res = await POST(
    new Request(`${BASE}/work-items/${encodeURIComponent(key)}/continue`, {
      method: 'POST',
      headers,
    }),
    { params: Promise.resolve({ key }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ClaimOut;
}

/** REST: `GET /api/v1/work-items/{key}/dispatch-prompt?continueFrom=`. */
async function restPrompt(key: string, continueFrom: string, headers: Record<string, string>) {
  const { GET } = await import('@/app/api/v1/work-items/[key]/dispatch-prompt/route');
  return GET(
    new Request(
      `${BASE}/work-items/${key}/dispatch-prompt?continueFrom=${encodeURIComponent(continueFrom)}`,
      { headers },
    ),
    { params: Promise.resolve({ key }) },
  );
}

const mcpClaim = async (c: Caller, key: string) =>
  ok<ClaimOut>(await call(c.mcp, 'claim_work_item_continue', { key }));

/** The door under test: the same claim, through MCP or through REST. */
type Door = 'mcp' | 'rest';
const claimVia = (door: Door, c: Caller, key: string) =>
  door === 'mcp' ? mcpClaim(c, key) : restClaim(key, c.headers);

/** A task whose one local run checked out `branch` and went silent `silentMinutes` ago. */
async function deadCard(
  fx: WorkItemFixture,
  opts: { silentMinutes?: number; branch?: string | null; status?: string } = {},
) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: 'a card whose run died' });
  await setStatus(card.id, opts.status ?? 'in_progress');
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  const branch = opts.branch === undefined ? BRANCH : opts.branch;
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'checkout_ready',
        workItemKey: card.identifier,
        disposition: 'running',
        data: { branch },
      },
    ],
    fx.ctx,
  );
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - (opts.silentMinutes ?? 7) * 60_000) },
  });
  return { card, deadRunId: run.id };
}

/** A dead PARENT run over a story, with this card one of its legs. */
async function deadParentLeg(fx: WorkItemFixture) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
  const child = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'a card whose run died',
    parentId: story.id,
  });
  await setStatus(child.id, 'in_progress');
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run_scope',
      scopeKey: story.identifier,
      cards: [{ key: child.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);
  return { card: child, story };
}

/** Replace what differs only because each door got its own seed — keys, ids,
 *  timestamps — so two answers compare field for field on everything else. */
function normalize(answer: ClaimOut, names: Record<string, string>): unknown {
  let s = JSON.stringify(answer);
  for (const [value, placeholder] of Object.entries(names)) {
    s = s.split(value).join(placeholder);
  }
  return JSON.parse(s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TS>'));
}

const openContinueRuns = (workItemId: string) =>
  adminDb.dispatchRun.findMany({
    where: { command: 'continue', status: 'running', cards: { some: { workItemId } } },
  });
const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

/**
 * One SEED per outcome and per refusal. Typed as a `Record` over the DTO's own
 * unions, so a refusal added to `lib/dto/workItemContinue.ts` without a seed here
 * is a type error — the table cannot silently fall behind the vocabulary.
 *
 * Each seed builds the state on a fresh card and returns who claims it and the
 * strings to normalise; `prime` runs any claims that must come first, through
 * the SAME door.
 */
interface Seeded {
  key: string;
  claimant: Caller;
  names: Record<string, string>;
  prime?: (door: Door) => Promise<void>;
}
type Seed = (fx: WorkItemFixture, owner: Caller, other: Caller) => Promise<Seeded>;

const OUTCOME_SEEDS: Record<Exclude<WorkItemContinueOutcome, 'not_continuable'>, Seed> = {
  claimed: async (fx, owner) => {
    const { card, deadRunId } = await deadCard(fx);
    return { key: card.identifier, claimant: owner, names: { [deadRunId]: '<DEAD>' } };
  },
  mine: async (fx, owner) => {
    const { card, deadRunId } = await deadCard(fx);
    return {
      key: card.identifier,
      claimant: owner,
      names: { [deadRunId]: '<DEAD>' },
      prime: async (door) => void (await claimVia(door, owner, card.identifier)),
    };
  },
  taken: async (fx, owner, other) => {
    const { card, deadRunId } = await deadCard(fx);
    return {
      key: card.identifier,
      claimant: other,
      names: { [deadRunId]: '<DEAD>' },
      prime: async (door) => void (await claimVia(door, owner, card.identifier)),
    };
  },
};

const REFUSAL_SEEDS: Record<WorkItemContinueRefusal, Seed> = {
  run_alive: async (fx, _owner, other) => {
    const { card, deadRunId } = await deadCard(fx, { silentMinutes: 1 });
    return { key: card.identifier, claimant: other, names: { [deadRunId]: '<DEAD>' } };
  },
  use_fix: async (fx, owner) => {
    const { card } = await deadCard(fx, { status: 'implemented' });
    return { key: card.identifier, claimant: owner, names: {} };
  },
  not_in_progress: async (fx, owner) => {
    const { card } = await deadCard(fx, { status: 'todo' });
    return { key: card.identifier, claimant: owner, names: {} };
  },
  continue_the_parent: async (fx, owner) => {
    const { card, story } = await deadParentLeg(fx);
    return { key: card.identifier, claimant: owner, names: { [story.identifier]: '<PARENT>' } };
  },
  no_dead_run: async (fx, owner) => {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'a card whose run died' });
    await setStatus(card.id, 'in_progress');
    return { key: card.identifier, claimant: owner, names: {} };
  },
  no_branch: async (fx, owner) => {
    const { card } = await deadCard(fx, { branch: null });
    return { key: card.identifier, claimant: owner, names: {} };
  },
};

async function bothDoors(seed: Seed) {
  const fx = await makeWorkItemFixture();
  const owner = await caller(fx, fx.owner, fx.ctx);
  const other = await member(fx, 'Jo Other');
  const answers: Record<Door, ClaimOut> = {} as Record<Door, ClaimOut>;
  const normalized: Record<Door, unknown> = {} as Record<Door, unknown>;
  for (const door of ['mcp', 'rest'] as const) {
    const seeded = await seed(fx, owner, other);
    await seeded.prime?.(door);
    const answer = await claimVia(door, seeded.claimant, seeded.key);
    answers[door] = answer;
    normalized[door] = normalize(answer, {
      ...seeded.names,
      ...(answer.runId ? { [answer.runId]: '<RUN>' } : {}),
      [seeded.key]: '<KEY>',
    });
  }
  return { answers, normalized };
}

describe('1 · parity — the MCP claim answers what the REST claim answers, for every state', () => {
  it.each(Object.keys(OUTCOME_SEEDS) as (keyof typeof OUTCOME_SEEDS)[])('%s', async (outcome) => {
    const { answers, normalized } = await bothDoors(OUTCOME_SEEDS[outcome]);
    expect(answers.mcp.outcome).toBe(outcome);
    expect(Object.keys(answers.mcp).sort()).toEqual(Object.keys(answers.rest).sort());
    expect(normalized.mcp).toEqual(normalized.rest);
  });

  it.each(Object.keys(REFUSAL_SEEDS) as WorkItemContinueRefusal[])(
    'not_continuable × %s',
    async (reason) => {
      const { answers, normalized } = await bothDoors(REFUSAL_SEEDS[reason]);
      expect(answers.mcp).toMatchObject({ outcome: 'not_continuable', reason, runId: null });
      expect(normalized.mcp).toEqual(normalized.rest);
      // A refusal opens nothing, through either door.
      expect(await adminDb.dispatchRun.count({ where: { command: 'continue' } })).toBe(0);
    },
  );
});

describe('2 · one holder across both doors', () => {
  it('an MCP claim makes another member’s REST claim `taken`, naming the MCP caller', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const owner = await caller(fx, fx.owner, fx.ctx);
    const bob = await member(fx, 'Bob Rest');

    const first = await mcpClaim(owner, card.identifier);
    const second = await restClaim(card.identifier, bob.headers);

    expect(first.outcome).toBe('claimed');
    expect(second).toMatchObject({
      outcome: 'taken',
      runId: first.runId,
      holder: { id: fx.ownerId },
    });
    expect(await openContinueRuns(card.id)).toHaveLength(1);
  });

  it('a REST claim makes another member’s MCP claim `taken`; the holder over MCP is `mine`', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const owner = await caller(fx, fx.owner, fx.ctx);
    const bob = await member(fx, 'Bob Agent');

    const first = await restClaim(card.identifier, owner.headers);
    const taken = await call(bob.mcp, 'claim_work_item_continue', { key: card.identifier });
    expect(ok<ClaimOut>(taken)).toMatchObject({
      outcome: 'taken',
      runId: first.runId,
      holder: { id: fx.ownerId },
    });
    expect((taken.content[0] as { text: string }).text).toContain(fx.owner.name);

    expect(await mcpClaim(owner, card.identifier)).toMatchObject({
      outcome: 'mine',
      runId: first.runId,
    });
    expect(await openContinueRuns(card.id)).toHaveLength(1);
  });
});

describe('3 · liveness past the five-minute lapse', () => {
  it('a run touched every minute stays open; an untouched one is reaped abandoned, and its next touch answers open:false', async () => {
    const fx = await makeWorkItemFixture();
    const owner = await caller(fx, fx.owner, fx.ctx);
    const { card: kept } = await deadCard(fx);
    const { card: silent } = await deadCard(fx);
    const keptRun = (await mcpClaim(owner, kept.identifier)).runId!;
    const silentRun = (await mcpClaim(owner, silent.identifier)).runId!;

    // Six minutes pass. The kept run is touched once a minute — each touch after
    // its clock is wound a minute further back — and the silent one never is.
    const start = Date.now() - 6 * 60_000;
    await adminDb.dispatchRun.updateMany({
      where: { id: { in: [keptRun, silentRun] } },
      data: { startedAt: new Date(start), lastHeartbeatAt: new Date(start) },
    });
    for (let minute = 1; minute <= 6; minute++) {
      await adminDb.dispatchRun.update({
        where: { id: keptRun },
        data: { lastHeartbeatAt: new Date(start + (minute - 1) * 60_000) },
      });
      const touched = ok<RunOut>(
        await call(owner.mcp, 'touch_work_item_continue', { key: kept.identifier, runId: keptRun }),
      );
      expect(touched).toMatchObject({ open: true, status: 'running' });
    }

    const now = new Date();
    const silentRow = await runRow(silentRun);
    expect(isRunAlive(await runRow(keptRun), now)).toBe(true);
    expect(isRunAlive(silentRow, now)).toBe(false);

    const summary = await dispatchRunSweepService.reapLapsed(now);
    expect(summary.runsReaped).toBe(1);
    expect(await runRow(keptRun)).toMatchObject({ status: 'running', stopReason: null });
    expect(await runRow(silentRun)).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });

    const reaped = ok<RunOut>(
      await call(owner.mcp, 'touch_work_item_continue', {
        key: silent.identifier,
        runId: silentRun,
      }),
    );
    expect(reaped).toMatchObject({ open: false, status: 'timed_out', stopReason: 'abandoned' });
    expect((await runRow(silentRun)).lastHeartbeatAt).toEqual(silentRow.lastHeartbeatAt);
    expect(await openContinueRuns(silent.id)).toHaveLength(0);
  });
});

describe('4 · ownership', () => {
  it('touch and close with another member’s run, or another item’s, are refused and write nothing', async () => {
    const fx = await makeWorkItemFixture();
    const owner = await caller(fx, fx.owner, fx.ctx);
    const bob = await member(fx, 'Bob Holder');
    const { card } = await deadCard(fx);
    const { card: elsewhere } = await deadCard(fx);
    const bobRun = (await mcpClaim(bob, card.identifier)).runId!;
    const ownRunElsewhere = (await mcpClaim(owner, elsewhere.identifier)).runId!;
    const before = await runRow(bobRun);
    const beforeOwn = await runRow(ownRunElsewhere);

    for (const tool of ['touch_work_item_continue', 'close_work_item_continue'] as const) {
      const args = (runId: string) =>
        tool === 'close_work_item_continue'
          ? { key: card.identifier, runId, outcome: 'completed' }
          : { key: card.identifier, runId };
      expect(refusal(await call(owner.mcp, tool, args(bobRun))), tool).toContain(
        'CONTINUE_RUN_NOT_YOURS',
      );
      expect(refusal(await call(owner.mcp, tool, args(ownRunElsewhere))), tool).toContain(
        'CONTINUE_RUN_NOT_FOUND',
      );
    }
    expect(await runRow(bobRun)).toEqual(before);
    expect(await runRow(ownRunElsewhere)).toEqual(beforeOwn);
  });
});

describe('5 · close', () => {
  it('closes once; a second close answers the first, and a new claim is admitted', async () => {
    const fx = await makeWorkItemFixture();
    const owner = await caller(fx, fx.owner, fx.ctx);
    const { card } = await deadCard(fx);
    const runId = (await mcpClaim(owner, card.identifier)).runId!;

    const closed = ok<RunOut>(
      await call(owner.mcp, 'close_work_item_continue', {
        key: card.identifier,
        runId,
        outcome: 'halted',
      }),
    );
    expect(closed).toMatchObject({ runId, open: false, stopReason: 'halted' });
    const row = await runRow(runId);
    expect(row).toMatchObject({ stopReason: 'halted' });
    expect(row.endedAt).not.toBeNull();

    const again = ok<RunOut>(
      await call(owner.mcp, 'close_work_item_continue', {
        key: card.identifier,
        runId,
        outcome: 'completed',
      }),
    );
    expect(again).toEqual(closed);
    expect(await runRow(runId)).toEqual(row);

    // The closed continue is now the dead run, and a fresh claim takes it over.
    const fresh = await mcpClaim(owner, card.identifier);
    expect(fresh).toMatchObject({ outcome: 'claimed', deadRun: { id: runId } });
    expect(await openContinueRuns(card.id)).toHaveLength(1);
  });
});

describe('6 · the prompt — dispatch_prompt continueFrom equals the REST body', () => {
  it('the same run gives the same prompt through both doors, on the dead run’s branch', async () => {
    const fx = await makeWorkItemFixture();
    const owner = await caller(fx, fx.owner, fx.ctx);
    const { card, deadRunId } = await deadCard(fx);
    await mcpClaim(owner, card.identifier);

    const viaMcp = ok<{ prompt: string; branch: string | null }>(
      await call(owner.mcp, 'dispatch_prompt', { key: card.identifier, continueFrom: deadRunId }),
    );
    const res = await restPrompt(card.identifier, deadRunId, owner.headers);
    expect(res.status).toBe(200);
    const viaRest = (await res.json()) as Record<string, unknown>;

    expect(viaMcp).toEqual(viaRest);
    expect(viaMcp.branch).toBe(BRANCH);
    expect(viaMcp.prompt).toContain(BRANCH);
  });

  it.each([
    ['still running', 'open'],
    ['unknown', 'unknown'],
  ] as const)('a run that is %s is CONTINUE_FROM_INVALID on both doors', async (_label, which) => {
    const fx = await makeWorkItemFixture();
    const owner = await caller(fx, fx.owner, fx.ctx);
    const { card } = await deadCard(fx);
    const openRun = (await mcpClaim(owner, card.identifier)).runId!;
    const runId = which === 'open' ? openRun : `run_${randomToken(8)}`;

    expect(
      refusal(
        await call(owner.mcp, 'dispatch_prompt', { key: card.identifier, continueFrom: runId }),
      ),
    ).toContain('CONTINUE_FROM_INVALID');
    const res = await restPrompt(card.identifier, runId, owner.headers);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('CONTINUE_FROM_INVALID');
  });
});
