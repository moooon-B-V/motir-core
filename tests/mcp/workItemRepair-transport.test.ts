import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { isRunAlive } from '@/lib/runs/runLiveness';
import { GRANTABLE_PERMISSIONS, type TokenGrant } from '@/lib/tokens/grant';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { usersService } from '@/lib/services/usersService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem } from '../fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { withTokenFor } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// Story MOTIR-6804 · MOTIR-6808 — the STORY'S INTEGRATION GATE for the three
// repair tools. Every MCP call goes through the assembled path an agent meets:
//
//   MCP client → transport → the registry's server (strict input + the per-token
//   PERMISSION gate) → tool → `workItemRepairService` / `dispatchRunService` →
//   repositories → the RLS-gated `dispatch_run` tables on a real Postgres.
//
// Every REST call goes through the real route handler with a real bearer PAT —
// the door `motir fix` knocks on. The unit tier (`workItemRepairTool.test.ts`)
// enters at the adapters; this file asserts the STORY's criteria, and each case
// reads the database back — the number of open `fix` runs, `lastHeartbeatAt`,
// the stop reason — as well as the tool's answer.
//
// It tests the DOOR, not the repair rules: the refusal ORDER and the predicate
// are MOTIR-5467's matrix (`tests/ready/claimWorkItemRepair.test.ts`); here each
// reason is seeded once and must come through the MCP unchanged.

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx` + this `grant`. */
async function connect(
  ctx: ServiceContext,
  grant: TokenGrant = GRANTABLE_PERMISSIONS,
): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...grant],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'repair-gate', version: '0.0.0' });
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
  outcome: string;
  reason: string | null;
  runTargetKey: string | null;
  runId: string | null;
  holder: { id: string; name: string } | null;
  repairClass: string;
  pullRequests: { repo: string; number: number; headRef: string; failingChecks: string[] }[];
}
interface RunOut {
  runId: string;
  open: boolean;
  status: string;
  stopReason: string | null;
  lastHeartbeatAt: string | null;
}

/** REST: `POST /api/v1/work-items/{key}/repair`, as `motir fix` sends it. */
async function restClaim(key: string, headers: Record<string, string>): Promise<ClaimOut> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/repair/route');
  const res = await POST(
    new Request(`http://localhost:3000/api/v1/work-items/${encodeURIComponent(key)}/repair`, {
      method: 'POST',
      headers,
    }),
    { params: Promise.resolve({ key }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ClaimOut;
}

async function member(
  fx: WorkItemFixture,
  name: string,
): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** An `implemented` task with ONE open pull request whose `Vitest` is failing. */
async function redCard(fx: WorkItemFixture, title: string, headRef = 'subtask/red') {
  const card = await createTestWorkItem(fx, { kind: 'task', title });
  await setStatus(card.id, 'implemented');
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  await deliveredPr(fx, card.id, repo, {
    headRef,
    baseRef: 'main',
    checks: { Vitest: 'failure', Lint: 'success' },
  });
  return card;
}

const openFixRuns = (workItemId: string) =>
  adminDb.dispatchRun.findMany({
    where: { command: 'fix', status: 'running', cards: { some: { workItemId } } },
  });
const fixRunCount = () => adminDb.dispatchRun.count({ where: { command: 'fix' } });
const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

describe('1 · parity — the MCP claim answers what the REST claim answers', () => {
  it('claims with the same pull requests, branch and failing checks, and the page reads being fixed by the token owner', async () => {
    const fx = await makeWorkItemFixture();
    // Two IDENTICAL seeds, one per door.
    const viaMcpCard = await redCard(fx, 'red card', 'subtask/red');
    const viaRestCard = await redCard(fx, 'red card', 'subtask/red');
    const rest = await withTokenFor(fx.owner, fx.workspace, {
      projectId: fx.projectId,
      scopes: ['read', 'work_items:write'],
    });
    const client = await connect(fx.ctx);

    const mcp = ok<ClaimOut>(
      await call(client, 'claim_work_item_repair', { key: viaMcpCard.identifier }),
    );
    const viaRest = await restClaim(viaRestCard.identifier, rest.headers);

    // Everything but the per-seed identity (key, run, PR number and URL, start).
    const strip = (c: ClaimOut) => ({
      ...c,
      key: undefined,
      runId: undefined,
      startedAt: undefined,
      pullRequests: c.pullRequests.map((pr) => ({
        ...pr,
        repo: undefined,
        number: undefined,
        url: undefined,
      })),
    });
    expect(mcp.outcome).toBe('claimed');
    expect(strip(mcp)).toEqual(strip(viaRest));
    expect(Object.keys(mcp).sort()).toEqual(Object.keys(viaRest).sort());
    expect(mcp.pullRequests).toEqual([
      expect.objectContaining({ headRef: 'subtask/red', failingChecks: ['Vitest'] }),
    ]);
    expect(mcp.repairClass).toBe('ci');

    // The item page's read: an open fix by the token's owner.
    const view = await workItemRepairService.getRepairView(viaMcpCard.id, fx.ctx);
    expect(view).toMatchObject({
      state: 'in_progress',
      holder: { id: fx.ownerId },
      byViewer: true,
    });

    const runs = await openFixRuns(viaMcpCard.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: mcp.runId, origin: 'local', createdById: fx.ownerId });
    expect(runs[0]!.lastHeartbeatAt).not.toBeNull();
  });
});

