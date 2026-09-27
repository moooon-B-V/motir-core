import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as LIST, POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET as READY } from '@/app/api/v1/projects/[projectKey]/ready/route';
import { GET, PATCH } from '@/app/api/v1/work-items/[key]/route';
import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { readyItemSchema, type V1ReadyItem } from '@/lib/api/v1/ready/schema';
import {
  workItemDetailSchema,
  workItemSummarySchema,
  type WorkItemDetail,
  type WorkItemSummary,
} from '@/lib/api/v1/workItems/schema';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { InvalidObsolescenceError } from '@/lib/workItems/errors';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A work item's OBSOLESCENCE mark over `/api/v1` (Story MOTIR-6574 · MOTIR-6581),
// end to end through `withV1Route` against real Postgres: every read that carries
// the item — the detail, the collection row, the ready row — returns both fields;
// both writes set, change and clear them on ANY kind in ANY status (a `done` story
// and a `todo` subtask are the two named cases); and a value outside the enum is a
// 422 naming `INVALID_OBSOLESCENCE` whichever check catches it.

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

function projectParams(caller: V1ProjectCaller) {
  return { params: Promise.resolve({ projectKey: caller.projectKey }) };
}

function create(caller: V1ProjectCaller, body: unknown): Promise<Response> {
  return POST(
    new Request(`${BASE}/projects/${caller.projectKey}/work-items`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    projectParams(caller),
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

async function collection(caller: V1ProjectCaller): Promise<WorkItemSummary[]> {
  const res = await LIST(
    new Request(`${BASE}/projects/${caller.projectKey}/work-items`, { headers: caller.headers }),
    projectParams(caller),
  );
  const body = (await res.json()) as { items: unknown[] };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.items.map((row) => workItemSummarySchema.parse(row));
}

async function readySet(caller: V1ProjectCaller): Promise<V1ReadyItem[]> {
  const res = await READY(
    new Request(`${BASE}/projects/${caller.projectKey}/ready`, { headers: caller.headers }),
    projectParams(caller),
  );
  const body = (await res.json()) as { items: unknown[] };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.items.map((row) => readyItemSchema.parse(row));
}

async function refusal(res: Response): Promise<{ status: number; code: string }> {
  const body = (await res.json()) as { code: string };
  return { status: res.status, code: body.code };
}

/** Walk an item to `done` through the real workflow, as a finished card got there. */
async function markDone(caller: V1ProjectCaller, key: string): Promise<void> {
  const row = await workItemsService.getWorkItemByIdentifier(
    caller.fixture.projectId,
    key,
    caller.ctx,
  );
  for (const status of ['in_progress', 'in_review', 'done']) {
    await workItemsService.updateStatus(row.id, status, caller.ctx);
  }
}

describe('every read carries the mark, null when unset', () => {
  it('GET detail returns both fields as null on every kind', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const epic = await detail(await create(caller, { kind: 'epic', title: 'E' }), 201);
    const story = await detail(
      await create(caller, { kind: 'story', title: 'S', parentKey: epic.key }),
      201,
    );
    const subtask = await detail(
      await create(caller, { kind: 'subtask', title: 'ST', parentKey: story.key }),
      201,
    );
    const task = await detail(await create(caller, { kind: 'task', title: 'T' }), 201);
    const bug = await detail(await create(caller, { kind: 'bug', title: 'B' }), 201);

    for (const created of [epic, story, subtask, task, bug]) {
      const read_ = await detail(await read(caller, created.key));
      expect(read_.kind).toBe(created.kind);
      expect(read_.obsolescence).toBeNull();
      expect(read_.obsolescenceNoteMd).toBeNull();
    }
  });

  it('the collection and the ready set return both fields on each row', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const marked = await detail(
      await create(caller, {
        kind: 'task',
        title: 'Marked',
        obsolescence: 'outdated',
        obsolescenceNoteMd: 'The flow moved to **MOTIR-9**.',
      }),
      201,
    );
    const plain = await detail(await create(caller, { kind: 'task', title: 'Plain' }), 201);

    const rows = await collection(caller);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get(marked.key)).toMatchObject({
      obsolescence: 'outdated',
      obsolescenceNoteMd: 'The flow moved to **MOTIR-9**.',
    });
    expect(byKey.get(plain.key)).toMatchObject({ obsolescence: null, obsolescenceNoteMd: null });

    // A mark does NOT gate readiness: the marked card is still in the set.
    const ready = await readySet(caller);
    const readyByKey = new Map(ready.map((row) => [row.key, row]));
    expect(readyByKey.get(marked.key)).toMatchObject({
      obsolescence: 'outdated',
      obsolescenceNoteMd: 'The flow moved to **MOTIR-9**.',
    });
    expect(readyByKey.get(plain.key)).toMatchObject({
      obsolescence: null,
      obsolescenceNoteMd: null,
    });
  });
});

