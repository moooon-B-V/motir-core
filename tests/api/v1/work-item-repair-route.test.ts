import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemRepairClaimSchema } from '@/lib/api/v1/workLoop/schema';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { connectRepairRepo, deliveredPr, setStatus } from '../../helpers/repairFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// POST /api/v1/work-items/{key}/repair (Story MOTIR-5460 · MOTIR-5464) — the
// repair claim `motir fix <key>` makes.
//
// The route's own contract: the resource PARSES against its declared schema, a
// refusal is a 200 rather than an error status, the permission is the one the
// operation declares, and a foreign key is refused exactly as the keyed claim
// refuses it. The lock and the refusal matrix are asserted one layer down, in
// `tests/ready/claimWorkItemRepair.test.ts`.

const BASE = 'http://localhost:3000/api/v1/work-items';

async function repair(key: string, caller: { headers: Record<string, string> }): Promise<Response> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/repair/route');
  return POST(
    new Request(`${BASE}/${encodeURIComponent(key)}/repair`, {
      method: 'POST',
      headers: caller.headers,
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function redCard(fixture: WorkItemFixture, title: string) {
  const card = await createTestWorkItem(fixture, { kind: 'task', title });
  await setStatus(card.id, 'implemented');
  const repo = await connectRepairRepo(fixture, 'web');
  await deliveredPr(fixture, card.id, repo, {
    headRef: 'subtask/red',
    checks: { Vitest: 'failure' },
  });
  return card;
}

describe('POST /api/v1/work-items/{key}/repair', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('claims a red implemented card and the body PARSES against the declared schema', async () => {
    const card = await redCard(caller.fixture, 'Fix me');

    const res = await repair(card.identifier.toLowerCase(), caller);

    expect(res.status).toBe(200);
    const parsed = workItemRepairClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data).toMatchObject({
      key: card.identifier,
      outcome: 'claimed',
      reason: null,
      holder: { id: caller.fixture.ownerId },
    });
    expect(parsed.data?.runId).toEqual(expect.any(String));
    expect(parsed.data?.pullRequests).toEqual([
      expect.objectContaining({ repo: 'acme/web', headRef: 'subtask/red', ci: 'failing' }),
    ]);
  });

  it('an EJECTED card whose own checks are green is claimed, and `queueExit` PARSES (MOTIR-5719)', async () => {
    const card = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Ejected' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(caller.fixture, 'web');
    const pr = await deliveredPr(caller.fixture, card.id, repo, {
      headRef: 'subtask/ejected',
      checks: { Vitest: 'success' },
    });
    await adminDb.githubPullRequestQueueExit.create({
      data: {
        pullRequestId: pr.id,
        deliveryId: 'guid-route-ejected',
        rawReason: 'MERGE_CONFLICT',
        disposition: 'failure',
        headSha: 'c'.repeat(40),
        exitedAt: new Date('2026-09-18T10:00:00.000Z'),
      },
    });

    const res = await repair(card.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemRepairClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('claimed');
    expect(parsed.data?.pullRequests).toEqual([
      expect.objectContaining({
        headRef: 'subtask/ejected',
        ci: 'passing',
        queueExit: {
          rawReason: 'MERGE_CONFLICT',
          exitedAt: '2026-09-18T10:00:00.000Z',
          headSha: 'c'.repeat(40),
          failingCheckName: null,
          failingCheckUrl: null,
        },
      }),
    ]);
  });

  it('a refusal is a 200 with its reason — and a card at a status no workflow defines is not_implemented, not a 404', async () => {
    // `createTestWorkItem` leaves the row at the column's legacy `open` default.
    const orphan = await createTestWorkItem(caller.fixture, {
      kind: 'task',
      title: 'Off-workflow',
    });

    const res = await repair(orphan.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemRepairClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data).toMatchObject({ outcome: 'not_repairable', reason: 'not_implemented' });
  });

  it('a second call by the same caller is `mine` at 200', async () => {
    const card = await redCard(caller.fixture, 'Resume me');
    const first = (await (await repair(card.identifier, caller)).json()) as { runId: string };

    const res = await repair(card.identifier, caller);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'mine', runId: first.runId });
  });

  it('a MALFORMED key is 422', async () => {
    const res = await repair('not-a-key', caller);
    expect(res.status).toBe(422);
  });

  it('a key in ANOTHER workspace is 404, and nothing is claimed on the way', async () => {
    const other = await createV1ProjectCaller({
      workspaceName: 'Rival Co',
      identifier: 'ZZZ',
      scopes: ['read', 'work_items:write'],
    });
    const theirs = await redCard(other.fixture, 'Private');

    expect((await repair(theirs.identifier, caller)).status).toBe(404);
    await expect((await repair(theirs.identifier, other)).json()).resolves.toMatchObject({
      outcome: 'claimed',
    });
  });

  it('a token WITHOUT the declared permission is refused before anything is read', async () => {
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });
    const card = await redCard(readOnly.fixture, 'Read only');

    expect((await repair(card.identifier, readOnly)).status).toBe(403);
  });

  it('the declared operation names the permission the route enforces', () => {
    const operation = findV1Operation('POST', '/api/v1/work-items/{key}/repair');
    expect(operation?.permission).toBe('work_item:edit');
    expect(operation?.operationId).toBe('claimWorkItemRepair');
  });
});
