import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { dispatchRunOpenedSchema } from '@/lib/api/v1/workLoop/schema';
import { buildMcpServer } from '@/lib/mcp/registry';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { usersService } from '@/lib/services/usersService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// STORY MOTIR-7446's INTEGRATION GATE (MOTIR-7452) — an agent reporting its OWN
// run of a card, assembled end to end against a real Postgres:
//
//   MCP client → transport → strict input → the PERMISSION gate → the every-call
//   heartbeat → `start_work_item_run` / `report_action` / `close_work_item_run` →
//   `dispatchRunService` → repositories → the database.
//
// The unit tiers each prove one layer (`tests/dispatchRunAgentReported.test.ts`
// the service, `tests/mcp/workItemRunTool.test.ts` the door); this file proves
// the ASSEMBLY, case by case as the card enumerates them, and reads every
// answer back from the rows. A v1 run is opened through the real route with a
// real bearer PAT, the door `motir run` uses, so "inside a CLI run" is the CLI's
// own run and not a service-level imitation of one.
//
// The terms are `docs/decisions/agent-reported-runs.md`.
//
// COVERAGE FLOOR (≥ 90% lines on the story's new code), measured with this file,
// `tests/mcp/workItemRunTool.test.ts` and `tests/dispatchRunAgentReported.test.ts`
// under `--coverage` (v8) on 2026-10-03:
//   · `dispatchRunService` — `openAgentRun` … `closeAgentRun`: 127 / 129 lines, 98.4%.
//     The two misses are the close that loses its race to the reap between the
//     read and the lock, which answers as a second close does.
//   · `lib/mcp/tools/workItemRun.ts`: 98.1% lines.
//   · `lib/mcp/runHeartbeat.ts`: 92.9% lines — the miss is the logged, swallowed
//     failure, the arm that never fails the call it rides on.

let caller: V1ProjectCaller;
let fx: WorkItemFixture;
let agentA: Client;

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  fx = caller.fixture;
  agentA = await connect(fx.ctx);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const BASE = 'http://localhost:3000/api/v1';

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...GRANTABLE_PERMISSIONS],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'agent-run-gate', version: '0.0.0' });
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

function errorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return (result.content[0] as { text: string }).text.split(':')[0] as string;
}

