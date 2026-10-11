import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  InvalidContentLanguageError,
  OrganizationClosingError,
  OrganizationNotFoundError,
  OrgForbiddenError,
} from '@/lib/organizations/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7731 · MOTIR-8094 — changing an organisation's content language:
// owner and admin only, attributed with who / from / to / when, a no-op writes
// nothing, and two racing changes chain their `from`. Service and route against
// a real Postgres; the compliance gate is the one stub (a route test has no
// cookie jar).

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const { PATCH } = await import('@/app/api/organizations/[orgId]/content-language/route');
const { organizationContentLanguageService: svc } =
  await import('@/lib/services/organizationContentLanguageService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { createTestWorkspace, createTestUser } = await import('../fixtures');

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function orgWith(role: 'admin' | 'member') {
  const { workspace, owner } = await createTestWorkspace();
  const other = await createTestUser();
  await adminDb.organizationMembership.create({
    data: { organizationId: workspace.organizationId, userId: other.id, role },
  });
  return { orgId: workspace.organizationId, owner, other };
}

async function state(orgId: string) {
  const org = await adminDb.organization.findUniqueOrThrow({ where: { id: orgId } });
  const history = await adminDb.organizationContentLanguageChange.findMany({
    where: { organizationId: orgId },
    orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
  });
  return { language: org.contentLanguage, history };
}

function signInAs(user: { id: string; email: string }) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: user.id, email: user.email } },
  });
}

