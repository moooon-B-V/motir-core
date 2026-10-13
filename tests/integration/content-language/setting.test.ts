import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { orgIn, setOrgLanguage, storedLanguages } from './_fixtures';

// Story MOTIR-7731 (MOTIR-8099) — SETTING and CHANGING an organisation's
// content language, as one flow: sign-up seeds it from the top Accept-Language
// entry (zh for any zh-*, otherwise en), the self-heal repair and Create
// organization do the same, an owner or admin changes it with attribution, and
// a change never rewrites what was already written. Real Postgres; the
// compliance gate on the route is the one stub (no cookie jar in a test).

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const { PATCH } = await import('@/app/api/organizations/[orgId]/content-language/route');
const { organizationContentLanguageService: changes } =
  await import('@/lib/services/organizationContentLanguageService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workItemTodosService } = await import('@/lib/services/workItemTodosService');
const { createTestUser } = await import('../../fixtures');

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function orgLanguagesOf(userId: string): Promise<string[]> {
  const rows = await adminDb.organizationMembership.findMany({
    where: { userId },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.organization.contentLanguage);
}

async function signUp(email: string, acceptLanguage: string | null) {
  await auth.api.signUpEmail({
    body: { email, password: 'hunter2hunter2', name: 'Lin' },
    headers: {
      origin: 'http://localhost:3000',
      ...(acceptLanguage === null ? {} : { 'accept-language': acceptLanguage }),
    },
  });
  return (await adminDb.user.findUniqueOrThrow({ where: { email } })).id;
}

function patchAs(user: { id: string; email: string }, orgId: string, language: string) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: user.id, email: user.email } },
  });
  return PATCH(
    new Request(`http://localhost:3000/api/organizations/${orgId}/content-language`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language }),
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

describe('registration picks the content language from the browser', () => {
  it('a top zh-* entry gives zh', async () => {
    expect(await orgLanguagesOf(await signUp('zh@example.com', 'zh-CN'))).toEqual(['zh']);
  });

  it.each([
    ['ja', 'ja'],
    ['sv', 'sv'],
    ['ja-then-zh', 'ja, zh;q=0.9'],
  ])('%s gives en', async (name, header) => {
    expect(await orgLanguagesOf(await signUp(`${name}@example.com`, header))).toEqual(['en']);
  });

  it('no header gives en', async () => {
    expect(await orgLanguagesOf(await signUp('none@example.com', null))).toEqual(['en']);
  });

  it('the self-heal repair seeds zh, and leaves a provisioned user alone', async () => {
    const fresh = await createTestUser();
    await workspacesService.resolveActiveWorkspace(fresh.id, null, 'Lin', 'zh');
    expect(await orgLanguagesOf(fresh.id)).toEqual(['zh']);

    await workspacesService.resolveActiveWorkspace(fresh.id, null, 'Lin', 'ja');
    expect(await orgLanguagesOf(fresh.id)).toEqual(['zh']);
  });

  it('Create organization takes the request language, else en', async () => {
    const user = await createTestUser();
    const zh = await organizationsService.createOrganization({
      name: 'Zh Org',
      actorUserId: user.id,
      contentLanguage: 'zh',
    });
    const plain = await organizationsService.createOrganization({
      name: 'Plain Org',
      actorUserId: user.id,
    });
    expect(zh.contentLanguage).toBe('zh');
    expect(plain.contentLanguage).toBe('en');
  });

  it('an organisation that existed before the migration reads en', async () => {
    const org = await adminDb.organization.create({ data: { name: 'Old', slug: 'old' } });
    expect(org.contentLanguage).toBe('en');
  });
});

describe('an owner or admin changes it, attributed', () => {
  it('each change leaves a who / from / to / when row, listed newest first', async () => {
    const fx = await orgIn('en');
    const orgId = fx.workspace.organizationId;
    const admin = await createTestUser();
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: admin.id, role: 'admin' },
    });

    await changes.changeContentLanguage({
      organizationId: orgId,
      actorUserId: fx.ownerId,
      language: 'ja',
    });
    await changes.changeContentLanguage({
      organizationId: orgId,
      actorUserId: admin.id,
      language: 'de',
    });

    const rows = await changes.listContentLanguageChanges({
      organizationId: orgId,
      actorUserId: fx.ownerId,
    });
    expect(rows.map((r) => [r.fromLanguage, r.toLanguage, r.changedByUserId])).toEqual([
      ['ja', 'de', admin.id],
      ['en', 'ja', fx.ownerId],
    ]);
    expect(rows.every((r) => typeof r.changedAt === 'string')).toBe(true);
  });

  it('a member is 403, a stranger 404, sv is 400 — and none changes anything', async () => {
    const fx = await orgIn('en');
    const orgId = fx.workspace.organizationId;
    const member = await createTestUser();
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: member.id, role: 'member' },
    });
    const stranger = await createTestUser();
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });

    expect((await patchAs(member, orgId, 'ja')).status).toBe(403);
    expect((await patchAs(stranger, orgId, 'ja')).status).toBe(404);
    const bad = await patchAs(owner, orgId, 'sv');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('INVALID_CONTENT_LANGUAGE');

    const org = await adminDb.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.contentLanguage).toBe('en');
    expect(
      await adminDb.organizationContentLanguageChange.count({ where: { organizationId: orgId } }),
    ).toBe(0);
  });
});

describe('nothing already written is rewritten', () => {
  it('old text keeps its text and its en; new work records zh', async () => {
    const fx = await orgIn('en');
    const old = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Old', descriptionMd: 'Body' },
      fx.ctx,
    );
    const { todo } = await workItemTodosService.addTodo(
      old.id,
      { text: 'Step', notesMd: 'How' },
      fx.ctx,
    );

    await setOrgLanguage(fx.workspace.organizationId, 'zh');

    const reread = await adminDb.workItem.findUniqueOrThrow({ where: { id: old.id } });
    expect([reread.title, reread.descriptionMd]).toEqual(['Old', 'Body']);
    expect(await storedLanguages(old.id)).toEqual(['en', 'en', null]);
    const step = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id: todo.id } });
    expect([step.text, step.textLanguage, step.notesLanguage]).toEqual(['Step', 'en', 'en']);

    const fresh = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: '新' },
      fx.ctx,
    );
    expect((await storedLanguages(fresh.id))[0]).toBe('zh');
  });
});
