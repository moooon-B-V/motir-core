import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { POST } from '@/app/api/internal/ai/work-items/route';
import { PATCH } from '@/app/api/internal/ai/work-items/[key]/route';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7731 · MOTIR-8097 — the AI work item writer records a language.
// `fileBug` and `updateFiledBugDescription` go through the work item service,
// so with no language they record the organisation's content language; the
// internal routes accept an optional `language`, and refuse anything outside
// the eleven locales with a 400 before writing. Real Postgres, through the
// routes.

const SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function metaTenantIn(language: string) {
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
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { contentLanguage: language },
  });
  return { project };
}

const headers = { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` };

function fileBug(body: unknown) {
  return POST(
    new Request('http://internal/api/internal/ai/work-items', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function patchBug(key: string, body: unknown) {
  return PATCH(
    new Request(`http://internal/api/internal/ai/work-items/${key}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function languagesOf(id: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return [row.titleLanguage, row.descriptionLanguage];
}

describe('the AI work item writer records a language', () => {
  it('records the organisation language when none is passed', async () => {
    await metaTenantIn('ko');
    const res = await fileBug({ projectKey: 'MOTIR', kind: 'bug', title: 'T', descriptionMd: 'B' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await languagesOf(id)).toEqual(['ko', 'ko']);
  });

  it('records an explicit language', async () => {
    await metaTenantIn('ko');
    const res = await fileBug({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'T',
      descriptionMd: 'B',
      language: 'de',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await languagesOf(id)).toEqual(['de', 'de']);
  });

  it('refuses a language outside the eleven with a 400 and writes nothing', async () => {
    const { project } = await metaTenantIn('ko');
    const res = await fileBug({ projectKey: 'MOTIR', kind: 'bug', title: 'T', language: 'xx' });
    expect(res.status).toBe(400);
    expect(await adminDb.workItem.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('re-records the description language when the filed bug’s body is settled', async () => {
    await metaTenantIn('ko');
    const filed = (await (
      await fileBug({ projectKey: 'MOTIR', kind: 'bug', title: 'T', descriptionMd: 'B' })
    ).json()) as { key: string; id: string };

    const bad = await patchBug(filed.key, { descriptionMd: 'B2', language: 'klingon' });
    expect(bad.status).toBe(400);
    expect(await languagesOf(filed.id)).toEqual(['ko', 'ko']);

    const ok = await patchBug(filed.key, { descriptionMd: 'B2', language: 'fr' });
    expect(ok.status).toBe(200);
    // Only the edited field is re-recorded.
    expect(await languagesOf(filed.id)).toEqual(['ko', 'fr']);
  });
});
