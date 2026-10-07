import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApprovalGateKind, ApprovalGateState, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { buildMcpServer } from '@/lib/mcp/registry';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunHeldGateRepository } from '@/lib/repositories/dispatchRunHeldGateRepository';
import { withWorkspaceContext } from '@/lib/workspaces';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// A `gated` close NAMES THE GATES that held it (Story MOTIR-7701 · MOTIR-7703).
//
// A parent run that stops because every remaining child waits on a person's gate
// closes `gated`, and the close writes one `dispatch_run_held_gate` row per
// AWAITING gate of a run-holding kind on a card the run covers or its scope's
// children. The derivation lives in `closeWithin`, so every door is the same
// door; this file drives the two an agent and the CLI use — `close_work_item_run`
// over MCP and the ingest close — and reads every answer back from the rows.

let caller: V1ProjectCaller;
let fx: WorkItemFixture;
let agent: Client;

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  fx = caller.fixture;
  agent = await connect(fx.ctx);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...GRANTABLE_PERMISSIONS],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'held-gates', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function ok<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await agent.callTool({ name, arguments: args })) as CallToolResult;
}

/** Where `claim_work_item` leaves a card: In Progress, assigned to the caller. */
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

async function gate(
  item: WorkItem,
  kind: ApprovalGateKind,
  state: ApprovalGateState = 'awaiting',
): Promise<string> {
  const decided = state === 'awaiting' ? {} : { decidedById: fx.ownerId, decidedAt: new Date() };
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${randomToken()}`,
      state,
      ...decided,
    },
  });
  return row.id;
}

/** A story with a design child, a code child, and a manual child. */
async function story() {
  const parent = await held('a story', { kind: 'story' });
  const design = await held('the design', { kind: 'subtask', parentId: parent.id });
  const code = await held('the code', { kind: 'subtask', parentId: parent.id });
  const manual = await held('the manual step', { kind: 'subtask', parentId: parent.id });
  return { parent, design, code, manual };
}

const heldRows = (runId: string) =>
  adminDb.dispatchRunHeldGate.findMany({ where: { dispatchRunId: runId } });

async function startAgentRun(key: string): Promise<string> {
  const started = ok<{ runId: string }>(
    await call('start_work_item_run', { key, harness: 'Codex', model: 'gpt-5-codex' }),
  );
  return started.runId;
}

describe('close_work_item_run — the agent door', () => {
  it('a `gated` close records each awaiting holding gate, and reads as succeeded', async () => {
    const { parent, design, manual } = await story();
    const runId = await startAgentRun(parent.identifier);
    const designGate = await gate(design, 'design_result');
    const manualGate = await gate(manual, 'manual_work');

    const closed = ok<{ status: string; stopReason: string }>(
      await call('close_work_item_run', { key: parent.identifier, runId, outcome: 'gated' }),
    );

    expect(closed).toMatchObject({ status: 'succeeded', stopReason: 'gated' });
    const rows = await heldRows(runId);
    expect(rows.map((r) => [r.gateId, r.workItemId, r.kind]).sort()).toEqual(
      [
        [designGate, design.id, 'design_result'],
        [manualGate, manual.id, 'manual_work'],
      ].sort(),
    );
    expect(rows.every((r) => r.workspaceId === fx.workspaceId)).toBe(true);
  });

  it('records every holding kind, and none of the kinds that never hold a parent run', async () => {
    const { parent, design, code, manual } = await story();
    const runId = await startAgentRun(parent.identifier);
    const holding = [
      await gate(design, 'design_result'),
      await gate(code, 'decision_approval'),
      await gate(manual, 'decision_choice'),
      await gate(design, 'decision_confirmation'),
    ];
    await gate(code, 'pull_request_approval');
    await gate(design, 'acceptance_result');
    await gate(manual, 'agent_review');
    // The scope's OWN gate is the story's deliverable, not a stopper the run waited on.
    await gate(parent, 'decision_approval');

    ok(await call('close_work_item_run', { key: parent.identifier, runId, outcome: 'gated' }));

    expect((await heldRows(runId)).map((r) => r.gateId).sort()).toEqual([...holding].sort());
  });

  it('a decided gate is not recorded — only one still awaiting holds the run', async () => {
    const { parent, design, code } = await story();
    const runId = await startAgentRun(parent.identifier);
    await gate(design, 'design_result', 'approved');
    await gate(code, 'decision_approval', 'changes_requested');

    const closed = ok<{ status: string }>(
      await call('close_work_item_run', { key: parent.identifier, runId, outcome: 'gated' }),
    );

    // A gated close with nothing awaiting writes no rows and still succeeds.
    expect(closed.status).toBe('succeeded');
    expect(await heldRows(runId)).toHaveLength(0);
  });

  it('a gate on a card outside the run is not recorded', async () => {
    const { parent, design } = await story();
    const elsewhere = await held('a card on another story');
    const runId = await startAgentRun(parent.identifier);
    const inScope = await gate(design, 'design_result');
    await gate(elsewhere, 'design_result');

    ok(await call('close_work_item_run', { key: parent.identifier, runId, outcome: 'gated' }));

    expect((await heldRows(runId)).map((r) => r.gateId)).toEqual([inScope]);
  });

  it.each(['halted', 'drained', 'completed'])(
    'a `%s` close records no gate, even with one awaiting',
    async (outcome) => {
      const { parent, design } = await story();
      const runId = await startAgentRun(parent.identifier);
      await gate(design, 'design_result');

      ok(await call('close_work_item_run', { key: parent.identifier, runId, outcome }));

      expect(await heldRows(runId)).toHaveLength(0);
    },
  );
});

describe('the ingest close — the CLI door', () => {
  it('a `gated` close of a scope run records the gate on a child', async () => {
    const { parent, design, code } = await story();
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: parent.identifier,
        cards: [
          { key: code.identifier, disposition: 'queued' },
          { key: design.identifier, disposition: 'queued' },
        ],
      },
      fx.ctx,
    );
    const designGate = await gate(design, 'design_result');

    const closed = await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);

    expect(closed).toMatchObject({ status: 'succeeded', stopReason: 'gated' });
    // Read inside the workspace, the way every consumer reads them (RLS-bound).
    const [byRun, byGate] = await withWorkspaceContext(fx.ctx, async (tx) => [
      await dispatchRunHeldGateRepository.listByRun(run.id, tx),
      await dispatchRunHeldGateRepository.listByGate(designGate, tx),
    ]);
    expect(byRun.map((r) => [r.gateId, r.workItemId, r.kind])).toEqual([
      [designGate, design.id, 'design_result'],
    ]);
    expect(byGate.map((r) => r.dispatchRunId)).toEqual([run.id]);
  });

  it('a second close is refused before it writes, so the rows are not doubled', async () => {
    const { parent, design } = await story();
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: parent.identifier,
        cards: [{ key: design.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await gate(design, 'design_result');
    await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);

    await expect(
      dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx),
    ).rejects.toMatchObject({ code: 'DISPATCH_RUN_TERMINAL' });
    expect(await heldRows(run.id)).toHaveLength(1);
  });
});
