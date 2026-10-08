import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { PATCH } from '@/app/api/internal/ai/work-items/[key]/route';
import { POST as FILE_BUG } from '@/app/api/internal/ai/work-items/route';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-7723 — `PATCH /api/internal/ai/work-items/{key}`: the system principal
// settles the description of a bug it filed itself, and of nothing else. Real
// Postgres; the bug under edit is filed through the real filing route.

const SECRET = 'core-callback-secret-test';
const AUTH = { authorization: `Bearer ${SECRET}` };

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeMetaTenant() {
  const owner = await usersService.createUser({
    email: 'owner@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
  return { ownerCtx: { userId: owner.id, workspaceId: workspace.id }, project };
}

async function fileBugAsPrincipal(): Promise<{ key: string; id: string }> {
  const res = await FILE_BUG(
    new Request('http://internal/api/internal/ai/work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({
        projectKey: 'MOTIR',
        kind: 'bug',
        title: 'Planning alarm',
        descriptionMd: 'inline record',
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; id: string };
}

function patch(key: string, body: unknown, headers: Record<string, string> = AUTH) {
  return PATCH(
    new Request(`http://internal/api/internal/ai/work-items/${key}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

describe('PATCH /api/internal/ai/work-items/{key}', () => {
  it('replaces the description of a bug the system principal filed → 200', async () => {
    await makeMetaTenant();
    const { key, id } = await fileBugAsPrincipal();

    const res = await patch(key, { descriptionMd: 'attached as planning-record.json' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key });
    const row = await adminDb.workItem.findUnique({ where: { id } });
    expect(row?.descriptionMd).toBe('attached as planning-record.json');
  });

  it('refuses a card a person wrote with the same 404 as an unknown key', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    const theirs = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'bug', title: 'A person’s bug', descriptionMd: 'keep me' },
      ownerCtx,
    );

    const res = await patch(theirs.identifier, { descriptionMd: 'overwritten' });
    expect(res.status).toBe(404);
    expect((await patch('MOTIR-99999', { descriptionMd: 'x' })).status).toBe(404);
    const row = await adminDb.workItem.findUnique({ where: { id: theirs.id } });
    expect(row?.descriptionMd).toBe('keep me');
  });

  it('rejects a missing bearer, a malformed key and a missing description', async () => {
    await makeMetaTenant();
    const { key } = await fileBugAsPrincipal();
    expect((await patch(key, { descriptionMd: 'x' }, {})).status).toBe(401);
    expect((await patch('nope', { descriptionMd: 'x' })).status).toBe(400);
    expect((await patch(key, {})).status).toBe(400);
  });
});