describe('the writes set, change and clear the mark on any kind in any status', () => {
  it('a `todo` subtask: POST sets it, GET reads it, PATCH changes it, PATCH null clears it', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const story = await detail(await create(caller, { kind: 'story', title: 'S' }), 201);

    const created = await detail(
      await create(caller, {
        kind: 'subtask',
        title: 'Reorder the lock',
        parentKey: story.key,
        obsolescence: 'outdated',
        obsolescenceNoteMd: 'Rewritten by the new scheduler.',
      }),
      201,
    );
    expect(created.status).toBe('todo');
    expect(created.obsolescence).toBe('outdated');
    expect(created.obsolescenceNoteMd).toBe('Rewritten by the new scheduler.');
    expect((await detail(await read(caller, created.key))).obsolescence).toBe('outdated');

    const changed = await detail(await update(caller, created.key, { obsolescence: 'deprecated' }));
    expect(changed.obsolescence).toBe('deprecated');
    // ABSENT leaves the note alone.
    expect(changed.obsolescenceNoteMd).toBe('Rewritten by the new scheduler.');

    const cleared = await detail(
      await update(caller, created.key, { obsolescence: null, obsolescenceNoteMd: null }),
    );
    expect(cleared.obsolescence).toBeNull();
    expect(cleared.obsolescenceNoteMd).toBeNull();
    const reread = await detail(await read(caller, created.key));
    expect(reread.obsolescence).toBeNull();
    expect(reread.obsolescenceNoteMd).toBeNull();
  });

  it('a `done` story accepts the mark via PATCH, and stays done', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const story = await detail(await create(caller, { kind: 'story', title: 'Shipped' }), 201);
    await markDone(caller, story.key);

    const marked = await detail(
      await update(caller, story.key, {
        obsolescence: 'deprecated',
        obsolescenceNoteMd: 'Overturned — do not build on it.',
      }),
    );
    expect(marked.status).toBe('done');
    expect(marked.obsolescence).toBe('deprecated');
    expect(marked.obsolescenceNoteMd).toBe('Overturned — do not build on it.');

    const cleared = await detail(await update(caller, story.key, { obsolescence: null }));
    expect(cleared.status).toBe('done');
    expect(cleared.obsolescence).toBeNull();
    // Clearing the mark does not erase the note — the two are independent.
    expect(cleared.obsolescenceNoteMd).toBe('Overturned — do not build on it.');
  });

  it('POST accepts the mark on a story (no kind refusal, unlike difficulty)', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const story = await detail(
      await create(caller, { kind: 'story', title: 'S', obsolescence: 'outdated' }),
      201,
    );
    expect(story.obsolescence).toBe('outdated');
    expect(story.obsolescenceNoteMd).toBeNull();
  });
});

describe('a value outside the enum is a 422 naming INVALID_OBSOLESCENCE', () => {
  it('on POST — and nothing is written', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    expect(
      await refusal(await create(caller, { kind: 'task', title: 'T', obsolescence: 'stale' })),
    ).toEqual({ status: 422, code: 'INVALID_OBSOLESCENCE' });
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('on PATCH — and the stored mark is unchanged', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const task = await detail(
      await create(caller, { kind: 'task', title: 'T', obsolescence: 'outdated' }),
      201,
    );
    expect(await refusal(await update(caller, task.key, { obsolescence: 'OUTDATED' }))).toEqual({
      status: 422,
      code: 'INVALID_OBSOLESCENCE',
    });
    expect(await refusal(await update(caller, task.key, { obsolescence: 7 }))).toEqual({
      status: 422,
      code: 'INVALID_OBSOLESCENCE',
    });
    expect((await detail(await read(caller, task.key))).obsolescence).toBe('outdated');
  });

  it('a non-string note is refused as the generic body error — only the ENUM is typed', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    expect(
      await refusal(await create(caller, { kind: 'task', title: 'T', obsolescenceNoteMd: 3 })),
    ).toEqual({ status: 422, code: 'INVALID_BODY' });
  });

  it('the SERVICE backstop maps to the same typed 422, never a 500', () => {
    // Over v1 the body schema always refuses first, so the service's own error is
    // unreachable through the route — which is exactly why its mapping is
    // asserted directly: a future path that skips the schema must not 500.
    expect(classifyApiV1Error(new InvalidObsolescenceError('stale'))).toEqual({
      status: 422,
      body: { code: 'INVALID_OBSOLESCENCE', error: expect.stringContaining('stale') as string },
    });
  });
});
