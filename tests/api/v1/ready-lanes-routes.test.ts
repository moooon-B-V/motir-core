import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as leavesGET } from '@/app/api/v1/projects/[projectKey]/ready/leaves/route';
import { GET as containersGET } from '@/app/api/v1/projects/[projectKey]/ready/containers/route';
import { GET as bugsGET } from '@/app/api/v1/projects/[projectKey]/ready/bugs/route';
import { GET as flatGET } from '@/app/api/v1/projects/[projectKey]/ready/route';
import {
  readyContainerSchema,
  readyLaneItemSchema,
  type V1ReadyContainer,
  type V1ReadyLaneItem,
} from '@/lib/api/v1/ready/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The three ready-LANE operations (Story MOTIR-6829 · MOTIR-6832) against real
// Postgres: each returns its service lane's rows in the service's order, pages
// with a cursor its own lane alone accepts, and maps the service's refusals
// exactly as the flat ready route does.

const BASE = 'http://localhost:3000/api/v1';
type Lane = 'leaves' | 'containers' | 'bugs';
const HANDLERS = { leaves: leavesGET, containers: containersGET, bugs: bugsGET } as const;

function req(caller: V1ProjectCaller, lane: Lane | 'flat', query = ''): Promise<Response> {
  const path = lane === 'flat' ? 'ready' : `ready/${lane}`;
  const handler = lane === 'flat' ? flatGET : HANDLERS[lane];
  return handler(
    new Request(`${BASE}/projects/${caller.projectKey}/${path}${query}`, {
      headers: caller.headers,
    }),
    { params: Promise.resolve({ projectKey: caller.projectKey }) },
  );
}

async function page<T>(caller: V1ProjectCaller, lane: Lane | 'flat', query = '') {
  const res = await req(caller, lane, query);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { items: T[]; nextCursor: string | null };
}

async function item(
  caller: V1ProjectCaller,
  kind: 'epic' | 'story' | 'task' | 'subtask' | 'bug',
  title: string,
  parentId?: string,
) {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    caller.ctx,
  );
}

/** Epic E › story S (three subtasks) and task T; bug B; bug B2 › subtask. */
async function tree(caller: V1ProjectCaller) {
  const E = await item(caller, 'epic', 'E');
  const S = await item(caller, 'story', 'S', E.id);
  const subs = [
    await item(caller, 'subtask', 's1', S.id),
    await item(caller, 'subtask', 's2', S.id),
    await item(caller, 'subtask', 's3', S.id),
  ];
  const T = await item(caller, 'task', 'T', E.id);
  const B = await item(caller, 'bug', 'B');
  const B2 = await item(caller, 'bug', 'B2');
  const b1 = await item(caller, 'subtask', 'b1', B2.id);
  return { E, S, subs, T, B, B2, b1 };
}

describe('GET /api/v1/projects/{projectKey}/ready/{leaves,containers,bugs}', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('serves each lane in its service method’s order, in the published row shapes', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const t = await tree(caller);

    const leaves = await page<V1ReadyLaneItem>(caller, 'leaves');
    const svcLeaves = await workItemsService.listReadyLeaves(
      caller.fixture.projectId,
      {},
      caller.ctx,
    );
    expect(leaves.items.map((i) => i.key)).toEqual(svcLeaves.items.map((i) => i.key));
    for (const row of leaves.items) expect(() => readyLaneItemSchema.parse(row)).not.toThrow();
    expect(leaves.items.find((i) => i.key === t.subs[0]!.identifier)?.container?.key).toBe(
      t.S.identifier,
    );
    expect(leaves.items.find((i) => i.key === t.T.identifier)?.container).toBeNull();
    // Every row carries the edge block, as the flat ready row does.
    expect(leaves.items[0]!.dependencies).toEqual({ blockedBy: [], blocks: [] });

    const containers = await page<V1ReadyContainer>(caller, 'containers');
    expect(containers.items.map((c) => c.key)).toEqual([t.S.identifier]);
    expect(() => readyContainerSchema.parse(containers.items[0])).not.toThrow();
    expect(containers.items[0]).toMatchObject({ readyLeafCount: 3, childCount: 3, kind: 'story' });

    const bugs = await page<V1ReadyLaneItem>(caller, 'bugs');
    expect(bugs.items.map((i) => i.key).sort()).toEqual([t.B.identifier, t.b1.identifier].sort());
    expect(bugs.items.find((i) => i.key === t.b1.identifier)?.container?.key).toBe(t.B2.identifier);

    // The partition: leaves ∪ bugs is exactly the flat ready set.
    const flat = await page<{ key: string }>(caller, 'flat');
    expect([...leaves.items, ...bugs.items].map((i) => i.key).sort()).toEqual(
      flat.items.map((i) => i.key).sort(),
    );
  });

  it('pages each lane with limit=1 through the same sequence as one read', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await tree(caller);
    await item(caller, 'story', 'S2');
    for (const lane of ['leaves', 'containers', 'bugs'] as const) {
      const whole = await page<{ key: string }>(caller, lane);
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const p: { items: { key: string }[]; nextCursor: string | null } = await page(
          caller,
          lane,
          `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        walked.push(...p.items.map((i) => i.key));
        cursor = p.nextCursor;
        if (!cursor) break;
      }
      expect(walked, lane).toEqual(whole.items.map((i) => i.key));
    }
  });

  it('refuses a cursor from another lane, and maps the filter refusals', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await tree(caller);
    const first = await page<{ key: string }>(caller, 'leaves', '?limit=1');
    expect(first.nextCursor).not.toBeNull();

    const foreign = await req(caller, 'bugs', `?cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(foreign.status).toBe(422);
    expect(((await foreign.json()) as { code: string }).code).toBe('INVALID_CURSOR');

    const unknownAncestor = await req(caller, 'leaves', '?ancestor=NOPE-999');
    expect(unknownAncestor.status).toBe(422);
    expect(((await unknownAncestor.json()) as { code: string }).code).toBe('INVALID_READY_FILTER');

    for (const q of ['?kind=epic', '?ancestor=X-1', '?allowSoftBlock=true']) {
      const res = await req(caller, 'containers', q);
      expect(res.status, q).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_READY_FILTER');
    }
    // The container facets it does accept apply to the container.
    expect((await page(caller, 'containers', '?priority=lowest')).items).toEqual([]);
  });

  it('answers an empty project with three empty lanes, and refuses a scopeless token', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const noScope = await createV1ProjectCaller({ scopes: ['integration'] });
    for (const lane of ['leaves', 'containers', 'bugs'] as const) {
      expect(await page(caller, lane)).toEqual({ items: [], nextCursor: null });
      expect((await req(noScope, lane)).status).toBe(403);
    }
  });
});
