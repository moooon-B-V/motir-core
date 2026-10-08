import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { POST as fileBug } from '@/app/api/internal/ai/work-items/route';
import { POST } from '@/app/api/internal/ai/work-items/[key]/comments/route';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-7722 — `POST /api/internal/ai/work-items/{key}/comments`, the door a
// REPEAT planning failure comments through. Real Postgres. It comments only on a
// bug the system principal filed, and answers 409 once that bug is closed so
// motir-ai files a new one.

const SECRET = 'core-callback-secret-test';
const PASSWORD = 'hunter2hunter2';
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
    password: PASSWORD,
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
  const { userId: systemUserId } = await seedSystemPrincipal({
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const ownerCtx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  return { ownerCtx, project, systemUserId };
}

/** File a bug as the system principal, through the real filing route. */
async function systemBug(): Promise<{ key: string; id: string }> {
  const res = await fileBug(
    new Request('http://internal/api/internal/ai/work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ projectKey: 'MOTIR', kind: 'bug', title: 'Planning failure' }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; id: string };
}

function comment(key: string, bodyObj: unknown, headers: Record<string, string> = AUTH) {
  return POST(
    new Request(`http://internal/api/internal/ai/work-items/${key}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(bodyObj),
    }),
    { params: Promise.resolve({ key }) },
  );
}

describe('POST /api/internal/ai/work-items/{key}/comments', () => {
  it('comments on an open bug the system principal filed → 201, authored by the system principal', async () => {
    const { systemUserId } = await makeMetaTenant();
    const bug = await systemBug();

    const res = await comment(bug.key, { bodyMd: '**The same failure again**' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const row = await adminDb.comment.findUnique({ where: { id } });
    expect(row?.workItemId).toBe(bug.id);
    expect(row?.authorId).toBe(systemUserId);
    expect(row?.bodyMd).toContain('The same failure again');
  });

  it('a lower-case key resolves the same bug', async () => {
    await makeMetaTenant();
    const bug = await systemBug();
    const res = await comment(bug.key.toLowerCase(), { bodyMd: 'again' });
    expect(res.status).toBe(201);
  });

  it('a bug a person filed is 404 — the service bearer cannot comment on it', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    const mine = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'bug', title: 'Mine' },
      ownerCtx,
    );
    const res = await comment(mine.identifier, { bodyMd: 'again' });
    expect(res.status).toBe(404);
    expect(await adminDb.comment.count({ where: { workItemId: mine.id } })).toBe(0);
  });

  it('an unknown key, an unknown project and a malformed key are 404', async () => {
    await makeMetaTenant();
    expect((await comment('MOTIR-999999', { bodyMd: 'x' })).status).toBe(404);
    expect((await comment('NOPE-1', { bodyMd: 'x' })).status).toBe(404);
    expect((await comment('not a key', { bodyMd: 'x' })).status).toBe(404);
  });

  it('a done bug is 409 FILED_BUG_CLOSED', async () => {
    await makeMetaTenant();
    const bug = await systemBug();
    await adminDb.workItem.update({ where: { id: bug.id }, data: { status: 'done' } });
    const res = await comment(bug.key, { bodyMd: 'again' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('FILED_BUG_CLOSED');
  });

  it('an archived bug is 409 FILED_BUG_CLOSED', async () => {
    await makeMetaTenant();
    const bug = await systemBug();
    await adminDb.workItem.update({ where: { id: bug.id }, data: { archivedAt: new Date() } });
    const res = await comment(bug.key, { bodyMd: 'again' });
    expect(res.status).toBe(409);
  });

  it('rejects a missing bearer (401) and an empty body (400)', async () => {
    await makeMetaTenant();
    const bug = await systemBug();
    expect((await comment(bug.key, { bodyMd: 'x' }, {})).status).toBe(401);
    expect((await comment(bug.key, { bodyMd: '   ' })).status).toBe(400);
    expect((await comment(bug.key, {})).status).toBe(400);
  });
});
