import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resolveTenantLanguages } from '@/lib/ai/tenantLanguages';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7734 · MOTIR-8737 — the language half of a job's tenant: the org's
// content language and the requesting person's saved language, or `''` for a job
// no person started. Real Postgres, through the RLS-bound reads.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspaceIn(contentLanguage: string, ownerLocale: string | null) {
  const owner = await usersService.createUser({
    email: 'owner@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  await adminDb.user.update({ where: { id: owner.id }, data: { locale: ownerLocale } });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'acme',
    ownerUserId: owner.id,
  });
  await setOrgLanguage(workspace.organizationId, contentLanguage);
  return { userId: owner.id, workspaceId: workspace.id, organizationId: workspace.organizationId };
}

async function setOrgLanguage(organizationId: string, contentLanguage: string) {
  await adminDb.organization.update({ where: { id: organizationId }, data: { contentLanguage } });
}

describe('resolveTenantLanguages', () => {
  it("reads the org's content language and the person's saved language", async () => {
    const { userId, workspaceId } = await workspaceIn('ja', 'ko');
    expect(await resolveTenantLanguages({ workspaceId, userId })).toEqual({
      contentLanguage: 'ja',
      personLanguage: 'ko',
    });
  });

  it("answers personLanguage '' — and the org's language — for a job with no person", async () => {
    const { workspaceId } = await workspaceIn('zh', 'ko');
    expect(await resolveTenantLanguages({ workspaceId, userId: null })).toEqual({
      contentLanguage: 'zh',
      personLanguage: '',
    });
  });

  it("falls back to the content language — never '' — for a person with nothing saved", async () => {
    const { userId, workspaceId } = await workspaceIn('de', null);
    const languages = await resolveTenantLanguages({ workspaceId, userId });
    expect(languages).toEqual({ contentLanguage: 'de', personLanguage: 'de' });
    expect(languages.personLanguage).not.toBe('');
  });

  it('falls back to the content language for a retired saved value', async () => {
    const { userId, workspaceId } = await workspaceIn('fr', 'xx');
    expect(await resolveTenantLanguages({ workspaceId, userId })).toEqual({
      contentLanguage: 'fr',
      personLanguage: 'fr',
    });
  });

  it('reads a stored org value outside the eleven codes as en, without throwing', async () => {
    const { userId, workspaceId } = await workspaceIn('klingon', 'ko');
    expect(await resolveTenantLanguages({ workspaceId, userId })).toEqual({
      contentLanguage: 'en',
      personLanguage: 'ko',
    });
    expect(await resolveTenantLanguages({ workspaceId, userId: null })).toEqual({
      contentLanguage: 'en',
      personLanguage: '',
    });
  });

  it('follows a change of the org language between two calls', async () => {
    const { userId, workspaceId, organizationId } = await workspaceIn('en', 'ko');
    expect((await resolveTenantLanguages({ workspaceId, userId })).contentLanguage).toBe('en');
    await setOrgLanguage(organizationId, 'ja');
    expect((await resolveTenantLanguages({ workspaceId, userId })).contentLanguage).toBe('ja');
    expect((await resolveTenantLanguages({ workspaceId, userId: null })).contentLanguage).toBe(
      'ja',
    );
  });
});
