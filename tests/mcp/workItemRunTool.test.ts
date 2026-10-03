import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import {
  CLOSE_WORK_ITEM_RUN_TOOL_NAME,
  REPORT_ACTION_TOOL_NAME,
  START_WORK_ITEM_RUN_TOOL_NAME,
} from '@/lib/mcp/tools/workItemRun';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// MOTIR-7451 — the three RUN tools through the assembled MCP server an agent
// meets (in-memory transport → strict input → the per-token PERMISSION gate →
// the every-call heartbeat → tool → `dispatchRunService` → a real Postgres).
// The service's own rules are `tests/dispatchRunAgentReported.test.ts`; this
// file asserts the DOOR: the permission key, the answers' shapes, the refusals
// that are results, the allow-list split, and the heartbeat an unrelated call
// gives a run.
//
// Each case is chosen so the obvious broken adapter fails it:
//
//   1. A token WITHOUT `work_item:edit` is refused on all three, and no run row
//      exists afterwards — a tool mapped to a weaker key would open one.
//   2. A batch with a bad kind stores the good ones — an adapter that passed the
//      batch through whole would lose them all to the service's refusal.
//   3. `get_work_item` moves the run's `lastHeartbeatAt` — a heartbeat wired only
//      into the run tools would leave it where it was.
//   4. A second close answers `alreadyClosed` with the FIRST close's outcome.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const EVERY_PERMISSION = [...GRANTABLE_PERMISSIONS];

/** An in-memory MCP client bound to `ctx`, holding `grant`. */
async function connect(ctx: ServiceContext, grant: string[] = EVERY_PERMISSION): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => grant as typeof EVERY_PERMISSION,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'run-tools', version: '0.0.0' });
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

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

function errorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return text(result).split(':')[0] as string;
}

async function heldLeaf(title = 'a leaf the agent builds'): Promise<WorkItem> {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { status: 'in_progress', assigneeId: fx.ownerId },
  });
  return item;
}

interface StartOut {
  outcome: 'started' | 'mine' | 'not_claimed';
  key: string;
  runId: string | null;
  reportedBy?: string;
  offenderKey?: string;
  legs: { key: string; title: string | null }[];
}
interface ReportOut {
  outcome: 'reported' | 'heartbeat' | 'refused' | 'no_open_run';
  runId: string | null;
  accepted: number;
  refused: { kind: string; reason: string }[];
  touched?: number;
}
interface CloseOut {
  closed: true;
  alreadyClosed: boolean;
  runId: string;
  status: string;
  stopReason: string | null;
  stamped: string[];
}

const RUN_TOOLS = [
  START_WORK_ITEM_RUN_TOOL_NAME,
  REPORT_ACTION_TOOL_NAME,
  CLOSE_WORK_ITEM_RUN_TOOL_NAME,
] as const;

describe('the run tools on the MCP surface', () => {
  it('`tools/list` serves all three, titled and non-read-only, each gated `work_item:edit`', async () => {
    const client = await connect(fx.ctx);
    const { tools } = await client.listTools();
    for (const name of RUN_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.title).toBeTruthy();
      expect(tool!.annotations).toMatchObject({
        readOnlyHint: false,
        // A close is final and overwrites the cards' implementer; the two others add.
        destructiveHint: name === CLOSE_WORK_ITEM_RUN_TOOL_NAME,
      });
      expect(TOOL_PERMISSIONS[name]).toBe('work_item:edit');
      expect(CLI_TOKEN_GRANT).toContain('work_item:edit');
      expect(MCP_TOOL_NAMES).toContain(name);
      expect(Object.keys(EXEMPT_TOOLS)).toContain(name);
    }
  });

  it('a token without `work_item:edit` is refused on all three, and no run is opened', async () => {
    const leaf = await heldLeaf();
    const client = await connect(
      fx.ctx,
      EVERY_PERMISSION.filter((p) => p !== 'work_item:edit'),
    );

    const args: Record<(typeof RUN_TOOLS)[number], Record<string, unknown>> = {
      start_work_item_run: { key: leaf.identifier, harness: 'Codex' },
      report_action: { key: leaf.identifier, action: 'Reading the card' },
      close_work_item_run: { key: leaf.identifier, runId: 'run_x', outcome: 'completed' },
    };
    for (const name of RUN_TOOLS) {
      expect(errorCode(await call(client, name, args[name]))).toBe(PERMISSION_NOT_GRANTED_CODE);
    }
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });
});

