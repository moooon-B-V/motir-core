import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// A HOSTED run's token and credit cost ON the run detail (MOTIR-689, criterion 4)
// — real Postgres for the run; motir-ai is the external service across the
// open-core boundary, so `fetch` is the seam stubbed.
//
// ⚠️ The cost is a READ of motir-ai's per-run usage by the run's own id, never a
// column on `DispatchRun` (MOTIR-1801). A LOCAL run carries no `cost` and makes
// no call at all.

let fixture: WorkItemFixture;

const USAGE = {
  coreRunId: 'ignored',
  coreOrganizationId: 'org_1',
  model: 'claude-opus-5-5',
  inputTokens: 1200,
  outputTokens: 340,
  cacheMissTokens: 1200,
  cacheReadTokens: 9000,
  cacheWriteTokens: 450,
  credits: 17,
  events: 4,
  startedAt: '2026-09-26T12:00:00.000Z',
  lastUsageAt: '2026-09-26T12:10:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function openRun(origin: 'local' | 'hosted'): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title: 'a card' },
    fixture.ctx,
  );
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'run',
      origin,
      model: origin === 'hosted' ? 'claude-opus-5-5' : undefined,
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    fixture.ctx,
  );
  return run.id;
}

describe('getRunDetail — a hosted run carries its token and credit cost', () => {
  it("reads motir-ai's per-run usage by the run's own id", async () => {
    const runId = await openRun('hosted');
    const fetchMock = vi.fn(async () => json(USAGE));
    vi.stubGlobal('fetch', fetchMock);

    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);

    expect(detail.origin).toBe('hosted');
    expect(detail.cost).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 9000,
      cacheWriteTokens: 450,
      credits: 17,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://ai.test/v1/agent-runs/${runId}/usage`);
  });

  it('reads zeroes when motir-ai has recorded no usage for the run yet (404)', async () => {
    const runId = await openRun('hosted');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'not_found', status: 404, title: 'no usage' }, 404)),
    );
    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(detail.cost).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      credits: 0,
    });
  });

  it('carries cost: null — never zeroes, never a failed page — when motir-ai cannot be asked', async () => {
    const runId = await openRun('hosted');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(detail.cost).toBeNull();
    expect(detail.id).toBe(runId);
  });

  it('a LOCAL run carries no cost key and makes no call', async () => {
    const runId = await openRun('local');
    const fetchMock = vi.fn(async () => json(USAGE));
    vi.stubGlobal('fetch', fetchMock);

    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);

    expect(detail.origin).toBe('local');
    expect('cost' in detail).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
