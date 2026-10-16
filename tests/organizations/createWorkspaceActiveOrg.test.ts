import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR-8778 — "New workspace" creates the workspace in the org the SHELL names.
//
// The shell resolves "the active org" as the active WORKSPACE's org, with the
// `motir.org` cookie only as the fallback (`app/(authed)/layout.tsx`).
// `createWorkspaceAction` resolved it from the cookie ALONE, and the cookie is
// written only by the org menu: every workspace move leaves it where it was. So
// an account in TWO orgs that moved between them through the workspace switcher
// or a project link created its next workspace — with its billing and its
// members — in the org the header does not name.
//
// ⚠️ THE TWO-ORG FIXTURE IS THE POINT: in a single org the cookie and the
// workspace can only agree. Real Postgres, real services; the single sanctioned
// mock is `getSession`, plus the request scope the suite does not have
// (`next/headers`), driven from a plain cookie jar.

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
const { createWorkspaceAction } = await import('@/app/(authed)/_actions');
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
 * workspace — the state a later workspace move leaves behind. The shell names
 * the SECOND org.
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

describe('createWorkspaceAction under a stale org cookie', () => {
  it('creates the workspace in the org the shell names, not the cookie’s', async () => {
    const { user, firstOrgId, secondOrgId } = await twoOrgsWithStaleOrgCookie();

    // The defect in one line: what the action asked for before — the cookie alone.
    const cookieAlone = await organizationsService.resolveActiveOrganization(user.id, firstOrgId);
    expect(cookieAlone!.organization.id).toBe(firstOrgId);

    const result = await createWorkspaceAction('Created From Shell');
    if (!result.ok) throw new Error(`expected a created workspace, got ${result.error}`);

    const created = await adminDb.workspace.findUniqueOrThrow({
      where: { id: result.workspace.id },
    });
    expect(created.organizationId).toBe(secondOrgId);
    // And the action switched to it, so the shell keeps naming that org.
    expect(cookieJar.get(WORKSPACE_COOKIE_NAME)).toBe(created.id);
  });
});

// ⚠️ THE GUARD. The workspace-create path asks the shared resolver; it does not
// read the org cookie to decide the tenant.
describe('the New workspace door resolves the active org one way', () => {
  it('createWorkspaceAction asks resolveActiveOrganizationAsShell', () => {
    const source = readFileSync(join(process.cwd(), 'app/(authed)/_actions.ts'), 'utf8');
    const body = source.slice(
      source.indexOf('export async function createWorkspaceAction'),
      source.indexOf(
        'export async function',
        source.indexOf('export async function createWorkspaceAction') + 1,
      ),
    );
    expect(body).toContain('resolveActiveOrganizationAsShell(');
    expect(body).not.toContain('ORGANIZATION_COOKIE_NAME');
    expect(body).not.toContain('resolveActiveOrganization(');
  });

  it('no public-project helper resolves the org from the cookie alone', () => {
    const source = readFileSync(join(process.cwd(), 'lib/publicProjects/viewerContext.ts'), 'utf8');
    expect(source).not.toContain('ORGANIZATION_COOKIE_NAME');
  });
});
