import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { GET } from '@/app/api/internal/ai/section-sets/route';
import { describeSectionSets } from '@/lib/workItems/sections/registry';
import { createTestWorkspace, createTestProject } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// GET /api/internal/ai/section-sets (MOTIR-9029) — the ai→core read of the section
// registry, through the REAL route against a real Postgres: both auth grants (the
// §4a service bearer and the §4b job token), the descriptor itself and its ETag.

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function authedHeaders(): Promise<Record<string, string>> {
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    identifier: 'SEC',
    name: 'Sections',
  });
  return {
    authorization: `Bearer ${SERVICE_SECRET}`,
    'x-motir-job-token': mintJobToken({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    }),
  };
}

const get = (query: string, headers: Record<string, string>) =>
  GET(new Request(`http://core/api/internal/ai/section-sets${query}`, { headers }));

describe('GET /api/internal/ai/section-sets', () => {
  it('is 401 without the service bearer or the job token', async () => {
    const noBearer = await get('', { 'x-motir-job-token': 'whatever' });
    expect(noBearer.status).toBe(401);
    expect(await noBearer.json()).toMatchObject({ code: 'service_unauthorized' });

    const noToken = await get('', { authorization: `Bearer ${SERVICE_SECRET}` });
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toMatchObject({ code: 'token_invalid' });
  });

  it('returns the whole descriptor, with its version as the ETag', async () => {
    const res = await get('', await authedHeaders());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(describeSectionSets());
    expect(res.headers.get('etag')).toBe(`"${describeSectionSets().version}"`);
  });

  it('narrows to one cell, one kind and one type', async () => {
    const headers = await authedHeaders();
    const cell = (await (await get('?kind=task&type=decision', headers)).json()) as {
      sets: { kind: string; type: string | null }[];
    };
    expect(cell.sets.map((s) => [s.kind, s.type])).toEqual([['task', 'decision']]);

    const epics = (await (await get('?kind=epic', headers)).json()) as { sets: { kind: string }[] };
    expect(new Set(epics.sets.map((s) => s.kind))).toEqual(new Set(['epic']));

    const tests = (await (await get('?type=test', headers)).json()) as {
      sets: { type: string | null }[];
    };
    expect(new Set(tests.sets.map((s) => s.type))).toEqual(new Set(['test']));
  });

  it('is 400 UNKNOWN_SECTION_CELL, naming the value, on an unknown kind', async () => {
    const res = await get('?kind=nope', await authedHeaders());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('UNKNOWN_SECTION_CELL');
    expect(body.error).toContain("'nope'");
  });
});
