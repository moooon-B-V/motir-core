import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/work-items/[key]/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { connectRepairRepo, deliveredPr, setStatus } from '../../helpers/repairFixtures';

// GET /api/v1/work-items/{key} — `deliveries[].queueExit` (Story MOTIR-5628 ·
// MOTIR-5720).
//
// `motir fix`'s watch loop decides from `deliveries[]`, and an ejected pull
// request's own `ci` is `passing` — so without this field the loop called it
// green and never ran the agent. The server decides "standing" (a failure, not
// re-queued, at the current head); the client holds no head logic. Every shape
// that does NOT stand publishes `null`.

const BASE = 'http://localhost:3000/api/v1/work-items';
const HEAD = 'c'.repeat(40);

const detail = (key: string, caller: V1ProjectCaller) =>
  GET(new Request(`${BASE}/${key}`, { headers: caller.headers }), {
    params: Promise.resolve({ key }),
  });

describe('GET /api/v1/work-items/{key} — deliveries[].queueExit (MOTIR-5720)', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read'] });
  });

  async function ejectedCard(
    exit: {
      disposition?: 'failure' | 'neutral';
      rawReason?: string;
      headSha?: string;
      requeuedAt?: Date | null;
    } | null,
  ) {
    const card = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Ejected' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(caller.fixture, 'web');
    const pr = await deliveredPr(caller.fixture, card.id, repo, {
      headRef: 'subtask/ejected',
      checks: { Vitest: 'success' },
    });
    if (exit) {
      await adminDb.githubPullRequestQueueExit.create({
        data: {
          pullRequestId: pr.id,
          deliveryId: `guid-${exit.rawReason ?? 'x'}-${exit.headSha ?? 'h'}`,
          rawReason: exit.rawReason ?? 'CI_FAILURE',
          disposition: exit.disposition ?? 'failure',
          headSha: exit.headSha ?? HEAD,
          exitedAt: new Date('2026-09-18T10:00:00.000Z'),
          requeuedAt: exit.requeuedAt ?? null,
          failingCheckName: 'Merge queue / e2e',
          failingCheckUrl: 'https://github.com/acme/web/runs/77',
        },
      });
    }
    return card;
  }

  async function deliveriesOf(key: string) {
    const res = await detail(key, caller);
    expect(res.status).toBe(200);
    const parsed = workItemDetailSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    return parsed.data!.deliveries;
  }

  it('a standing failure exit at the head is published, beside the pull request’s own green `ci`', async () => {
    const card = await ejectedCard({});
    expect(await deliveriesOf(card.identifier)).toEqual([
      expect.objectContaining({
        ci: 'passing',
        queueExit: {
          rawReason: 'CI_FAILURE',
          headSha: HEAD,
          failingCheckName: 'Merge queue / e2e',
          failingCheckUrl: 'https://github.com/acme/web/runs/77',
        },
      }),
    ]);
  });

  it.each([
    ['re-queued', { requeuedAt: new Date() }],
    ['neutral', { disposition: 'neutral' as const, rawReason: 'MANUAL' }],
    ['at an OLD head', { headSha: 'a'.repeat(40) }],
  ])('an exit that is %s publishes null', async (_label, exit) => {
    const card = await ejectedCard(exit);
    expect(await deliveriesOf(card.identifier)).toEqual([
      expect.objectContaining({ ci: 'passing', queueExit: null }),
    ]);
  });

  it('a pull request never ejected publishes null', async () => {
    const card = await ejectedCard(null);
    expect(await deliveriesOf(card.identifier)).toEqual([
      expect.objectContaining({ queueExit: null }),
    ]);
  });
});