describe('2 · one lock across both doors', () => {
  it('an open MCP claim makes a second user’s REST claim `taken`, naming the first', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx, 'contested');
    const bob = await member(fx, 'Bob Rest');
    const bobRest = await withTokenFor(bob.user, fx.workspace, {
      projectId: fx.projectId,
      scopes: ['read', 'work_items:write'],
    });
    const client = await connect(fx.ctx);

    const first = ok<ClaimOut>(
      await call(client, 'claim_work_item_repair', { key: card.identifier }),
    );
    const second = await restClaim(card.identifier, bobRest.headers);

    expect(second).toMatchObject({
      outcome: 'taken',
      runId: first.runId,
      holder: { id: fx.ownerId },
      pullRequests: [],
    });
    expect(await openFixRuns(card.id)).toHaveLength(1);
  });

  it('an open REST claim makes an MCP claim `taken`; the same MCP token again is `mine` with the same run', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx, 'contested the other way');
    const rest = await withTokenFor(fx.owner, fx.workspace, {
      projectId: fx.projectId,
      scopes: ['read', 'work_items:write'],
    });
    const first = await restClaim(card.identifier, rest.headers);
    const bob = await member(fx, 'Bob Agent');
    const bobClient = await connect(bob.ctx);

    const takenResult = await call(bobClient, 'claim_work_item_repair', { key: card.identifier });
    expect(ok<ClaimOut>(takenResult)).toMatchObject({
      outcome: 'taken',
      runId: first.runId,
      holder: { id: fx.ownerId },
    });
    expect((takenResult.content[0] as { text: string }).text).toContain(fx.owner.name);

    // The REST holder's own agent over the MCP resumes it.
    const ownerClient = await connect(fx.ctx);
    const mine = ok<ClaimOut>(
      await call(ownerClient, 'claim_work_item_repair', { key: card.identifier }),
    );
    expect(mine).toMatchObject({ outcome: 'mine', runId: first.runId });
    expect(await openFixRuns(card.id)).toHaveLength(1);
  });
});

