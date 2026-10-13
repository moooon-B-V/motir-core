import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET, PATCH } from '@/app/api/v1/work-items/[key]/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema, type WorkItemDetail } from '@/lib/api/v1/workItems/schema';
import { db } from '@/lib/db';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTENT LANGUAGE over `/api/v1` (Story MOTIR-7731 · MOTIR-8098), end to end
// through `withV1Route` against real Postgres: POST and PATCH accept `language`
// / `languages`, GET returns `languages` (null when none was recorded, never
// `en`), a PATCH re-labels only the field it edits, and a code outside the
// eleven is the schema's `INVALID_BODY` 422 with nothing written.

const BASE = 'http://localhost:3000/api/v1';
const EDITOR = ['project:browse', 'work_item:edit'] as const;

beforeEach(async () => {
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

async function callerIn(language: string): Promise<V1ProjectCaller> {
  const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
  await adminDb.organization.update({
    where: { id: caller.fixture.workspace.organizationId },
    data: { contentLanguage: language },
  });
  return caller;
}

describe('content language over /api/v1', () => {
  it('POST records an explicit language, or the org language; GET returns it', async () => {
    const caller = await callerIn('ja');
    const explicit = await detail(
      await create(caller, { kind: 'task', title: 'T', descriptionMd: 'B', language: 'ko' }),
      201,
    );
    expect(explicit.languages).toEqual({ title: 'ko', description: 'ko', explanation: null });

    const perField = await detail(
      await create(caller, {
        kind: 'task',
        title: 'T2',
        descriptionMd: 'B',
        languages: { description: 'de' },
      }),
      201,
    );
    expect(perField.languages).toEqual({ title: 'ja', description: 'de', explanation: null });
    expect((await detail(await read(caller, perField.key))).languages).toEqual(perField.languages);
  });

  it('PATCH that resubmits an unchanged title re-labels only the changed description', async () => {
    const caller = await callerIn('ja');
    const created = await detail(
      await create(caller, { kind: 'task', title: 'Same', descriptionMd: 'Old', language: 'ko' }),
      201,
    );
    // A form that resubmits every field: the title is unchanged, so its recorded
    // language stays; only the edited description takes the org's.
    const patched = await detail(
      await update(caller, created.key, { title: 'Same', descriptionMd: 'Neu' }),
    );
    expect(patched.languages).toEqual({ title: 'ko', description: 'ja', explanation: null });
  });

  it('PATCH with only a language changes nothing', async () => {
    const caller = await callerIn('ja');
    const created = await detail(await create(caller, { kind: 'task', title: 'T' }), 201);
    const patched = await detail(await update(caller, created.key, { language: 'ko' }));
    expect(patched.languages.title).toBe('ja');
  });

  it('refuses a code outside the eleven as INVALID_BODY 422 on POST and PATCH', async () => {
    const caller = await callerIn('ja');
    const post = await create(caller, { kind: 'task', title: 'Svenska', language: 'sv' });
    expect(post.status).toBe(422);
    expect(((await post.json()) as { code: string }).code).toBe('INVALID_BODY');
    expect(await adminDb.workItem.count({ where: { title: 'Svenska' } })).toBe(0);

    const created = await detail(await create(caller, { kind: 'task', title: 'T' }), 201);
    const patch = await update(caller, created.key, {
      title: 'T2',
      languages: { title: 'sv' },
    });
    expect(patch.status).toBe(422);
    expect(((await patch.json()) as { code: string }).code).toBe('INVALID_BODY');
    expect((await detail(await read(caller, created.key))).title).toBe('T');
  });

  it('GET reads null — never en — on a row with no recorded language', async () => {
    const caller = await callerIn('ja');
    const created = await detail(
      await create(caller, { kind: 'task', title: 'T', descriptionMd: 'B' }),
      201,
    );
    await adminDb.workItem.updateMany({
      where: { identifier: created.key },
      data: { titleLanguage: null, descriptionLanguage: null },
    });
    expect((await detail(await read(caller, created.key))).languages).toEqual({
      title: null,
      description: null,
      explanation: null,
    });
  });
});
