import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  registerRequestDbTimingListener,
  REQUEST_DB_TIMING_METRICS as M,
  requestDbTimingRegistry,
  resetRequestDbTimingForTests,
} from '@/lib/monitoring/requestDbTiming';
import { withRequestLabel } from '@/lib/monitoring/requestLabel';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';

// MOTIR-8553 — THE REAL SEAM: a real `with*Context` helper on the real pool and
// Postgres, the recorder listening, and the request label set the way the hot
// routes set it. No Sentry: the recording needs none.

type Value = { labels: Record<string, string>; value: number; metricName?: string };

async function series(name: string, suffix: '_count' | '_sum', labels: Record<string, string>) {
  const metric = requestDbTimingRegistry().getSingleMetric(name)!;
  const values = (await metric.get()).values as Value[];
  return values
    .filter(
      (v) =>
        v.metricName === `${name}${suffix}` &&
        Object.entries(labels).every(([k, want]) => v.labels[k] === want),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  resetRequestDbTimingForTests();
  await truncateAuthTables();
  spyOnJobDispatch();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRequestDbTimingForTests();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the recorder on a real transaction', () => {
  it('a labelled withWorkspaceServiceContext transaction is one plan_get hold, at least as long as its body', async () => {
    const fx = await makeWorkItemFixture();
    registerRequestDbTimingListener();

    await withRequestLabel({ route: 'plan_get' }, () =>
      withWorkspaceServiceContext(fx.workspaceId, async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await sleep(80);
      }),
    );

    const labels = { route: 'plan_get', context: 'workspace_service', outcome: 'committed' };
    expect(await series(M.hold, '_count', labels)).toBe(1);
    expect(await series(M.hold, '_sum', labels)).toBeGreaterThanOrEqual(0.075);
    expect(await series(M.wait, '_count', labels)).toBe(1);
    // The real pool is registered by `lib/db.ts`, so occupancy was read.
    expect(await series(M.poolWaiting, '_count', { route: 'plan_get' })).toBe(1);
  });

  it('the same transaction with no label lands under unlabelled', async () => {
    const fx = await makeWorkItemFixture();
    registerRequestDbTimingListener();

    await withWorkspaceServiceContext(fx.workspaceId, async (tx) => {
      await tx.$queryRaw`SELECT 1`;
    });

    expect(
      await series(M.hold, '_count', { route: 'unlabelled', context: 'workspace_service' }),
    ).toBe(1);
    expect(await series(M.hold, '_count', { route: 'plan_get' })).toBe(0);
  });

  it('an MCP move_to_parent records its transactions under route="mcp", tool="move_to_parent"', async () => {
    const fx = await makeWorkItemFixture();
    const epicA = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic A', parentId: null },
      fx.ctx,
    );
    const epicB = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic B', parentId: null },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Movable', parentId: epicA.id },
      fx.ctx,
    );

    const server = buildMcpServer(() => fx.ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'request-db-timing', version: '0.0.0' });
    await client.connect(clientTransport);

    // Listening only from here, so the fixture's own transactions are not counted.
    registerRequestDbTimingListener();
    const res = await client.callTool({
      name: 'move_to_parent',
      arguments: { key: story.identifier, parentKey: epicB.identifier },
    });
    expect(res.isError).toBeFalsy();
    await client.close();

    const underTool = await series(M.wait, '_count', { route: 'mcp', tool: 'move_to_parent' });
    expect(underTool).toBeGreaterThanOrEqual(1);
    // Every transaction the call opened carries the tool: none escaped the label.
    expect(await series(M.wait, '_count', { route: 'unlabelled' })).toBe(0);
  });
});
