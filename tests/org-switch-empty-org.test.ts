import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces/middleware';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-8777 — the org switcher could not enter an organization with NO
// workspace. The switch set the org cookie but left the workspace cookie on the
// previous org's workspace, and the shell lets the active workspace's org
// outrank the org cookie, so it kept naming the old org. A freshly created org
// was never entered either: its action clears the workspace cookie, and the
// resolver then self-healed into the account's first workspace — another org's.
//
// Driven through the REAL server actions and the REAL `getWorkspaceContext` /
// shell resolver against real Postgres. Only the request-scoped edges are
// stubbed: `getSession` (no auth in vitest) and `next/headers` (an in-memory
// cookie jar the actions write and the resolver reads back).

const sessionUser = { id: '', email: '', name: '' };
const cookieJar = new Map<string, string>();

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (sessionUser.id ? { user: { ...sessionUser } } : null)),
}));
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

const { switchOrganizationAction, createOrganizationAction } =
  await import('@/app/(authed)/_actions');
const { getWorkspaceContext } = await import('@/lib/workspaces');
const { resolveActiveOrganizationAsShell } = await import('@/lib/workspaces/tierDisclosure.server');

function actAs(user: User) {
  sessionUser.id = user.id;
  sessionUser.email = user.email;
  sessionUser.name = user.name;
}

// An account in a workspace of org A (pinned, as the shell leaves it), which
// also owns org B — created the way the org menu creates one, so it has none.
async function ownerOfAnEmptyOrg() {
  const user = await createTestUser();
  const { workspace: wsA } = await workspacesService.createWorkspace({
    name: 'Alpha',
    ownerUserId: user.id,
  });
  const orgB = await organizationsService.createOrganization({
    name: 'Nifer',
    actorUserId: user.id,
  });
  actAs(user);
  cookieJar.set(WORKSPACE_COOKIE_NAME, wsA.id);
  cookieJar.set(ORGANIZATION_COOKIE_NAME, wsA.organizationId);
  return { user, wsA, orgA: wsA.organizationId, orgB };
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterEach(() => {
  sessionUser.id = '';
  sessionUser.email = '';
  sessionUser.name = '';
  cookieJar.clear();
  vi.clearAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('MOTIR-8777 — switching to an organization with no workspace', () => {
  it('enters the empty org: the shell names it, with no workspace and none of the old org’s', async () => {
    const { user, orgB } = await ownerOfAnEmptyOrg();

    await switchOrganizationAction(orgB.id);

    expect(cookieJar.get(ORGANIZATION_COOKIE_NAME)).toBe(orgB.id);
    // The old org's workspace pin is cleared, not left to outrank the org.
    expect(cookieJar.has(WORKSPACE_COOKIE_NAME)).toBe(false);
    // No workspace — so no page is reached by way of the old org's workspace.
    expect(await getWorkspaceContext()).toBeNull();

    const { currentOrg, workspaces } = await resolveActiveOrganizationAsShell(user.id);
    expect(currentOrg?.organization.id).toBe(orgB.id);
    // The workspace tier, scoped to the active org, is empty.
    expect(workspaces.filter((w) => w.organizationId === orgB.id)).toHaveLength(0);
    // And nothing was minted behind the user's back.
    expect(await adminDb.workspace.count({ where: { organizationId: orgB.id } })).toBe(0);
  });

  it('switching back to the org with a workspace re-pins it', async () => {
    const { user, wsA, orgA, orgB } = await ownerOfAnEmptyOrg();

    await switchOrganizationAction(orgB.id);
    await switchOrganizationAction(orgA);

    expect(cookieJar.get(WORKSPACE_COOKIE_NAME)).toBe(wsA.id);
    expect(await getWorkspaceContext()).toEqual({ userId: user.id, workspaceId: wsA.id });
    const { currentOrg } = await resolveActiveOrganizationAsShell(user.id);
    expect(currentOrg?.organization.id).toBe(orgA);
  });

  it('a freshly created org is entered, not replaced by the account’s first workspace', async () => {
    const { user, orgA } = await ownerOfAnEmptyOrg();

    const created = await createOrganizationAction('Brand new');

    expect(await getWorkspaceContext()).toBeNull();
    const { currentOrg } = await resolveActiveOrganizationAsShell(user.id);
    expect(currentOrg?.organization.id).toBe(created.id);
    expect(currentOrg?.organization.id).not.toBe(orgA);
  });
});

describe('MOTIR-8777 — the org cookie changes nothing else', () => {
  it('a valid workspace pin still wins', async () => {
    const { user, wsA, orgB } = await ownerOfAnEmptyOrg();
    cookieJar.set(ORGANIZATION_COOKIE_NAME, orgB.id);

    expect(await getWorkspaceContext()).toEqual({ userId: user.id, workspaceId: wsA.id });
  });

  it('an org cookie naming an org WITH workspaces keeps the default fallback', async () => {
    const { user, wsA, orgA } = await ownerOfAnEmptyOrg();
    cookieJar.delete(WORKSPACE_COOKIE_NAME);
    cookieJar.set(ORGANIZATION_COOKIE_NAME, orgA);

    expect(await getWorkspaceContext()).toEqual({ userId: user.id, workspaceId: wsA.id });
  });

  it('an org cookie naming an org the user is NOT in keeps the default fallback', async () => {
    const { user, wsA } = await ownerOfAnEmptyOrg();
    const stranger = await createTestUser();
    const foreign = await organizationsService.createOrganization({
      name: 'Elsewhere',
      actorUserId: stranger.id,
    });
    cookieJar.delete(WORKSPACE_COOKIE_NAME);
    cookieJar.set(ORGANIZATION_COOKIE_NAME, foreign.id);

    expect(await getWorkspaceContext()).toEqual({ userId: user.id, workspaceId: wsA.id });
  });

  it('an org whose workspaces the owner joined none of is not empty', async () => {
    const { user, orgB } = await ownerOfAnEmptyOrg();
    const colleague = await createTestUser();
    await adminDb.organizationMembership.create({
      data: { organizationId: orgB.id, userId: colleague.id, role: 'admin' },
    });
    await workspacesService.createWorkspace({
      name: 'Theirs',
      ownerUserId: colleague.id,
      organizationId: orgB.id,
    });

    expect(await workspacesService.isEmptyOrganizationOfMember(user.id, orgB.id)).toBe(false);
    expect(await workspacesService.isEmptyOrganizationOfMember(colleague.id, orgB.id)).toBe(false);
  });
});
