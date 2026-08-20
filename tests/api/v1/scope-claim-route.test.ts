import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { scopeClaimSchema } from '@/lib/api/v1/workLoop/schema';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/scope-claims (MOTIR-3049) — the atomic SCOPE claim.
//
// The route's own contract is what is asserted here: the resource PARSES against
// its declared schema (so a mapper that drifts fails before a client sees it),
// BOTH body arms reach the right scope, every refusal is a 200 with an
// `outcome` rather than an error status, the permission is the one the operation
// declares, and a cross-workspace key is refused exactly as
// `GET …/work-items/{key}` refuses it. The LOCK itself — the all-or-nothing
// rollback and the real-concurrency property — is asserted one layer down, in
// `tests/ready/claimScope.test.ts`, against the service that owns it.

const URL = 'http://localhost:3000/api/v1/scope-claims';

async function claimScope(
  body: unknown,
  caller: { headers: Record<string, string> },
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/scope-claims/route');
  return POST(
    new Request(URL, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

async function seed(
  fixture: WorkItemFixture,
  title: string,
  opts: { kind?: 'story' | 'task' | 'subtask'; parentId?: string } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: fixture.projectId,
      kind: opts.kind ?? 'subtask',
      title,
      assigneeId: null,
      descriptionMd: null,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fixture.ctx,
  );
}

async function seedStory(caller: V1ProjectCaller, children = 2) {
  const story = await seed(caller.fixture, 'A runnable story', { kind: 'story' });
  const kids = [];
  for (let i = 0; i < children; i++) {
    kids.push(await seed(caller.fixture, `child ${i + 1}`, { parentId: story.id }));
  }
  return { story, kids };
}

describe('POST /api/v1/scope-claims', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('claims a WORK-ITEM scope and the body PARSES against the declared schema', async () => {
    const { story, kids } = await seedStory(caller, 3);

    const res = await claimScope({ kind: 'work_item', key: story.identifier }, caller);

    expect(res.status).toBe(200);
    const parsed = scopeClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('claimed');
    expect(parsed.data?.claimed).toBe(true);
    expect(parsed.data?.scope.kind).toBe('work_item');
    expect(parsed.data?.scope.key).toBe(story.identifier);
    expect(parsed.data?.members.map((m) => m.key).sort()).toEqual(
      [story, ...kids].map((i) => i.identifier).sort(),
    );
  });

  it('claims the project’s ACTIVE SPRINT through the other body arm', async () => {
    const item = await seed(caller.fixture, 'in the sprint', { kind: 'task' });
    const sprint = await sprintsService.createSprint(
      caller.fixture.projectId,
      { name: 'Sprint one' },
      caller.ctx,
    );
    await backlogService.bulkAssignToSprint([item.id], sprint.id, caller.ctx);
    await sprintsService.startSprint(sprint.id, {}, caller.ctx);

    const res = await claimScope({ kind: 'sprint', projectKey: caller.projectKey }, caller);

    expect(res.status).toBe(200);
    const parsed = scopeClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('claimed');
    expect(parsed.data?.scope).toMatchObject({
      kind: 'sprint',
      key: null,
      sprintId: sprint.id,
      name: 'Sprint one',
    });
    expect(parsed.data?.members.map((m) => m.key)).toEqual([item.identifier]);
  });

  it('is CASE-INSENSITIVE on the key, like every other Motir surface', async () => {
    const { story } = await seedStory(caller, 1);

    const res = await claimScope(
      { kind: 'work_item', key: story.identifier.toLowerCase() },
      caller,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ claimed: true });
  });

  it('a REFUSED claim is a 200 with an outcome, not an error status', async () => {
    const { story, kids } = await seedStory(caller, 2);
    for (const hop of ['in_progress', 'in_review']) {
      await workItemsService.updateStatus(kids[0]!.id, hop, caller.ctx);
    }

    const res = await claimScope({ kind: 'work_item', key: story.identifier }, caller);

    expect(res.status).toBe(200);
    const parsed = scopeClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('not_claimable');
    expect(parsed.data?.claimed).toBe(false);
    expect(parsed.data?.members).toEqual([]);
    expect(parsed.data?.offender?.key).toBe(kids[0]!.identifier);
  });

  it('an ASSIGNED holder is named on the refusal, not just the transition actor', async () => {
    // `assignee` and `transitionedBy` are separate fields because either can be
    // the only one that answers. The case above leaves the offender unassigned;
    // this is the other half, so the mapper's populated arm is exercised too.
    const { story, kids } = await seedStory(caller, 2);
    await workItemsService.claimWorkItem(caller.fixture.projectId, kids[0]!.identifier, caller.ctx);

    const res = await claimScope({ kind: 'work_item', key: story.identifier }, caller);

    expect(res.status).toBe(200);
    const parsed = scopeClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('mine');
    expect(parsed.data?.offender?.assignee?.id).toBe(caller.fixture.ownerId);
    expect(parsed.data?.offender?.transitionedBy?.id).toBe(caller.fixture.ownerId);
  });

  it('an UNFINISHABLE scope is a 200 carrying the blockers that gate it', async () => {
    const { story, kids } = await seedStory(caller, 2);
    const outsider = await seed(caller.fixture, 'work outside the scope', { kind: 'task' });
    await workItemsService.linkWorkItems(
      { fromId: kids[0]!.id, toId: outsider.id, kind: 'is_blocked_by' },
      caller.ctx,
    );

    const res = await claimScope({ kind: 'work_item', key: story.identifier }, caller);

    expect(res.status).toBe(200);
    const parsed = scopeClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('not_finishable');
    expect(parsed.data?.blockers).toContainEqual(
      expect.objectContaining({ item: kids[0]!.identifier, blockedBy: outsider.identifier }),
    );
  });

  it('a WRONG-SHAPE scope is a 200 naming the offending child, so the caller can re-plan', async () => {
    const story = await seed(caller.fixture, 'Two layers', { kind: 'story' });
    const container = await seed(caller.fixture, 'A task with children', {
      kind: 'task',
      parentId: story.id,
    });
    await seed(caller.fixture, 'grandchild', { parentId: container.id });

    const res = await claimScope({ kind: 'work_item', key: story.identifier }, caller);

    expect(res.status).toBe(200);
    const parsed = scopeClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('wrong_shape');
    expect(parsed.data?.shape).toEqual({
      child: container.identifier,
      childTitle: 'A task with children',
      depth: 2,
    });
  });

  it('a project with NO active sprint is 409, not a silently empty claim', async () => {
    const res = await claimScope({ kind: 'sprint', projectKey: caller.projectKey }, caller);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'NO_ACTIVE_SPRINT' });
  });

  it('a MALFORMED body is 422 before any read', async () => {
    const res = await claimScope({ kind: 'nonsense', key: 'PROD-1' }, caller);
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_BODY' });
  });

  it('a MALFORMED key is 422 before any read', async () => {
    const res = await claimScope({ kind: 'work_item', key: 'not-a-key' }, caller);
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_WORK_ITEM_KEY' });
  });

  it('an UNKNOWN key in this project is 404', async () => {
    const res = await claimScope({ kind: 'work_item', key: `${caller.projectKey}-9999` }, caller);
    expect(res.status).toBe(404);
  });

  it('a key in ANOTHER workspace is 404, not 403 — no existence oracle', async () => {
    const other = await createV1ProjectCaller({
      workspaceName: 'Rival Co',
      identifier: 'ZZZ',
      scopes: ['read', 'work_items:write'],
    });
    const theirs = await seed(other.fixture, 'Private', { kind: 'task' });

    const res = await claimScope({ kind: 'work_item', key: theirs.identifier }, caller);

    expect(res.status).toBe(404);
    // And nothing was claimed on the way to the refusal.
    const still = await claimScope({ kind: 'work_item', key: theirs.identifier }, other);
    await expect(still.json()).resolves.toMatchObject({ outcome: 'claimed' });
  });

  it('a PROJECT key in another workspace is 404 too, through the sprint arm', async () => {
    const other = await createV1ProjectCaller({
      workspaceName: 'Rival Co',
      identifier: 'ZZZ',
      scopes: ['read', 'work_items:write'],
    });

    const res = await claimScope({ kind: 'sprint', projectKey: other.projectKey }, caller);

    expect(res.status).toBe(404);
  });

  it('a token WITHOUT the declared permission is refused before the write', async () => {
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await seed(readOnly.fixture, 'Read only', { kind: 'task' });

    const res = await claimScope({ kind: 'work_item', key: item.identifier }, readOnly);

    expect(res.status).toBe(403);
  });

  it('the declared operation names the permission the route enforces', () => {
    // The document may not lie about a permission — the drift guard asserts the
    // same equality over the whole surface; this pins it for THIS route so the
    // failure names the endpoint rather than a list.
    const operation = findV1Operation('POST', '/api/v1/scope-claims');
    expect(operation?.permission).toBe('work_item:edit');
    expect(operation?.operationId).toBe('claimScope');
  });
});