async function memberB(): Promise<{ ctx: ServiceContext; mcp: Client }> {
  const user = await usersService.createUser({
    email: `agent-b+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Agent B',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const ctx = { userId: user.id, workspaceId: fx.workspaceId };
  return { ctx, mcp: await connect(ctx) };
}

/** Where `claim_work_item` leaves a card: In Progress, assigned to A. */
async function held(
  title: string,
  extra: { kind?: 'task' | 'story' | 'subtask'; parentId?: string } = {},
): Promise<WorkItem> {
  const item = await createTestWorkItem(fx, {
    kind: extra.kind ?? 'task',
    title,
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
  });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { status: 'in_progress', assigneeId: fx.ownerId },
  });
  return item;
}

interface Started {
  outcome: string;
  runId: string;
  legs: { key: string; title: string | null }[];
}
interface Reported {
  outcome: string;
  runId: string | null;
  accepted: number;
  refused: { kind: string; reason: string }[];
  touched?: number;
}
interface Closed {
  alreadyClosed: boolean;
  status: string;
  stopReason: string;
  stamped: string[];
}

const start = async (key: string, client = agentA) =>
  ok<Started>(
    await call(client, 'start_work_item_run', { key, harness: 'Codex', model: 'gpt-5-codex' }),
  );
const report = (args: Record<string, unknown>, client = agentA) =>
  call(client, 'report_action', args);
const close = async (key: string, runId: string, outcome: string) =>
  ok<Closed>(await call(agentA, 'close_work_item_run', { key, runId, outcome }));

const eventsOf = (runId: string) =>
  adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId: runId }, orderBy: { seq: 'asc' } });
const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });
const cardRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

/** A run opened the way `motir run` opens one: the v1 route, a real PAT. */
async function v1Run(key: string): Promise<string> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/route');
  const res = await POST(
    new Request(`${BASE}/dispatch-runs`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectKey: caller.projectKey,
        command: 'run',
        agent: 'claude',
        cards: [{ key, disposition: 'queued' }],
      }),
    }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(201);
  return dispatchRunOpenedSchema.parse(await res.json()).run.id;
}

describe('a leaf, start to delivered close', () => {
  it('records the run, its steps and milestone in order, and stamps the card', async () => {
    const leaf = await held('a leaf the agent builds');

    const started = await start(leaf.identifier);
    expect(started.outcome).toBe('started');
    ok(await report({ key: leaf.identifier, action: 'Read the card and its context' }));
    ok(
      await report({
        key: leaf.identifier,
        action: 'Check out the branch',
        events: [{ kind: 'checkout_ready', data: { branch: 'subtask/leaf' } }],
      }),
    );
    await setStatus(leaf.id, 'implemented');
    const closed = await close(leaf.identifier, started.runId, 'completed');

    const run = await runRow(started.runId);
    expect(run).toMatchObject({
      reportedBy: 'agent',
      command: 'run',
      origin: 'local',
      agent: 'Codex',
      model: 'gpt-5-codex',
      status: 'succeeded',
      stopReason: 'completed',
    });
    expect(run.startedAt.getTime()).toBeLessThan(run.endedAt!.getTime());
    expect(await adminDb.dispatchRunCard.count({ where: { dispatchRunId: run.id } })).toBe(1);
    // A milestone in the same call is written BEFORE the step it came with.
    expect((await eventsOf(run.id)).map((e) => [e.kind, e.reportedBy])).toEqual([
      ['run_opened', 'agent'],
      ['agent_action', 'agent'],
      ['checkout_ready', 'agent'],
      ['agent_action', 'agent'],
      ['run_closed', 'agent'],
    ]);
    expect(closed.stamped).toEqual([leaf.identifier]);
    expect(await cardRow(leaf.id)).toMatchObject({
      implementationSource: 'byok',
      implementationHarness: 'Codex',
      implementationModel: 'gpt-5-codex',
      status: 'implemented',
    });
  });

  it('a `halted` close records the stop and stamps nothing', async () => {
    const leaf = await held('a leaf the agent gives up on');
    const { runId } = await start(leaf.identifier);

    const closed = await close(leaf.identifier, runId, 'halted');

    expect(closed).toMatchObject({ status: 'failed', stopReason: 'halted', stamped: [] });
    expect((await cardRow(leaf.id)).implementationSource).toBeNull();
  });

  it('a second close writes nothing', async () => {
    const leaf = await held('a leaf closed twice');
    const { runId } = await start(leaf.identifier);
    await close(leaf.identifier, runId, 'interrupted');
    const before = await eventsOf(runId);
    const endedAt = (await runRow(runId)).endedAt;

    const again = await close(leaf.identifier, runId, 'completed');

    expect(again).toMatchObject({ alreadyClosed: true, stopReason: 'interrupted', stamped: [] });
    expect(await eventsOf(runId)).toHaveLength(before.length);
    expect((await runRow(runId)).endedAt).toEqual(endedAt);
  });
});

describe('a parent set — one run over the children A claimed', () => {
  async function story() {
    const parent = await held('a story', { kind: 'story' });
    const first = await held('child one', { kind: 'subtask', parentId: parent.id });
    const second = await held('child two', { kind: 'subtask', parentId: parent.id });
    return { parent, first, second };
  }

  it('opens ONE `run_scope` with two legs in the children’s order', async () => {
    const { parent, first, second } = await story();

    const started = await start(parent.identifier);

    expect(started.legs.map((l) => l.key)).toEqual([first.identifier, second.identifier]);
    const run = await runRow(started.runId);
    expect(run).toMatchObject({ command: 'run_scope', scopeWorkItemId: parent.id });
    expect(await adminDb.dispatchRun.count()).toBe(1);
  });

  it('a delivered close with both children implemented stamps both', async () => {
    const { parent, first, second } = await story();
    const { runId } = await start(parent.identifier);
    await setStatus(first.id, 'implemented');
    await setStatus(second.id, 'implemented');

    const closed = await close(parent.identifier, runId, 'drained');

    expect([...closed.stamped].sort()).toEqual([first.identifier, second.identifier].sort());
  });

  it('with one child implemented, only that one is stamped', async () => {
    const { parent, first, second } = await story();
    const { runId } = await start(parent.identifier);
    await setStatus(first.id, 'implemented');

    const closed = await close(parent.identifier, runId, 'completed');

    expect(closed.stamped).toEqual([first.identifier]);
    expect((await cardRow(second.id)).implementationSource).toBeNull();
  });
});

describe('report_action inside a CLI run', () => {
  it('writes the step on the CLI’s run, which stays `cli`, and refuses milestones there', async () => {
    const leaf = await held('a card `motir run` is running');
    const runId = await v1Run(leaf.identifier);

    const reported = ok<Reported>(
      await report({ key: leaf.identifier, action: 'Run the changed tests' }),
    );
    expect(reported).toMatchObject({ outcome: 'reported', runId, accepted: 1 });
    const step = (await eventsOf(runId)).at(-1)!;
    expect(step).toMatchObject({ kind: 'agent_action', reportedBy: 'agent' });
    expect((await runRow(runId)).reportedBy).toBe('cli');

    expect(
      errorCode(
        await report({ key: leaf.identifier, events: [{ kind: 'checkout_ready', data: {} }] }),
      ),
    ).toBe('AGENT_RUN_EVENT_KIND_NOT_ALLOWED');
  });
});

describe('the refusals', () => {
  it('a report on a card where A has no open run is refused by name', async () => {
    const leaf = await held('a card with no run');
    const answer = ok<Reported>(await report({ key: leaf.identifier, action: 'Read the card' }));
    expect(answer.outcome).toBe('no_open_run');
    expect(await adminDb.dispatchRunEvent.count()).toBe(0);
  });

  it('B cannot start on A’s card; A’s second start is `mine`; B cannot report on it', async () => {
    const leaf = await held('A’s card');
    const b = await memberB();

    const refused = ok<{ outcome: string }>(
      await call(b.mcp, 'start_work_item_run', { key: leaf.identifier, harness: 'Kimi CLI' }),
    );
    expect(refused.outcome).toBe('not_claimed');
    expect(await adminDb.dispatchRun.count()).toBe(0);

    const first = await start(leaf.identifier);
    const second = await start(leaf.identifier);
    expect(second).toMatchObject({ outcome: 'mine', runId: first.runId });

    const bReport = ok<Reported>(
      await report({ key: leaf.identifier, action: 'Sneak a step in' }, b.mcp),
    );
    expect(bReport.outcome).toBe('no_open_run');
    expect(await eventsOf(first.runId)).toHaveLength(1);
  });

  it('a disallowed kind is refused by name while the batch’s allowed events are stored', async () => {
    const leaf = await held('a card with a mixed batch');
    const { runId } = await start(leaf.identifier);

    const answer = ok<Reported>(
      await report({
        key: leaf.identifier,
        events: [
          { kind: 'agent_exited' },
          { kind: 'delivery_linked', data: { url: 'https://example.com/pr/9' } },
        ],
      }),
    );

    expect(answer.refused.map((r) => r.kind)).toEqual(['agent_exited']);
    expect(answer.accepted).toBe(1);
    expect((await eventsOf(runId)).map((e) => e.kind)).toEqual(['run_opened', 'delivery_linked']);
  });

  it('an action over 500 characters is refused', async () => {
    const leaf = await held('a card with a long step');
    const { runId } = await start(leaf.identifier);
    expect(errorCode(await report({ key: leaf.identifier, action: 'y'.repeat(501) }))).toBe(
      'AGENT_RUN_REPORT_INVALID',
    );
    expect(await eventsOf(runId)).toHaveLength(1);
  });
});

describe('liveness', () => {
  async function staleRun(title: string): Promise<string> {
    const leaf = await held(title);
    const { runId } = await start(leaf.identifier);
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { lastHeartbeatAt: new Date(Date.now() - 20 * 60_000) },
    });
    return runId;
  }

  it('`report_action` with no arguments bumps every open run of A’s', async () => {
    const one = await staleRun('one');
    const two = await staleRun('two');
    // Starting `two` was itself a Motir call, which beat `one`: stale both again.
    await adminDb.dispatchRun.updateMany({
      where: { id: { in: [one, two] } },
      data: { lastHeartbeatAt: new Date(Date.now() - 20 * 60_000) },
    });
    const floor = Date.now() - 60_000;

    const beat = ok<Reported>(await report({}));

    expect(beat).toMatchObject({ outcome: 'heartbeat', touched: 2 });
    for (const id of [one, two]) {
      expect((await runRow(id)).lastHeartbeatAt!.getTime()).toBeGreaterThan(floor);
    }
  });

  it('a call to an unrelated Motir tool bumps A’s open run', async () => {
    const runId = await staleRun('three');
    const floor = Date.now() - 60_000;

    ok(await call(agentA, 'list_projects', {}));

    expect((await runRow(runId)).lastHeartbeatAt!.getTime()).toBeGreaterThan(floor);
  });

  it('an agent run silent for 60 minutes is reaped at its last heartbeat; its card keeps its status', async () => {
    const leaf = await held('a card whose agent vanished');
    const { runId } = await start(leaf.identifier);
    const lastHeard = new Date(Date.now() - 61 * 60_000);
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { lastHeartbeatAt: lastHeard },
    });

    await dispatchRunSweepService.reapLapsed();

    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });
    expect(run.endedAt!.getTime()).toBe(lastHeard.getTime());
    expect((await cardRow(leaf.id)).status).toBe('in_progress');
  });

  it('a CLI run is still reaped at 5 minutes, and an agent run at 30 is not', async () => {
    const cliCard = await held('a CLI card');
    const cliRun = await v1Run(cliCard.identifier);
    const agentRun = await staleRun('an agent card');
    await adminDb.dispatchRun.update({
      where: { id: cliRun },
      data: { lastHeartbeatAt: new Date(Date.now() - 6 * 60_000) },
    });
    await adminDb.dispatchRun.update({
      where: { id: agentRun },
      data: { lastHeartbeatAt: new Date(Date.now() - 30 * 60_000) },
    });

    await dispatchRunSweepService.reapLapsed();

    expect((await runRow(cliRun)).stopReason).toBe('abandoned');
    expect((await runRow(agentRun)).status).toBe('running');
  });
});

describe('every other door still writes `cli`', () => {
  it('the v1 ingest and a repair claim open `cli` runs', async () => {
    const leaf = await held('a v1 card');
    const ingest = await v1Run(leaf.identifier);

    const red = await createTestWorkItem(fx, { kind: 'task', title: 'a red card' });
    await setStatus(red.id, 'implemented');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    await deliveredPr(fx, red.id, repo, {
      headRef: 'subtask/red-card',
      baseRef: 'main',
      checks: { Vitest: 'failure' },
    });
    const claim = await workItemRepairService.claimRepair(fx.projectId, red.identifier, fx.ctx);

    expect((await runRow(ingest)).reportedBy).toBe('cli');
    expect(claim.runId).not.toBeNull();
    expect((await runRow(claim.runId!)).reportedBy).toBe('cli');
  });
});
