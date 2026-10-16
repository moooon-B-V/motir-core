import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR-8776 — the org settings panes name the org the SHELL names.
//
// The shell resolves "the active org" as the active WORKSPACE's org, with the
// `motir.org` cookie only as the fallback (`app/(authed)/layout.tsx`). The
// usage, billing, members and security panes resolved it from the cookie ALONE,
// and the cookie is written only by the org menu: every workspace move leaves it
// where it was. So an account in TWO orgs that moved between them through the
// workspace switcher or a project link read one org's spend, roster and billing
// — and wrote its security policy — under a header naming the other.
//
// ⚠️ THE TWO-ORG FIXTURE IS THE POINT. Every pane suite before this one seeds a
// single org, where the cookie and the workspace can only agree; that is why the
// defect shipped (the same lesson as MOTIR-4801). Real Postgres, real services;
// the single sanctioned mock is `getSession`, plus the request scope the suite
// does not have (`next/headers`), driven from a plain cookie jar.

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: vi.fn() };
});

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }),
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { db } = await import('@/lib/db');
const { getSession } = await import('@/lib/auth');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { ORGANIZATION_COOKIE_NAME } = await import('@/lib/organizations/cookie');
const { WORKSPACE_COOKIE_NAME } = await import('@/lib/workspaces');
const { resolveActiveOrganizationForPane } = await import('@/lib/workspaces/tierDisclosure.server');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

beforeEach(async () => {
  vi.clearAllMocks();
  cookieJar.clear();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * One account that owns two orgs, each with a workspace, signed in with the ORG
 * cookie naming the first and the WORKSPACE cookie naming the second's
 * workspace — the state the org menu's "Create organization" (or "Switch") and a
 * later workspace move leave behind.
 */
async function twoOrgsWithStaleOrgCookie() {
  const user = await createTestUser();
  const { workspace: firstWorkspace } = await workspacesService.createWorkspace({
    name: 'Moooon',
    ownerUserId: user.id,
  });
  const second = await organizationsService.createOrganization({
    name: 'Nifer',
    actorUserId: user.id,
  });
  const { workspace: secondWorkspace } = await workspacesService.createWorkspace({
    name: 'Nifer Workspace',
    ownerUserId: user.id,
    organizationId: second.id,
  });
  vi.mocked(getSession).mockResolvedValue({
    user: { id: user.id, email: user.email, name: user.name },
  } as never);
  cookieJar.set(ORGANIZATION_COOKIE_NAME, firstWorkspace.organizationId);
  cookieJar.set(WORKSPACE_COOKIE_NAME, secondWorkspace.id);
  return { user, firstOrgId: firstWorkspace.organizationId, secondOrgId: second.id };
}

describe('resolveActiveOrganizationForPane', () => {
  it('names the ACTIVE WORKSPACE’s org when the org cookie names another', async () => {
    const { user, firstOrgId, secondOrgId } = await twoOrgsWithStaleOrgCookie();

    // The defect in one line: what the panes asked for before — the cookie alone.
    const cookieAlone = await organizationsService.resolveActiveOrganization(user.id, firstOrgId);
    expect(cookieAlone!.organization.id).toBe(firstOrgId);

    const current = await resolveActiveOrganizationForPane(user.id);
    expect(current!.organization.id).toBe(secondOrgId);
    expect(current!.organization.name).toBe('Nifer');
    expect(current!.role).toBe('owner');
  });

  it('the Security pane WRITES to the org the shell names, not the cookie’s', async () => {
    const { firstOrgId, secondOrgId } = await twoOrgsWithStaleOrgCookie();
    const { setOrganizationRequireTwoFactorAction } =
      await import('@/app/(authed)/settings/organization/security/actions');

    await expect(setOrganizationRequireTwoFactorAction(true)).resolves.toEqual({ ok: true });

    const [first, second] = await Promise.all([
      adminDb.organization.findUniqueOrThrow({ where: { id: firstOrgId } }),
      adminDb.organization.findUniqueOrThrow({ where: { id: secondOrgId } }),
    ]);
    expect(second.requiresTwoFactor).toBe(true);
    expect(first.requiresTwoFactor).toBe(false);
  });
});

// ⚠️ THE GUARD. One rule for "the active org" under the org settings area: a file
// there either asks the shared resolver, or composes the shell's own helper
// (`preferredOrganizationId`, as the General page does for its `?org=` arm).
// Calling `resolveActiveOrganization` with anything else — the cookie alone was
// the shape that shipped — is red here, naming the file.
describe('the org settings area resolves the active org one way', () => {
  const root = join(process.cwd(), 'app/(authed)/settings/organization');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('no file resolves it from the org cookie alone', () => {
    const offenders = sourceFiles(root)
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        return (
          source.includes('resolveActiveOrganization(') &&
          !source.includes('preferredOrganizationId(')
        );
      })
      .map((path) => relative(process.cwd(), path));
    expect(offenders).toEqual([]);
  });

  it('every pane that names its org asks the shared resolver', () => {
    for (const pane of [
      'usage/page.tsx',
      'billing/page.tsx',
      'members/page.tsx',
      'security/page.tsx',
      'security/actions.ts',
    ]) {
      const source = readFileSync(join(root, pane), 'utf8');
      expect(source, pane).toContain('resolveActiveOrganizationForPane(');
      expect(source, pane).not.toContain('ORGANIZATION_COOKIE_NAME');
    }
  });
});
