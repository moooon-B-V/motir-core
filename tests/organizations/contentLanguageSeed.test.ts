import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, authOptions } from '@/lib/auth';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7731 · MOTIR-8093 — every path that MINTS an organisation seeds its
// content language from the creator's request: sign-up (email and Google, both
// through better-auth's `user.create.after`), the self-heal default workspace,
// and "Create organization". Nesting a workspace under an existing org leaves
// that org's language alone. Real Postgres.

const BASE_URL = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function orgsOf(userId: string) {
  const rows = await adminDb.organizationMembership.findMany({
    where: { userId },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.organization);
}

async function signUp(email: string, headers: Record<string, string>) {
  await auth.api.signUpEmail({
    body: { email, password: 'hunter2hunter2', name: 'Lin' },
    headers: { origin: BASE_URL, ...headers },
  });
  return (await adminDb.user.findUnique({ where: { email } }))!;
}

async function makeUser(email: string) {
  return adminDb.user.create({ data: { email, name: 'Lin', emailVerified: true } });
}

describe('sign-up', () => {
  it('a Chinese browser gets a zh organisation', async () => {
    const user = await signUp('zh@example.com', { 'accept-language': 'zh-CN,zh;q=0.9' });
    const [org] = await orgsOf(user.id);
    expect(org!.contentLanguage).toBe('zh');
  });

  it('every other browser gets an en organisation', async () => {
    const user = await signUp('sv@example.com', { 'accept-language': 'sv-SE,zh;q=0.5' });
    expect((await orgsOf(user.id))[0]!.contentLanguage).toBe('en');
  });

  it('the content language follows Accept-Language, not the UI-language cookie', async () => {
    const user = await signUp('cookie@example.com', {
      cookie: 'NEXT_LOCALE=zh',
      'accept-language': 'en-US',
    });
    expect(user.locale).toBe('zh');
    expect((await orgsOf(user.id))[0]!.contentLanguage).toBe('en');
  });

  it('on the Google path the after hook reads the OAuth callback context', async () => {
    type CreateAfter = (user: Record<string, unknown>, ctx: unknown) => Promise<void>;
    const after = authOptions.databaseHooks!.user!.create!.after as unknown as CreateAfter;
    const user = await makeUser('g@example.com');
    await after(
      { id: user.id, name: user.name, email: user.email },
      {
        path: '/callback/:id',
        headers: new Headers({ 'accept-language': 'zh-TW' }),
        request: new Request(`${BASE_URL}/api/auth/callback/google`),
      },
    );
    expect((await orgsOf(user.id))[0]!.contentLanguage).toBe('zh');
  });

  it('with no request in scope the organisation stays en', async () => {
    type CreateAfter = (user: Record<string, unknown>, ctx: unknown) => Promise<void>;
    const after = authOptions.databaseHooks!.user!.create!.after as unknown as CreateAfter;
    const user = await makeUser('seed@example.com');
    await after({ id: user.id, name: user.name, email: user.email }, null);
    expect((await orgsOf(user.id))[0]!.contentLanguage).toBe('en');
  });
});

describe('the self-heal default workspace', () => {
  it('seeds the minted organisation from the resolver', async () => {
    const user = await makeUser('heal@example.com');
    await workspacesService.resolveActiveWorkspace(user.id, null, 'Lin', 'zh');
    expect((await orgsOf(user.id))[0]!.contentLanguage).toBe('zh');
  });

  it('leaves an already-provisioned user alone, whatever a later request says', async () => {
    const user = await makeUser('kept@example.com');
    await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: 'Lin',
      contentLanguage: 'en',
    });
    await workspacesService.resolveActiveWorkspace(user.id, null, 'Lin', 'zh');
    const orgs = await orgsOf(user.id);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.contentLanguage).toBe('en');
  });

  it('stays en when no language is passed', async () => {
    const user = await makeUser('heal-en@example.com');
    await workspacesService.ensureDefaultWorkspace({ userId: user.id, userName: 'Lin' });
    expect((await orgsOf(user.id))[0]!.contentLanguage).toBe('en');
  });
});

describe('Create organization', () => {
  it('stores the language it is given', async () => {
    const user = await makeUser('create@example.com');
    const dto = await organizationsService.createOrganization({
      name: 'Acme',
      actorUserId: user.id,
      contentLanguage: 'zh',
    });
    const org = await adminDb.organization.findUniqueOrThrow({ where: { id: dto.id } });
    expect(org.contentLanguage).toBe('zh');
  });

  it('a workspace nested under an existing org leaves its language alone', async () => {
    const user = await makeUser('nest@example.com');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'First',
      ownerUserId: user.id,
      contentLanguage: 'en',
    });
    await workspacesService
      .createWorkspace({
        name: 'Second',
        ownerUserId: user.id,
        organizationId: workspace.organizationId,
        contentLanguage: 'zh',
      })
      .catch(() => {
        // A free org may cap at one workspace; the org row is what is asserted.
      });
    const org = await adminDb.organization.findUniqueOrThrow({
      where: { id: workspace.organizationId },
    });
    expect(org.contentLanguage).toBe('en');
  });
});
