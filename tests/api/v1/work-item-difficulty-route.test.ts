import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET, PATCH } from '@/app/api/v1/work-items/[key]/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema, type WorkItemDetail } from '@/lib/api/v1/workItems/schema';
import { db } from '@/lib/db';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A leaf's DIFFICULTY over `/api/v1` (Story MOTIR-6016 · MOTIR-6098), end to end
// through `withV1Route` against real Postgres: create / read / clear on a leaf,
// the typed 422 on a container from both write doors, and a value outside the
// scale refused by the schema rather than surfacing as a 500.

const BASE = 'http://localhost:3000/api/v1';
const EDITOR = ['project:browse', 'work_item:edit'] as const;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function create(caller: V1ProjectCaller, body: unknown): Promise<Response> {
  return POST(
    new Request(`${BASE}/projects/${caller.projectKey}/work-items`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectKey: caller.projectKey }) },
  );
}

function update(caller: V1ProjectCaller, key: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`${BASE}/work-items/${key}`, {
      method: 'PATCH',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

function read(caller: V1ProjectCaller, key: string): Promise<Response> {
  return GET(new Request(`${BASE}/work-items/${key}`, { headers: caller.headers }), {
    params: Promise.resolve({ key }),
  });
}

async function detail(res: Response, status = 200): Promise<WorkItemDetail> {
  const body: unknown = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return workItemDetailSchema.parse(body);
}

async function refusal(res: Response): Promise<{ status: number; code: string }> {
  const body = (await res.json()) as { code: string };
  return { status: res.status, code: body.code };
}

async function story(caller: V1ProjectCaller): Promise<WorkItemDetail> {
  return detail(await create(caller, { kind: 'story', title: 'The story' }), 201);
}

describe('difficulty on a leaf', () => {
  it('POST a subtask with medium → 201 carrying it; GET reads it; PATCH null clears it', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const parent = await story(caller);

    const created = await detail(
      await create(caller, {
        kind: 'subtask',
        title: 'Reorder the lock acquisition',
        parentKey: parent.key,
        difficulty: 'medium',
      }),
      201,
    );
    expect(created.difficulty).toBe('medium');

    expect((await detail(await read(caller, created.key))).difficulty).toBe('medium');

    const cleared = await detail(await update(caller, created.key, { difficulty: null }));
    expect(cleared.difficulty).toBeNull();
    expect((await detail(await read(caller, created.key))).difficulty).toBeNull();
  });

  it('PATCH changes one value to another, and an item created without one reads null', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const task = await detail(await create(caller, { kind: 'task', title: 'Plain' }), 201);
    expect(task.difficulty).toBeNull();
    const changed = await detail(await update(caller, task.key, { difficulty: 'high' }));
    expect(changed.difficulty).toBe('high');
  });
});

describe('difficulty refusals', () => {
  it('POST a story or an epic with a difficulty is a 422 DIFFICULTY_NOT_ALLOWED_ON_KIND', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    for (const kind of ['story', 'epic']) {
      expect(await refusal(await create(caller, { kind, title: 'C', difficulty: 'low' }))).toEqual({
        status: 422,
        code: 'DIFFICULTY_NOT_ALLOWED_ON_KIND',
      });
    }
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('PATCH a story with a difficulty is the same 422, and changes nothing', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const parent = await story(caller);
    expect(await refusal(await update(caller, parent.key, { difficulty: 'low' }))).toEqual({
      status: 422,
      code: 'DIFFICULTY_NOT_ALLOWED_ON_KIND',
    });
    expect((await detail(await read(caller, parent.key))).difficulty).toBeNull();
  });

  it('a value outside the scale is refused by the schema, never a 500', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const res = await create(caller, { kind: 'task', title: 'T', difficulty: 'extreme' });
    expect([400, 422]).toContain(res.status);
    expect(await adminDb.workItem.count()).toBe(0);
  });
});