describe('3 · every refusal comes through the MCP unchanged, and opens nothing', () => {
  it.each([
    'not_implemented',
    'repair_on_run_target',
    'no_pull_requests',
    'ci_running',
    'not_failing',
    'repair_not_code',
  ] as const)('%s', async (reason) => {
    const fx = await makeWorkItemFixture();
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const card = await createTestWorkItem(fx, { kind: 'task', title: `refused ${reason}` });
    let expectedTarget: string | null = null;

    switch (reason) {
      case 'not_implemented':
        await setStatus(card.id, 'todo');
        break;
      case 'repair_on_run_target': {
        // The same pull request delivers the card AND the story that is its run
        // target, and the story carries the run's How to test.
        const story = await createTestWorkItem(fx, { kind: 'story', title: 'the run target' });
        await adminDb.workItem.update({
          where: { id: card.id },
          data: { parentId: story.id, kind: 'subtask' },
        });
        await setStatus(card.id, 'implemented');
        await deliveredPr(fx, card.id, repo, {
          headRef: 'parent/x',
          checks: { Vitest: 'failure' },
        });
        await testInstructionsService.publish(
          {
            workItemId: story.id,
            bodyMd: '## Precondition\n\nSign in.',
            previewPath: null,
            repos: [{ repoId: repo.id, commitSha: 'c'.repeat(40) }],
          },
          fx.ctx,
        );
        expectedTarget = story.identifier;
        break;
      }
      case 'no_pull_requests':
        await setStatus(card.id, 'implemented');
        break;
      case 'ci_running':
        await setStatus(card.id, 'implemented');
        await deliveredPr(fx, card.id, repo, { headRef: 'a', checks: { Vitest: 'pending' } });
        break;
      case 'not_failing':
        await setStatus(card.id, 'implemented');
        await deliveredPr(fx, card.id, repo, { headRef: 'a', checks: { Vitest: 'success' } });
        break;
      case 'repair_not_code': {
        await setStatus(card.id, 'in_review');
        const pr = await deliveredPr(fx, card.id, repo, {
          headRef: 'a',
          checks: { Vitest: 'success' },
        });
        await adminDb.githubPullRequestQueueExit.create({
          data: {
            pullRequestId: pr.id,
            deliveryId: `guid-${randomToken(8)}`,
            rawReason: 'BRANCH_PROTECTIONS',
            disposition: 'failure',
            headSha: 'c'.repeat(40),
            exitedAt: new Date('2026-09-18T10:00:00.000Z'),
          },
        });
        break;
      }
    }
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    const client = await connect(fx.ctx);

    const result = await call(client, 'claim_work_item_repair', { key: card.identifier });

    expect(ok<ClaimOut>(result)).toMatchObject({
      outcome: 'not_repairable',
      reason,
      runTargetKey: expectedTarget,
      runId: null,
      pullRequests: [],
    });
    expect((result.content[0] as { text: string }).text).toContain(expectedTarget ?? reason);
    expect(await fixRunCount()).toBe(0);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe('4 · liveness past the five-minute rule', () => {
  it('a touched run is alive; a silent one is dead, reaped, and its next touch answers open:false', async () => {
    const fx = await makeWorkItemFixture();
    const kept = await redCard(fx, 'kept alive');
    const silent = await redCard(fx, 'left silent');
    const client = await connect(fx.ctx);
    const keptRun = ok<ClaimOut>(
      await call(client, 'claim_work_item_repair', { key: kept.identifier }),
    ).runId as string;
    const silentRun = ok<ClaimOut>(
      await call(client, 'claim_work_item_repair', { key: silent.identifier }),
    ).runId as string;

    // Move both runs' clocks six minutes into the past: the last word either
    // heard was before the lapse window.
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
    await adminDb.dispatchRun.updateMany({
      where: { id: { in: [keptRun, silentRun] } },
      data: { startedAt: sixMinutesAgo, lastHeartbeatAt: sixMinutesAgo },
    });
    // Only one of them is touched inside the window.
    const touched = ok<RunOut>(
      await call(client, 'touch_work_item_repair', { key: kept.identifier, runId: keptRun }),
    );
    expect(touched).toMatchObject({ open: true, status: 'running' });

    const now = new Date();
    const keptRow = await runRow(keptRun);
    const silentRow = await runRow(silentRun);
    expect(keptRow.lastHeartbeatAt!.getTime()).toBeGreaterThan(sixMinutesAgo.getTime());
    expect(isRunAlive(keptRow, now)).toBe(true);
    expect(isRunAlive(silentRow, now)).toBe(false);

    // The liveness sweep's reap, over the real lapsed-local-run query.
    const summary = await dispatchRunSweepService.reapLapsed(now);
    expect(summary.runsReaped).toBe(1);
    expect(await runRow(keptRun)).toMatchObject({ status: 'running', stopReason: null });
    expect(await runRow(silentRun)).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });

    // The agent that held the silent run learns so on its next touch — an
    // answer, not an error — and the touch writes nothing.
    const reaped = ok<RunOut>(
      await call(client, 'touch_work_item_repair', { key: silent.identifier, runId: silentRun }),
    );
    expect(reaped).toMatchObject({ open: false, status: 'timed_out', stopReason: 'abandoned' });
    expect((await runRow(silentRun)).lastHeartbeatAt).toEqual(silentRow.lastHeartbeatAt);
    expect(await openFixRuns(silent.id)).toHaveLength(0);
  });
});

describe('5 · close', () => {
  it('gave_up closes with the mapped reason, the page shows it ended, a fresh claim is admitted, and a second close repeats the first', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx, 'given up on');
    const client = await connect(fx.ctx);
    const runId = ok<ClaimOut>(
      await call(client, 'claim_work_item_repair', { key: card.identifier }),
    ).runId as string;

    const closed = ok<RunOut>(
      await call(client, 'close_work_item_repair', {
        key: card.identifier,
        runId,
        outcome: 'gave_up',
      }),
    );
    expect(closed).toMatchObject({ runId, open: false, status: 'failed', stopReason: 'halted' });
    expect(await runRow(runId)).toMatchObject({ status: 'failed', stopReason: 'halted' });

    const view = await workItemRepairService.getRepairView(card.id, fx.ctx);
    expect(view).toMatchObject({ state: 'offer', lastGaveUp: { attempts: null } });

    const again = ok<RunOut>(
      await call(client, 'close_work_item_repair', {
        key: card.identifier,
        runId,
        outcome: 'gave_up',
      }),
    );
    expect(again).toEqual(closed);

    const fresh = ok<ClaimOut>(
      await call(client, 'claim_work_item_repair', { key: card.identifier }),
    );
    expect(fresh.outcome).toBe('claimed');
    expect(fresh.runId).not.toBe(runId);
    expect(await openFixRuns(card.id)).toHaveLength(1);
  });
});