describe('start → report → close, by the claim holder', () => {
  it('starts, reports a step and a checkout, and closes `completed`, stamping the card', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);

    const started = ok<StartOut>(
      await call(client, 'start_work_item_run', {
        key: leaf.identifier.toLowerCase(),
        harness: 'Codex',
        model: 'gpt-5-codex',
      }),
    );
    expect(started).toMatchObject({
      outcome: 'started',
      key: leaf.identifier,
      reportedBy: 'agent',
      legs: [{ key: leaf.identifier, title: leaf.title }],
    });
    const runId = started.runId!;

    const reported = ok<ReportOut>(
      await call(client, 'report_action', {
        key: leaf.identifier,
        action: 'Checking out the branch',
        events: [{ kind: 'checkout_ready', data: { branch: 'subtask/leaf' } }],
      }),
    );
    expect(reported).toMatchObject({ outcome: 'reported', runId, accepted: 2, refused: [] });

    await adminDb.workItem.update({ where: { id: leaf.id }, data: { status: 'implemented' } });
    const closed = ok<CloseOut>(
      await call(client, 'close_work_item_run', {
        key: leaf.identifier,
        runId,
        outcome: 'completed',
      }),
    );
    expect(closed).toMatchObject({
      closed: true,
      alreadyClosed: false,
      status: 'succeeded',
      stopReason: 'completed',
      stamped: [leaf.identifier],
    });

    const events = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runId },
      orderBy: { seq: 'asc' },
    });
    expect(events.map((e) => [e.kind, e.reportedBy])).toEqual([
      ['run_opened', 'agent'],
      ['checkout_ready', 'agent'],
      ['agent_action', 'agent'],
    ]);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: leaf.id } });
    expect(card).toMatchObject({
      implementationSource: 'byok',
      implementationHarness: 'Codex',
      implementationModel: 'gpt-5-codex',
    });
  });

  it('a second start answers `mine` with the same run', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);
    const first = ok<StartOut>(
      await call(client, 'start_work_item_run', { key: leaf.identifier, harness: 'Kimi CLI' }),
    );
    const second = ok<StartOut>(
      await call(client, 'start_work_item_run', { key: leaf.identifier, harness: 'Kimi CLI' }),
    );
    expect(second).toMatchObject({ outcome: 'mine', runId: first.runId });
    expect(await adminDb.dispatchRun.count()).toBe(1);
  });

  it('a second close answers `alreadyClosed` with the FIRST close’s outcome', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);
    const { runId } = ok<StartOut>(
      await call(client, 'start_work_item_run', { key: leaf.identifier, harness: 'Codex' }),
    );
    ok(
      await call(client, 'close_work_item_run', { key: leaf.identifier, runId, outcome: 'halted' }),
    );

    const again = ok<CloseOut>(
      await call(client, 'close_work_item_run', {
        key: leaf.identifier,
        runId,
        outcome: 'completed',
      }),
    );
    expect(again).toMatchObject({
      alreadyClosed: true,
      status: 'failed',
      stopReason: 'halted',
      stamped: [],
    });
  });
});

