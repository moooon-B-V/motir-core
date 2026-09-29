import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as LIST, POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET as READY } from '@/app/api/v1/projects/[projectKey]/ready/leaves/route';
import { GET, PATCH } from '@/app/api/v1/work-items/[key]/route';
import { POST as TRANSITION } from '@/app/api/v1/work-items/[key]/transitions/route';
import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { readyLaneItemSchema, type V1ReadyLaneItem } from '@/lib/api/v1/ready/schema';
import {
  markedCardCannotReopenSchema,
  obsolescenceRequiresFinishedSchema,
  workItemDetailSchema,
  workItemSummarySchema,
  type WorkItemDetail,
  type WorkItemSummary,
} from '@/lib/api/v1/workItems/schema';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  InvalidObsolescenceError,
  MarkedCardCannotReopenError,
  ObsolescenceRequiresFinishedError,
} from '@/lib/workItems/errors';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A work item's OBSOLESCENCE mark over `/api/v1` (Story MOTIR-6574 · MOTIR-6581),
// end to end through `withV1Route` against real Postgres: every read that carries
// the item — the detail, the collection row, the ready row — returns both fields;
// both writes set, change and clear them on ANY kind of FINISHED card (a `done`
// story and a `done` subtask are the two named cases); a value outside the enum is a
// 422 naming `INVALID_OBSOLESCENCE` whichever check catches it; and — MOTIR-6673 —
// a mark on an unfinished card and a reopen of a marked one are typed 422s.

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

function transition(caller: V1ProjectCaller, key: string, status: string): Promise<Response> {
  return TRANSITION(
    new Request(`${BASE}/work-items/${key}/transitions`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
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

async function readySet(caller: V1ProjectCaller): Promise<V1ReadyLaneItem[]> {
  const res = await READY(
    new Request(`${BASE}/projects/${caller.projectKey}/ready/leaves`, {
      headers: caller.headers,
    }),
    projectParams(caller),
  );
  const body = (await res.json()) as { items: unknown[] };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.items.map((row) => readyLaneItemSchema.parse(row));
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
    // A mark is a FINISHED card's state (MOTIR-6672): finish it, then mark it.
    const created = await detail(await create(caller, { kind: 'task', title: 'Marked' }), 201);
    await markDone(caller, created.key);
    const marked = await detail(
      await update(caller, created.key, {
        obsolescence: 'outdated',
        obsolescenceNoteMd: 'The flow moved to **MOTIR-9**.',
      }),
    );
    const plain = await detail(await create(caller, { kind: 'task', title: 'Plain' }), 201);

    const rows = await collection(caller);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get(marked.key)).toMatchObject({
      obsolescence: 'outdated',
      obsolescenceNoteMd: 'The flow moved to **MOTIR-9**.',
    });
    expect(byKey.get(plain.key)).toMatchObject({ obsolescence: null, obsolescenceNoteMd: null });

    // The ready set carries both fields on every row it returns. (A marked card is
    // finished, so it is never in the ready set — MOTIR-6672.)
    const ready = await readySet(caller);
    const readyByKey = new Map(ready.map((row) => [row.key, row]));
    expect(readyByKey.has(marked.key)).toBe(false);
    expect(readyByKey.get(plain.key)).toMatchObject({
      obsolescence: null,
      obsolescenceNoteMd: null,
    });
  });
});

