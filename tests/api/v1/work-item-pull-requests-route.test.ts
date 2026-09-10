import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { linkedPullRequestSchema } from '@/lib/api/v1/workItems/schema';
import { resolveCoordinate } from '@/lib/github/pullRequestCoordinate';
import { resolveCoordinate as resolveCoordinateViaMcp } from '@/lib/mcp/tools/linkPullRequest';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { connectAndLinkRepo } from '../../fixtures/codeContextFixtures';
import { truncateAuthTables } from '../../helpers/db';
import { adminDb } from '../../helpers/adminDb';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// POST /api/v1/work-items/{key}/pull-requests (Task MOTIR-5048) — the v1 door
// onto the delivery link.
//
// The route's own contract is what is asserted here: the resource PARSES against
// its declared schema, the two ADDRESS forms resolve to one row, the SET
// semantics survive the port, and the refusals are the ones the operation
// declares. The lock, the upsert and the tenancy read are asserted one layer
// down against the service that owns them (`tests/mcp/linkPullRequest.test.ts`).
//
// ⚠️ THE SET CASE IS THE ONE A HAPPY-PATH TEST MISSES, and it is the property a
// caller is likeliest to assume away: a second link naming a DIFFERENT work item
// ADDS a delivery rather than moving the first. An implementation that moved the
// link would satisfy every other assertion in this file.

const BASE = 'http://localhost:3000/api/v1/work-items';