describe('6 · ownership, permissions and tenancy', () => {
  it('touching or closing another user’s run is refused and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx, 'someone else’s');
    const bob = await member(fx, 'Bob Holder');
    const bobClient = await connect(bob.ctx);
    const runId = ok<ClaimOut>(
      await call(bobClient, 'claim_work_item_repair', { key: card.identifier }),
    ).runId as string;
    const before = await runRow(runId);
    const ownerClient = await connect(fx.ctx);

    expect(
      refusal(await call(ownerClient, 'touch_work_item_repair', { key: card.identifier, runId })),
    ).toContain('REPAIR_RUN_NOT_YOURS');
    expect(
      refusal(
        await call(ownerClient, 'close_work_item_repair', {
          key: card.identifier,
          runId,
          outcome: 'green',
        }),
      ),
    ).toContain('REPAIR_RUN_NOT_YOURS');
    expect(await runRow(runId)).toEqual(before);
  });

  it('a token without work_item:edit is refused the claim by name, and no run opens', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx, 'guarded');
    const readOnly = await connect(
      fx.ctx,
      GRANTABLE_PERMISSIONS.filter((p) => p !== 'work_item:edit'),
    );

    for (const [tool, args] of [
      ['claim_work_item_repair', { key: card.identifier }],
      ['touch_work_item_repair', { key: card.identifier, runId: 'run_x' }],
      ['close_work_item_repair', { key: card.identifier, runId: 'run_x', outcome: 'green' }],
    ] as const) {
      const text = refusal(await call(readOnly, tool, args));
      expect(text, tool).toContain(PERMISSION_NOT_GRANTED_CODE);
      expect(text, tool).toContain('work_item:edit');
    }
    expect(await fixRunCount()).toBe(0);
  });

  it('a member whose ROLE cannot edit is refused the claim, and no run opens', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx, 'viewer-proof');
    const viewer = await member(fx, 'Vera Viewer');
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.user.id,
      role: 'viewer',
    });
    const client = await connect(viewer.ctx);

    expect(
      refusal(await call(client, 'claim_work_item_repair', { key: card.identifier })),
    ).toContain('PROJECT_ACCESS_DENIED');
    expect(await fixRunCount()).toBe(0);
  });

  it('a card in another workspace is not found — even to a caller holding every permission', async () => {
    const fxA = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const fxB = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    const card = await redCard(fxA, 'tenant A’s');
    const ownerA = await connect(fxA.ctx);
    const runId = ok<ClaimOut>(
      await call(ownerA, 'claim_work_item_repair', { key: card.identifier }),
    ).runId as string;
    const before = await runRow(runId);
    const tenantB = await connect(fxB.ctx);

    for (const [tool, args] of [
      ['claim_work_item_repair', { key: card.identifier }],
      ['touch_work_item_repair', { key: card.identifier, runId }],
      ['close_work_item_repair', { key: card.identifier, runId, outcome: 'green' }],
    ] as const) {
      expect(refusal(await call(tenantB, tool, args)), tool).toMatch(/NOT_FOUND/);
    }
    // And tenant B naming its OWN card with A's run id finds no repair run.
    const own = await redCard(fxB, 'tenant B’s');
    expect(
      refusal(await call(tenantB, 'touch_work_item_repair', { key: own.identifier, runId })),
    ).toContain('REPAIR_RUN_NOT_FOUND');
    expect(await runRow(runId)).toEqual(before);
    expect(await fixRunCount()).toBe(1);
  });
});

describe('7 · concurrency', () => {
  it('two MCP claims fired at once leave exactly ONE open fix run — one claimed, one taken', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx, 'raced');
    const bob = await member(fx, 'Bob Racer');
    const [ownerClient, bobClient] = await Promise.all([connect(fx.ctx), connect(bob.ctx)]);
    // On a cold pool the racers share one connection and pass with the lock missing.
    await warmPool(6);

    const results = await Promise.all([
      call(ownerClient, 'claim_work_item_repair', { key: card.identifier }),
      call(bobClient, 'claim_work_item_repair', { key: card.identifier }),
    ]);

    const outcomes = results.map((r) => ok<ClaimOut>(r));
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['claimed', 'taken']);
    const winner = outcomes.find((o) => o.outcome === 'claimed')!;
    const loser = outcomes.find((o) => o.outcome === 'taken')!;
    expect(loser.runId).toBe(winner.runId);
    expect(loser.holder?.id).toBe(winner.holder?.id);
    const open = await openFixRuns(card.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(winner.runId);
  });
});