describe('the writes set, change and clear the mark on any kind of FINISHED card', () => {
  it('a `done` subtask: PATCH sets it, GET reads it, PATCH changes it, PATCH null clears it', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const story = await detail(await create(caller, { kind: 'story', title: 'S' }), 201);

    const subtask = await detail(
      await create(caller, { kind: 'subtask', title: 'Reorder the lock', parentKey: story.key }),
      201,
    );
    await markDone(caller, subtask.key);
    const created = await detail(
      await update(caller, subtask.key, {
        obsolescence: 'outdated',
        obsolescenceNoteMd: 'Rewritten by the new scheduler.',
      }),
    );
    expect(created.status).toBe('done');
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

  it('PATCH accepts the mark on a finished story (no kind refusal, unlike difficulty)', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const created = await detail(await create(caller, { kind: 'story', title: 'S' }), 201);
    await markDone(caller, created.key);
    const story = await detail(await update(caller, created.key, { obsolescence: 'outdated' }));
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
    const task = await detail(await create(caller, { kind: 'task', title: 'T' }), 201);
    await markDone(caller, task.key);
    await update(caller, task.key, { obsolescence: 'outdated' });
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

// ── MOTIR-6672 · MOTIR-6673 — a mark is a FINISHED card's state ────────────────

describe('the finished-card refusals are typed 422s with their payload', () => {
  it('POST with a mark on the unfinished initial status: OBSOLESCENCE_REQUIRES_FINISHED, nothing written', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const res = await create(caller, { kind: 'task', title: 'T', obsolescence: 'outdated' });
    expect(res.status).toBe(422);
    const body = obsolescenceRequiresFinishedSchema.parse(await res.json());
    expect(body.item).toMatchObject({ statusKey: 'todo', statusCategory: 'todo' });
    expect(body.error).toContain('archived, not marked');
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('PATCH setting either mark on a `todo` card: 422 with the key and status; on a `done` card: 200', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const task = await detail(await create(caller, { kind: 'task', title: 'T' }), 201);
    for (const mark of ['outdated', 'deprecated']) {
      const res = await update(caller, task.key, { obsolescence: mark });
      expect(res.status).toBe(422);
      const body = obsolescenceRequiresFinishedSchema.parse(await res.json());
      expect(body.item).toEqual({ key: task.key, statusKey: 'todo', statusCategory: 'todo' });
    }
    // Clearing is legal on any status.
    expect((await update(caller, task.key, { obsolescence: null })).status).toBe(200);

    await markDone(caller, task.key);
    expect(
      (await detail(await update(caller, task.key, { obsolescence: 'outdated' }))).obsolescence,
    ).toBe('outdated');
  });

  it('transitions of a marked `done` card: to `todo` is 422 MARKED_CARD_CANNOT_REOPEN; to `cancelled` is 200', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const task = await detail(await create(caller, { kind: 'task', title: 'T' }), 201);
    await markDone(caller, task.key);
    await update(caller, task.key, { obsolescence: 'deprecated' });

    const refused = await transition(caller, task.key, 'in_progress');
    expect(refused.status).toBe(422);
    const body = markedCardCannotReopenSchema.parse(await refused.json());
    expect(body.mark).toEqual({
      key: task.key,
      obsolescence: 'deprecated',
      toStatusKey: 'in_progress',
    });
    expect(body.error).toContain('clear the mark to reopen this item');

    // A move within the done category is not a reopen. The default workflow draws
    // no `done → cancelled` edge, so the edge refusal answers — NOT the mark's.
    const within = await transition(caller, task.key, 'cancelled');
    expect(((await within.json()) as { code: string }).code).not.toBe('MARKED_CARD_CANNOT_REOPEN');

    // Clear the mark, then the same move goes through.
    await update(caller, task.key, { obsolescence: null });
    expect((await transition(caller, task.key, 'in_progress')).status).toBe(200);
  });

  it('a child under a marked parent — POST and a re-parenting PATCH — is 422 MARKED_CARD_CANNOT_REOPEN', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const story = await detail(await create(caller, { kind: 'story', title: 'S' }), 201);
    await markDone(caller, story.key);
    await update(caller, story.key, { obsolescence: 'outdated' });

    const created = await create(caller, { kind: 'subtask', title: 'ST', parentKey: story.key });
    expect(created.status).toBe(422);
    expect(markedCardCannotReopenSchema.parse(await created.json()).mark).toEqual({
      key: story.key,
      obsolescence: 'outdated',
      toStatusKey: null,
    });

    const task = await detail(await create(caller, { kind: 'task', title: 'T' }), 201);
    const moved = await update(caller, task.key, { parentKey: story.key });
    expect(moved.status).toBe(422);
    expect(markedCardCannotReopenSchema.parse(await moved.json()).mark.key).toBe(story.key);
  });

  it('both service errors map to the typed 422 with their payload — never a 500', () => {
    expect(
      classifyApiV1Error(
        new ObsolescenceRequiresFinishedError({
          key: 'P-1',
          statusKey: 'todo',
          statusCategory: 'todo',
        }),
      ),
    ).toEqual({
      status: 422,
      body: {
        code: 'OBSOLESCENCE_REQUIRES_FINISHED',
        error: expect.any(String) as string,
        item: { key: 'P-1', statusKey: 'todo', statusCategory: 'todo' },
      },
    });
    expect(
      classifyApiV1Error(
        new MarkedCardCannotReopenError({
          key: 'P-1',
          obsolescence: 'outdated',
          toStatusKey: 'todo',
        }),
      ),
    ).toEqual({
      status: 422,
      body: {
        code: 'MARKED_CARD_CANNOT_REOPEN',
        error: expect.any(String) as string,
        mark: { key: 'P-1', obsolescence: 'outdated', toStatusKey: 'todo' },
      },
    });
  });
});
