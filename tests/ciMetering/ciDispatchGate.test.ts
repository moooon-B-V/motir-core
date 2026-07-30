import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import { POST as postReadyNext } from '@/app/api/ready/next/route';
import { getWorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The REFUSAL where it actually bites (Story MOTIR-1775 · MOTIR-1901 ·
// `ci-minutes-allowance.md` §6.2–6.3) — the DISPATCH paths, not just the service
// that decides. §6.3 chose dispatch precisely because it fails BEFORE the user
// waits on a run, so a test that only exercised `assertDispatchAllowed` in
// isolation would not show that the gate is actually reachable from the paths
// that hand out work.
//
// There are THREE of them and they must agree: `POST /api/ready/next`, the
// `next_ready` MCP tool (both via `workItemsService.getNextReady`), and
// `claim_next_ready` (via `claimNextReady`). A gate on only one is a gate a
// caller walks around.

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: vi.fn() };
});

const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');

/** Stub motir-ai's balance read at `balance`; the debit is never reached here. */
function stubBalance(balance: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ balance }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

/** Put the org past its 1,000-minute floor pool. */
async function exhaustPool(fx: WorkItemFixture): Promise<void> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
  await withSystemContext((tx) =>
    ciPeriodUsageRepository.incrementForPeriod(
      {
        workspaceId: fx.workspaceId,
        organizationId: workspace.organizationId,
        periodStart: JULY_2026,
        billableMinutes: 1200,
        rawWallClockSeconds: 72_000,
        linearEquivalentMinutes: 1200,
      },
      tx,
    ),
  );
}

async function makeReady(fx: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, assigneeId: null, descriptionMd: null },
    fx.ctx,
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  // The period the fixture's consumption lands in must be the one the gate reads.
  vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('an EXHAUSTED org is refused on every dispatch path (§6.2)', () => {
  it('getNextReady — the `POST /api/ready/next` + `next_ready` path', async () => {
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'runnable');
    await exhaustPool(fx);
    stubBalance(0);

    await expect(workItemsService.getNextReady(fx.projectId, {}, fx.ctx)).rejects.toThrow(
      CiCreditsExhaustedError,
    );
  });

  it('claimNextReady — and the refusal does NOT consume a candidate', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'runnable');
    await exhaustPool(fx);
    stubBalance(-39); // §6.4's bounded in-flight overshoot

    await expect(runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx)).rejects.toThrow(
      CiCreditsExhaustedError,
    );

    // The gate runs BEFORE the claim transaction, so nothing was flipped to
    // in_progress and stranded — the item is still there for after the top-up.
    const row = await db.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.status).toBe('todo');
  });

  it('the route maps it to 402 with the detail the surface renders (§6.3)', async () => {
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'runnable');
    await exhaustPool(fx);
    stubBalance(0);
    vi.mocked(getWorkspaceContext).mockResolvedValue(fx.ctx as never);

    const res = await postReadyNext(
      new Request('http://localhost/api/ready/next', {
        method: 'POST',
        body: JSON.stringify({ projectKey: fx.projectIdentifier }),
      }),
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { code: string; ci: Record<string, unknown> };
    expect(body.code).toBe('CI_CREDITS_EXHAUSTED');
    // Not a generic failure — the panel can say WHY.
    expect(body.ci).toMatchObject({
      state: 'ci_credits_exhausted',
      consumedMinutes: 1200,
      poolMinutes: 1000,
      balance: 0,
    });
  });
});

describe('every other state dispatches normally', () => {
  it('inside the allowance, at any balance', async () => {
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'runnable');
    stubBalance(0); // exhausted credits, but the pool is untouched

    const item = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(item?.title).toBe('runnable');
  });

  it('past the pool while credits remain — drawing_on_credits never blocks (§6.1)', async () => {
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'runnable');
    await exhaustPool(fx);
    stubBalance(500);

    const item = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(item?.title).toBe('runnable');
  });

  it('when motir-ai is unreachable — the gate fails OPEN, not closed', async () => {
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'runnable');
    await exhaustPool(fx);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    const item = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(item?.title).toBe('runnable');
  });

  it('off-cloud, where there is no meter and no pool at all (§8.5)', async () => {
    const fx = await makeWorkItemFixture();
    await makeReady(fx, 'runnable');
    await exhaustPool(fx);
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const item = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(item?.title).toBe('runnable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