describe('the refusals', () => {
  it('a start without the claim is a RESULT naming the card, and writes nothing', async () => {
    const todo = await createTestWorkItem(fx, { kind: 'task', title: 'never claimed' });
    const client = await connect(fx.ctx);

    const result = await call(client, 'start_work_item_run', {
      key: todo.identifier,
      harness: 'Codex',
    });
    expect(ok<StartOut>(result)).toMatchObject({
      outcome: 'not_claimed',
      runId: null,
      offenderKey: todo.identifier,
    });
    expect(text(result)).toContain('claim_work_item');
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });

  it('a report with no open run is a RESULT telling the agent to start one', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);

    const result = await call(client, 'report_action', {
      key: leaf.identifier,
      action: 'Reading the card',
    });
    expect(ok<ReportOut>(result)).toMatchObject({ outcome: 'no_open_run', accepted: 0 });
    expect(text(result)).toContain('start_work_item_run');
  });

  it('a disallowed kind comes back in `refused` by name while the allowed events are stored', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);
    const { runId } = ok<StartOut>(
      await call(client, 'start_work_item_run', { key: leaf.identifier, harness: 'Codex' }),
    );

    const reported = ok<ReportOut>(
      await call(client, 'report_action', {
        key: leaf.identifier,
        events: [
          { kind: 'run_closed' },
          { kind: 'delivery_linked', data: { url: 'https://example.com/pr/1' } },
        ],
      }),
    );
    expect(reported).toMatchObject({ outcome: 'reported', runId, accepted: 1 });
    expect(reported.refused.map((r) => r.kind)).toEqual(['run_closed']);

    const kinds = (
      await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId: runId! } })
    ).map((e) => e.kind);
    expect(kinds).toContain('delivery_linked');
    expect(kinds).not.toContain('run_closed');
  });

  it('a batch of nothing but refused kinds stores nothing and says so', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);
    const { runId } = ok<StartOut>(
      await call(client, 'start_work_item_run', { key: leaf.identifier, harness: 'Codex' }),
    );

    const reported = ok<ReportOut>(
      await call(client, 'report_action', { key: leaf.identifier, events: [{ kind: 'log' }] }),
    );
    expect(reported).toMatchObject({ outcome: 'refused', accepted: 0 });
    expect(await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: runId! } })).toBe(1);
  });

  it('closing somebody else’s run is refused by code, and `abandoned` is not an outcome', async () => {
    const leaf = await heldLeaf();
    const owner = await connect(fx.ctx);
    const { runId } = ok<StartOut>(
      await call(owner, 'start_work_item_run', { key: leaf.identifier, harness: 'Codex' }),
    );
    const user = await usersService.createUser({
      email: `other+${randomToken()}@example.com`,
      password: 'hunter2hunter2',
      name: 'Other',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    const other = await connect({ userId: user.id, workspaceId: fx.workspaceId });

    expect(
      errorCode(
        await call(other, 'close_work_item_run', {
          key: leaf.identifier,
          runId,
          outcome: 'completed',
        }),
      ),
    ).toBe('AGENT_RUN_NOT_YOURS');
    const abandoned = await call(owner, 'close_work_item_run', {
      key: leaf.identifier,
      runId,
      outcome: 'abandoned',
    });
    expect(abandoned.isError).toBe(true);
    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId! } });
    expect(row.status).toBe('running');
  });

  it('an over-long action is refused by code and writes nothing', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);
    const { runId } = ok<StartOut>(
      await call(client, 'start_work_item_run', { key: leaf.identifier, harness: 'Codex' }),
    );
    expect(
      errorCode(
        await call(client, 'report_action', { key: leaf.identifier, action: 'x'.repeat(501) }),
      ),
    ).toBe('AGENT_RUN_REPORT_INVALID');
    expect(await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: runId! } })).toBe(1);
  });
});

describe('liveness — the heartbeat', () => {
  async function staleRun(client: Client, leaf: WorkItem): Promise<string> {
    const { runId } = ok<StartOut>(
      await call(client, 'start_work_item_run', { key: leaf.identifier, harness: 'Codex' }),
    );
    await adminDb.dispatchRun.update({
      where: { id: runId! },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    return runId!;
  }

  it('`report_action` with no arguments refreshes the caller’s open run', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);
    const runId = await staleRun(client, leaf);
    const before = Date.now() - 60_000;

    const beat = ok<ReportOut>(await call(client, 'report_action', {}));
    expect(beat).toMatchObject({ outcome: 'heartbeat', touched: 1 });
    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.lastHeartbeatAt!.getTime()).toBeGreaterThan(before);
  });

  it('an UNRELATED Motir call (`get_work_item`) by the run’s opener refreshes it', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);
    const runId = await staleRun(client, leaf);
    const before = Date.now() - 60_000;

    ok(await call(client, 'get_work_item', { key: leaf.identifier }));

    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.lastHeartbeatAt!.getTime()).toBeGreaterThan(before);
  });

  it('somebody else’s call leaves the run where it was', async () => {
    const leaf = await heldLeaf();
    const client = await connect(fx.ctx);
    const runId = await staleRun(client, leaf);
    const stale = (await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } }))
      .lastHeartbeatAt;
    const user = await usersService.createUser({
      email: `bystander+${randomToken()}@example.com`,
      password: 'hunter2hunter2',
      name: 'Bystander',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    const other = await connect({ userId: user.id, workspaceId: fx.workspaceId });

    await call(other, 'get_work_item', { key: leaf.identifier });

    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.lastHeartbeatAt).toEqual(stale);
  });
});
