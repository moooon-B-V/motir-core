import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemClaimSchema } from '@/lib/api/v1/workLoop/schema';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// POST /api/v1/work-items/{key}/claim (MOTIR-2961) — the atomic keyed claim.
//
// The route's own contract is what is asserted here: the resource PARSES against
// its declared schema (so a mapper that drifts fails before a client sees it),
// the four outcomes come back as 200s rather than error statuses, the permission
// is the one the operation declares, and a cross-workspace key is refused
// exactly as `GET …/work-items/{key}` refuses it. The LOCK itself — including
// the real-concurrency property — is asserted one layer down, in
// `tests/ready/claimWorkItem.test.ts`, against the service that owns it.

const BASE = 'http://localhost:3000/api/v1/work-items';

async function claim(key: string, caller: { headers: Record<string, string> }): Promise<Response> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/claim/route');
  return POST(
    new Request(`${BASE}/${encodeURIComponent(key)}/claim`, {
      method: 'POST',
      headers: caller.headers,
    }),
    { params: Promise.resolve({ key }) },
  );
}

/** Seed through the REAL create path, so the item lands at the workflow's
 *  INITIAL status. `createTestWorkItem` writes the row through the repository
 *  and inherits the column's legacy `"open"` default, which no workflow defines
 *  — useful for exactly one case below, and wrong for every other. */
async function seed(fixture: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title, assigneeId: null, descriptionMd: null },
    fixture.ctx,
  );
}

describe('POST /api/v1/work-items/{key}/claim', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('claims a to-do item and the body PARSES against the declared schema', async () => {
    const item = await seed(caller.fixture, 'Claim me');

    const res = await claim(item.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('claimed');
    expect(parsed.data?.claimed).toBe(true);
    expect(parsed.data?.key).toBe(item.identifier);
    expect(parsed.data?.status).toEqual({ key: 'in_progress', category: 'in_progress' });
    expect(parsed.data?.assignee?.id).toBe(caller.fixture.ownerId);
  });

  it('is CASE-INSENSITIVE on the key, like every other Motir surface', async () => {
    const item = await seed(caller.fixture, 'Lowercased');

    const res = await claim(item.identifier.toLowerCase(), caller);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ key: item.identifier, claimed: true });
  });

  it('a SECOND call by the same caller is `mine` at 200 — a resume, not a failure', async () => {
    const item = await seed(caller.fixture, 'Resume me');

    expect((await claim(item.identifier, caller)).status).toBe(200);
    const res = await claim(item.identifier, caller);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'mine', claimed: false });
  });

  it('a finished card is `not_claimable` at 200 — never a transition error', async () => {
    const item = await seed(caller.fixture, 'Shipped');
    for (const hop of ['in_progress', 'in_review', 'done']) {
      await workItemsService.updateStatus(item.id, hop, caller.ctx);
    }

    const res = await claim(item.identifier, caller);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; status: { key: string } };
    expect(body.outcome).toBe('not_claimable');
    expect(body.status.key).toBe('done');
  });

  it('a MALFORMED key is 422 before any read', async () => {
    const res = await claim('not-a-key', caller);
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_WORK_ITEM_KEY' });
  });

  it('an UNKNOWN key in this project is 404', async () => {
    const res = await claim(`${caller.projectKey}-9999`, caller);
    expect(res.status).toBe(404);
  });

  it('a key in ANOTHER workspace is 404, not 403 — no existence oracle', async () => {
    const other = await createV1ProjectCaller({
      workspaceName: 'Rival Co',
      identifier: 'ZZZ',
      scopes: ['read', 'work_items:write'],
    });
    const theirs = await seed(other.fixture, 'Private');

    const res = await claim(theirs.identifier, caller);

    expect(res.status).toBe(404);
    // And nothing was claimed on the way to the refusal.
    const still = await claim(theirs.identifier, other);
    await expect(still.json()).resolves.toMatchObject({ outcome: 'claimed' });
  });

  it('a token WITHOUT the declared permission is refused before the write', async () => {
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await seed(readOnly.fixture, 'Read only');

    const res = await claim(item.identifier, readOnly);

    expect(res.status).toBe(403);
  });

  it('an item at a status the workflow does not define is `not_claimable`, NOT a 404', async () => {
    // The `work_item.status` column carries a legacy `"open"` default and
    // `createTestWorkItem` writes the row straight through the repository, so it
    // lands at a status no workflow defines. The claim must report that the card
    // is unavailable — reporting that it does not EXIST would be a 404 for a row
    // sitting in front of the reader, which is what an INNER join on
    // `workflow_status` produces.
    const orphan = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Off-workflow' });

    const res = await claim(orphan.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('not_claimable');
    expect(parsed.data?.status).toEqual({ key: 'open', category: null });
  });

  it('the declared operation names the permission the route enforces', () => {
    // The document may not lie about a permission — the drift guard asserts the
    // same equality over the whole surface; this pins it for THIS route so the
    // failure names the endpoint rather than a list.
    const operation = findV1Operation('POST', '/api/v1/work-items/{key}/claim');
    expect(operation?.permission).toBe('work_item:edit');
    expect(operation?.operationId).toBe('claimWorkItem');
  });
});