function patch(orgId: string, body: unknown, raw = false) {
  return PATCH(
    new Request(`http://localhost:3000/api/organizations/${orgId}/content-language`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

describe('changeContentLanguage', () => {
  it.each(['owner', 'admin'] as const)('an %s changes en → ja, attributed', async (who) => {
    const { orgId, owner, other } = await orgWith('admin');
    const actor = who === 'owner' ? owner : other;
    const before = new Date();

    const dto = await svc.changeContentLanguage({
      organizationId: orgId,
      actorUserId: actor.id,
      language: 'ja',
    });

    expect(dto.contentLanguage).toBe('ja');
    const { language, history } = await state(orgId);
    expect(language).toBe('ja');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromLanguage: 'en',
      toLanguage: 'ja',
      changedByUserId: actor.id,
    });
    expect(history[0]!.changedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('refuses a member (403) and a non-member (404), changing nothing', async () => {
    const { orgId, other: member } = await orgWith('member');
    const stranger = await createTestUser();

    await expect(
      svc.changeContentLanguage({ organizationId: orgId, actorUserId: member.id, language: 'ja' }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    await expect(
      svc.changeContentLanguage({
        organizationId: orgId,
        actorUserId: stranger.id,
        language: 'ja',
      }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);

    signInAs(member);
    expect((await patch(orgId, { language: 'ja' })).status).toBe(403);
    signInAs(stranger);
    expect((await patch(orgId, { language: 'ja' })).status).toBe(404);

    expect(await state(orgId)).toEqual({ language: 'en', history: [] });
  });

  it.each(['sv', '', 'EN', 'zh-CN'])('refuses %j as a language', async (language) => {
    const { orgId, owner } = await orgWith('admin');
    await expect(
      svc.changeContentLanguage({ organizationId: orgId, actorUserId: owner.id, language }),
    ).rejects.toBeInstanceOf(InvalidContentLanguageError);

    signInAs(owner);
    const res = await patch(orgId, { language });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CONTENT_LANGUAGE');
    expect(await state(orgId)).toEqual({ language: 'en', history: [] });
  });

  it('setting the value it already has succeeds and records nothing', async () => {
    const { orgId, owner } = await orgWith('admin');
    const dto = await svc.changeContentLanguage({
      organizationId: orgId,
      actorUserId: owner.id,
      language: 'en',
    });
    expect(dto.contentLanguage).toBe('en');
    expect(await state(orgId)).toEqual({ language: 'en', history: [] });
  });

  it('two concurrent changes chain their from, never both from en', async () => {
    const { orgId, owner, other: admin } = await orgWith('admin');

    await Promise.all([
      svc.changeContentLanguage({ organizationId: orgId, actorUserId: owner.id, language: 'ja' }),
      svc.changeContentLanguage({ organizationId: orgId, actorUserId: admin.id, language: 'ko' }),
    ]);

    const { language, history } = await state(orgId);
    expect(history).toHaveLength(2);
    const [first, second] = history;
    expect(first!.fromLanguage).toBe('en');
    expect(second!.fromLanguage).toBe(first!.toLanguage);
    expect(new Set([first!.toLanguage, second!.toLanguage])).toEqual(new Set(['ja', 'ko']));
    expect(language).toBe(second!.toLanguage);
  });

  it('is refused while the organisation is being deleted', async () => {
    const { orgId, owner } = await orgWith('admin');
    await adminDb.organization.update({ where: { id: orgId }, data: { closingSince: new Date() } });

    await expect(
      svc.changeContentLanguage({ organizationId: orgId, actorUserId: owner.id, language: 'ja' }),
    ).rejects.toBeInstanceOf(OrganizationClosingError);
    signInAs(owner);
    expect((await patch(orgId, { language: 'ja' })).status).toBe(409);
    expect(await state(orgId)).toEqual({ language: 'en', history: [] });
  });
});

describe('listContentLanguageChanges', () => {
  it('returns the history newest first to an owner or admin, and refuses a member', async () => {
    const { orgId, owner, other: admin } = await orgWith('admin');
    const member = await createTestUser();
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: member.id, role: 'member' },
    });
    await svc.changeContentLanguage({
      organizationId: orgId,
      actorUserId: owner.id,
      language: 'ja',
    });
    await svc.changeContentLanguage({
      organizationId: orgId,
      actorUserId: admin.id,
      language: 'de',
    });

    for (const actor of [owner, admin]) {
      const rows = await svc.listContentLanguageChanges({
        organizationId: orgId,
        actorUserId: actor.id,
      });
      expect(rows.map((r) => [r.fromLanguage, r.toLanguage, r.changedByUserId])).toEqual([
        ['ja', 'de', admin.id],
        ['en', 'ja', owner.id],
      ]);
    }
    await expect(
      svc.listContentLanguageChanges({ organizationId: orgId, actorUserId: member.id }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });
});

describe('getLatestContentLanguageChange (MOTIR-8095)', () => {
  it('is null until the language changes, then names the newest change and who made it', async () => {
    const { orgId, owner, other: admin } = await orgWith('admin');
    expect(
      await svc.getLatestContentLanguageChange({ organizationId: orgId, actorUserId: owner.id }),
    ).toBeNull();

    await adminDb.user.update({ where: { id: owner.id }, data: { name: 'Lin Wei' } });
    await adminDb.user.update({ where: { id: admin.id }, data: { name: ' ' } });
    await svc.changeContentLanguage({
      organizationId: orgId,
      actorUserId: owner.id,
      language: 'ja',
    });
    expect(
      await svc.getLatestContentLanguageChange({ organizationId: orgId, actorUserId: admin.id }),
    ).toMatchObject({ fromLanguage: 'en', toLanguage: 'ja', changedByLabel: 'Lin Wei' });

    // A person with no display name is named by their email.
    await svc.changeContentLanguage({
      organizationId: orgId,
      actorUserId: admin.id,
      language: 'de',
    });
    const latest = await svc.getLatestContentLanguageChange({
      organizationId: orgId,
      actorUserId: owner.id,
    });
    expect(latest).toMatchObject({
      fromLanguage: 'ja',
      toLanguage: 'de',
      changedByLabel: admin.email,
    });
    expect(typeof latest?.changedAt).toBe('string');
  });

  it('refuses a member', async () => {
    const { orgId, other: member } = await orgWith('member');
    await expect(
      svc.getLatestContentLanguageChange({ organizationId: orgId, actorUserId: member.id }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });
});

describe('the organisation DTO', () => {
  it('carries contentLanguage to a plain member', async () => {
    const { orgId, owner, other: member } = await orgWith('member');
    await svc.changeContentLanguage({
      organizationId: orgId,
      actorUserId: owner.id,
      language: 'zh',
    });

    const current = await organizationsService.resolveActiveOrganization(member.id, orgId);
    expect(current?.organization.contentLanguage).toBe('zh');
  });
});

describe('PATCH /api/organizations/[orgId]/content-language', () => {
  it('changes the language and returns the organisation', async () => {
    const { orgId, owner } = await orgWith('admin');
    signInAs(owner);
    const res = await patch(orgId, { language: 'ko' });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { organization: { contentLanguage: string } }).organization,
    ).toMatchObject({ id: orgId, contentLanguage: 'ko' });
  });

  it('400 BAD_REQUEST for a non-JSON body or a missing / non-string language', async () => {
    const { orgId, owner } = await orgWith('admin');
    signInAs(owner);
    expect((await patch(orgId, 'not json', true)).status).toBe(400);
    for (const body of [{}, { language: 42 }, { language: null }]) {
      const res = await patch(orgId, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
    }
    expect(await state(orgId)).toEqual({ language: 'en', history: [] });
  });

  it('401 passes straight through from the session gate', async () => {
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });
    expect((await patch('any-org', { language: 'ja' })).status).toBe(401);
  });
});