async function link(
  key: string,
  body: unknown,
  caller: { headers: Record<string, string> },
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/pull-requests/route');
  return POST(
    new Request(`${BASE}/${encodeURIComponent(key)}/pull-requests`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function seed(fixture: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title, assigneeId: null, descriptionMd: null },
    fixture.ctx,
  );
}

const REFS = { headRef: 'subtask/PROD-1-widget', baseRef: 'main' };

/**
 * The work items a pull request DELIVERS, addressed the way a caller of this
 * route addresses it — `owner/name` + number rather than Motir's internal cuid.
 *
 * `helpers/prLink`'s `deliveredItemIds` takes that cuid, which the route
 * deliberately never puts on the wire (§7), so the test resolves the row itself
 * rather than reaching for an id the operation under test refuses to hand out.
 */
async function deliveredBy(repoRef: string, number: number): Promise<string[]> {
  const [owner, name] = repoRef.split('/');
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({
    where: { number, repo: { owner, name } },
    select: { id: true },
  });
  const rows = await adminDb.workItemDelivery.findMany({
    where: { githubPullRequestId: pr.id },
    orderBy: { createdAt: 'asc' },
    select: { workItemId: true },
  });
  return rows.map((r) => r.workItemId);
}

describe('POST /api/v1/work-items/{key}/pull-requests', () => {
  let caller: V1ProjectCaller;
  let repoRef: string;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    ({ repoRef } = await connectAndLinkRepo(caller.fixture));
  });

  it('links by repository + number, and the body PARSES against the declared schema', async () => {
    const item = await seed(caller.fixture, 'Deliver me');

    const res = await link(item.identifier, { repository: repoRef, number: 2291, ...REFS }, caller);

    expect(res.status).toBe(200);
    const parsed = linkedPullRequestSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.key).toBe(item.identifier);
    expect(parsed.data?.pullRequest.repo).toBe(repoRef);
    expect(parsed.data?.pullRequest.number).toBe(2291);
    // The case the operation exists for: no webhook delivery had arrived, so THIS
    // call is what wrote the pull-request row.
    expect(parsed.data?.created).toBe(true);
  });

  it('links BEFORE any delivery, and the work item is actually recorded as delivered', async () => {
    const item = await seed(caller.fixture, 'Pre-delivery');

    await link(item.identifier, { repository: repoRef, number: 4242, ...REFS }, caller);

    // Asserted on the DELIVERY table rather than on the response: a route that
    // shaped a convincing body and wrote nothing would pass the case above.
    const delivered = await deliveredBy(repoRef, 4242);
    expect(delivered).toContain(item.id);
  });

  it('the `url` form resolves to the SAME row as repository + number', async () => {
    const first = await seed(caller.fixture, 'By pair');
    const second = await seed(caller.fixture, 'By url');

    await link(first.identifier, { repository: repoRef, number: 77, ...REFS }, caller);
    const res = await link(
      second.identifier,
      { url: `https://github.com/${repoRef}/pull/77`, ...REFS },
      caller,
    );

    expect(res.status).toBe(200);
    // The SECOND call found the row the first created — one pull request, not two.
    await expect(res.json()).resolves.toMatchObject({ created: false });
    const delivered = await deliveredBy(repoRef, 77);
    expect(delivered).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('ONE resolution path — the v1 route and the MCP tool share the parser', () => {
    // Not a style assertion: two doors that disagree about what `url` means link
    // the WRONG pull request under a 200. The MCP tool re-exports the extracted
    // module, so this compares identity rather than behaviour on a sample.
    expect(resolveCoordinate).toBe(resolveCoordinateViaMcp);
  });

  it('ADDS a delivery — a second work item does not MOVE the first', async () => {
    const first = await seed(caller.fixture, 'First');
    const second = await seed(caller.fixture, 'Second');

    await link(first.identifier, { repository: repoRef, number: 9001, ...REFS }, caller);
    await link(second.identifier, { repository: repoRef, number: 9001, ...REFS }, caller);

    const delivered = await deliveredBy(repoRef, 9001);
    expect(delivered).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(delivered).toHaveLength(2);
  });

  it('is IDEMPOTENT — the same link twice writes ONE delivery', async () => {
    const item = await seed(caller.fixture, 'Twice');

    await link(item.identifier, { repository: repoRef, number: 5150, ...REFS }, caller);
    const res = await link(item.identifier, { repository: repoRef, number: 5150, ...REFS }, caller);

    expect(res.status).toBe(200);
    // Asserted by ROW COUNT, not by value: a duplicated row would still read back
    // as a correct-looking link.
    expect(await deliveredBy(repoRef, 5150)).toHaveLength(1);
  });

  it('two addresses that DISAGREE are 422, never a silent pick', async () => {
    const item = await seed(caller.fixture, 'Ambiguous');

    const res = await link(
      item.identifier,
      { repository: repoRef, number: 1, url: `https://github.com/${repoRef}/pull/2`, ...REFS },
      caller,
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_BODY' });
  });

  it('an unparseable `url` is 422 BEFORE the item is read', async () => {
    // The key names nothing, so a route that resolved the item first would answer
    // 404 and hide which argument is wrong.
    const res = await link(`${caller.projectKey}-9999`, { url: 'not-a-url', ...REFS }, caller);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_BODY' });
  });

  it('NEITHER address form is 422', async () => {
    const item = await seed(caller.fixture, 'No address');
    const res = await link(item.identifier, REFS, caller);
    expect(res.status).toBe(422);
  });

  it('a MALFORMED key is 422', async () => {
    const res = await link('not-a-key', { repository: repoRef, number: 3, ...REFS }, caller);
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_WORK_ITEM_KEY' });
  });

  it('an UNKNOWN key is 404', async () => {
    const res = await link(
      `${caller.projectKey}-9999`,
      { repository: repoRef, number: 3, ...REFS },
      caller,
    );
    expect(res.status).toBe(404);
  });

  it('a repository OUTSIDE this workspace is 404 — no existence oracle', async () => {
    const item = await seed(caller.fixture, 'Foreign repo');

    const res = await link(
      item.identifier,
      { repository: 'rival/secret', number: 1, ...REFS },
      caller,
    );

    expect(res.status).toBe(404);
  });

  it('a key in ANOTHER workspace is 404, not 403', async () => {
    const other = await createV1ProjectCaller({
      workspaceName: 'Rival Co',
      identifier: 'ZZZ',
      scopes: ['read', 'work_items:write'],
    });
    const theirs = await seed(other.fixture, 'Private');

    const res = await link(theirs.identifier, { repository: repoRef, number: 8, ...REFS }, caller);

    expect(res.status).toBe(404);
  });

  it('a token WITHOUT the declared permission is refused before the write', async () => {
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });
    await connectAndLinkRepo(readOnly.fixture);
    const item = await seed(readOnly.fixture, 'Read only');

    const res = await link(
      item.identifier,
      { repository: `acme/web`, number: 12, ...REFS },
      readOnly,
    );

    expect(res.status).toBe(403);
  });

  it('declares the permission the route actually asserts', () => {
    // The coverage guard compares these across the whole tree; pinning it here
    // too means a change to either side fails in the suite that owns the route.
    const operation = findV1Operation('POST', '/api/v1/work-items/{key}/pull-requests');
    expect(operation).toBeDefined();
    expect(operation?.permission).toBe('work_item:edit');
    expect(operation?.operationId).toBe('linkWorkItemPullRequest');
  });
});
