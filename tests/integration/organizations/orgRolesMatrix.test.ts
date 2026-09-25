import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawSubscriptionResponse, RawUsageResponse } from '@/lib/ai/types';
import { adminDb } from '../../helpers/adminDb';

// THE ORG-ROLES CAPABILITY MATRIX, END TO END (Story MOTIR-6167 · MOTIR-6315).
//
// Each code card of the story tests its own piece. This suite asks the question
// none of them can: does every DOOR the story gates agree with the one table
// that says who may do what (`lib/organizations/capabilities.ts`)? Every route
// row below is driven as each of Owner, Admin, Member and non-member, against
// the real database, and the status each gets is DERIVED from `orgCan` — never
// retyped. So a route that forgets the rule fails here, and a capability added
// to the table without a door fails the coverage unit at the bottom.
//
// The boundary mocks are the ones every org route test uses: the session (no
// cookie in the test env), the motir-ai HTTP leaf (an external network call) and
// the post-commit seat-sync ENQUEUE that membership writes fire.

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const usage: RawUsageResponse = {
  scope: 'org',
  coreOrganizationId: 'o',
  coreWorkspaceId: null,
  coreProjectId: null,
  balance: 1420,
  tier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
  totalSpend: 580,
  monthSpend: 580,
  monthlyHistory: [],
  perModel: [],
  recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
};
const subscription: RawSubscriptionResponse = {
  status: 'active',
  currentPeriodEnd: '2026-07-22T00:00:00.000Z',
  priceId: 'price_standard',
  planTier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
};
vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: async () => usage,
  getOrgSubscription: async () => subscription,
  createCheckoutSession: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_1' }),
  createPortalSession: async () => ({ url: 'https://billing.stripe.com/p/session/1' }),
  setSeatQuantity: async () => ({ applied: true, outcome: 'updated' }),
}));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { ORG_CAPABILITY_KEYS, orgCan } = await import('@/lib/organizations/capabilities');
type OrgCapability = import('@/lib/organizations/capabilities').OrgCapability;
const orgRoute = await import('@/app/api/organizations/[orgId]/route');
const transferRoute = await import('@/app/api/organizations/[orgId]/ownership-transfer/route');
const workspacesRoute = await import('@/app/api/organizations/[orgId]/workspaces/route');
const workspaceRoute =
  await import('@/app/api/organizations/[orgId]/workspaces/[workspaceId]/route');
const membersRoute = await import('@/app/api/organizations/[orgId]/members/route');
const memberRoute = await import('@/app/api/organizations/[orgId]/members/[userId]/route');
const billingRoute = await import('@/app/api/organizations/[orgId]/billing/route');
const checkoutRoute = await import('@/app/api/organizations/[orgId]/billing/checkout/route');
const portalRoute = await import('@/app/api/organizations/[orgId]/billing/portal/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { twoFactorPolicyService } = await import('@/lib/services/twoFactorPolicyService');
const { createTestUser } = await import('../../fixtures/userFixtures');
const { createTestProject } = await import('../../fixtures/projectFixtures');
const { createTestWorkItem } = await import('../../fixtures/workItemFixtures');
const { truncateAuthTables } = await import('../../helpers/db');
const { OrganizationNotFoundError, OrgForbiddenError } = await import('@/lib/organizations/errors');

type Actor = 'owner' | 'admin' | 'member' | 'outsider';
const ACTORS: Actor[] = ['owner', 'admin', 'member', 'outsider'];
type User = { id: string; email: string };

/**
 * One org holding every role the matrix drives, plus the targets the doors act
 * on: `carol` (a Member the member doors change and remove, and the transfer's
 * target), `invitee` (a user outside the org the add door enrols) and `spare` (a
 * workspace the remove door removes, which the Admin is NOT a member of).
 */
async function makeOrg() {
  const owner = await createTestUser();
  const { workspace: home } = await workspacesService.createWorkspace({
    name: 'Home',
    ownerUserId: owner.id,
  });
  const organizationId = home.organizationId;
  const orgName = (await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } }))
    .name;
  const add = async (role: 'admin' | 'member') => {
    const user = await createTestUser();
    await organizationsService.addMember({
      organizationId,
      userId: user.id,
      role,
      actorUserId: owner.id,
    });
    return user;
  };
  const admin = await add('admin');
  const member = await add('member');
  const carol = await add('member');
  const outsider = await createTestUser();
  const invitee = await createTestUser();
  const { workspace: spare } = await workspacesService.createWorkspace({
    name: 'Spare',
    ownerUserId: owner.id,
    organizationId,
  });
  const users: Record<Actor, User> = { owner, admin, member, outsider };
  return { organizationId, orgName, home, spare, carol, invitee, users };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

function signInAs(user: User) {
  session.current = { user: { id: user.id, email: user.email } };
}

function req(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * A door the story gates. `call` returns the HTTP status (a route) or throws the
 * typed error a route would map (the create path, whose one entry is a Server
 * Action — `createWorkspaceAction` — over this exact service call).
 */
interface Door {
  name: string;
  /** The status a HOLDER of the capability gets. */
  ok: number;
  call(org: Org, actor: User): Promise<number>;
}

/**
 * Billing is CLOUD-ONLY (`billing-tiering.md` §6), and so are the plan caps — so
 * cloud is switched on for the billing doors alone. With it on for the whole
 * suite, the free plan's one-workspace cap refuses the fixture's second
 * workspace before any door is reached.
 */
async function withCloud<T>(fn: () => Promise<T>): Promise<T> {
  process.env['MOTIR_CLOUD'] = 'true';
  try {
    return await fn();
  } finally {
    delete process.env['MOTIR_CLOUD'];
  }
}

async function serviceStatus(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (err) {
    if (err instanceof OrganizationNotFoundError) return 404;
    if (err instanceof OrgForbiddenError) return 403;
    throw err;
  }
}

/**
 * THE MATRIX, keyed by capability. A `Record` over the closed union, so a
 * capability added to the table is a compile error here until it names its
 * doors — or states, with the work item that owns it, why it has none yet.
 */
const DOORS: Record<OrgCapability, Door[] | { deferredTo: string; why: string }> = {
  deleteOrganization: {
    deferredTo: 'MOTIR-6306',
    why:
      'Deleting an organization has no door yet: the danger zone keeps its row disabled and the ' +
      'deletion itself (a decision, a scheduled erasure, the motir-ai offboarding) is the ' +
      'org-deletion story. That story adds its route to this table.',
  },
  transferOwnership: [
    {
      name: 'POST …/ownership-transfer',
      ok: 200,
      call: async (org) =>
        (
          await transferRoute.POST(
            req(`/api/organizations/${org.organizationId}/ownership-transfer`, 'POST', {
              toUserId: org.carol.id,
              confirmName: org.orgName,
            }),
            { params: Promise.resolve({ orgId: org.organizationId }) },
          )
        ).status,
    },
  ],
  manageWorkspaces: [
    {
      name: 'createWorkspace (the Server Action’s service call)',
      ok: 200,
      call: (org, actor) =>
        serviceStatus(() =>
          workspacesService.createWorkspace({
            name: 'Made in the matrix',
            ownerUserId: actor.id,
            organizationId: org.organizationId,
          }),
        ),
    },
    {
      name: 'GET …/workspaces',
      ok: 200,
      call: async (org) =>
        (
          await workspacesRoute.GET(
            req(`/api/organizations/${org.organizationId}/workspaces`, 'GET'),
            {
              params: Promise.resolve({ orgId: org.organizationId }),
            },
          )
        ).status,
    },
    {
      name: 'DELETE …/workspaces/[workspaceId]',
      ok: 200,
      call: async (org) =>
        (
          await workspaceRoute.DELETE(
            req(`/api/organizations/${org.organizationId}/workspaces/${org.spare.id}`, 'DELETE'),
            { params: Promise.resolve({ orgId: org.organizationId, workspaceId: org.spare.id }) },
          )
        ).status,
    },
  ],
  manageOrgSettings: [
    {
      name: 'PATCH …/[orgId] (rename)',
      ok: 200,
      call: async (org) =>
        (
          await orgRoute.PATCH(
            req(`/api/organizations/${org.organizationId}`, 'PATCH', { name: 'Renamed Co' }),
            { params: Promise.resolve({ orgId: org.organizationId }) },
          )
        ).status,
    },
    {
      // The security setting. Its door is the Security page's Server Action,
      // which is this one service call. `false` is the no-op value, so the row
      // measures the gate and not the 2FA-enrolment rule behind `true`.
      // (`GET …/usage` is deliberately NOT a row: it admits every member and
      // NARROWS a Member's scope to their own workspaces, so it is not gated by
      // this capability — `aiUsageService.getUsage`.)
      name: 'setOrganizationPolicy (the Security action’s service call)',
      ok: 200,
      call: (org, actor) =>
        serviceStatus(() =>
          twoFactorPolicyService.setOrganizationPolicy({
            organizationId: org.organizationId,
            actorUserId: actor.id,
            requiresTwoFactor: false,
          }),
        ),
    },
  ],
  manageBilling: [
    {
      name: 'GET …/billing',
      ok: 200,
      call: (org) =>
        withCloud(
          async () =>
            (
              await billingRoute.GET(
                req(`/api/organizations/${org.organizationId}/billing`, 'GET'),
                {
                  params: Promise.resolve({ orgId: org.organizationId }),
                },
              )
            ).status,
        ),
    },
    {
      name: 'POST …/billing/checkout',
      ok: 200,
      call: (org) =>
        withCloud(
          async () =>
            (
              await checkoutRoute.POST(
                req(`/api/organizations/${org.organizationId}/billing/checkout`, 'POST', {
                  priceLookupKey: 'pro_pool_annual',
                }),
                { params: Promise.resolve({ orgId: org.organizationId }) },
              )
            ).status,
        ),
    },
    {
      name: 'POST …/billing/portal',
      ok: 200,
      call: (org) =>
        withCloud(
          async () =>
            (
              await portalRoute.POST(
                req(`/api/organizations/${org.organizationId}/billing/portal`, 'POST'),
                { params: Promise.resolve({ orgId: org.organizationId }) },
              )
            ).status,
        ),
    },
  ],
  manageOrgMembers: [
    {
      name: 'POST …/members (add)',
      ok: 201,
      call: async (org) =>
        (
          await membersRoute.POST(
            req(`/api/organizations/${org.organizationId}/members`, 'POST', {
              email: org.invitee.email,
              role: 'member',
            }),
            { params: Promise.resolve({ orgId: org.organizationId }) },
          )
        ).status,
    },
    {
      name: 'PATCH …/members/[userId] (Member → Admin)',
      ok: 200,
      call: async (org) =>
        (
          await memberRoute.PATCH(
            req(`/api/organizations/${org.organizationId}/members/${org.carol.id}`, 'PATCH', {
              role: 'admin',
            }),
            { params: Promise.resolve({ orgId: org.organizationId, userId: org.carol.id }) },
          )
        ).status,
    },
    {
      name: 'DELETE …/members/[userId] (remove)',
      ok: 200,
      call: async (org) =>
        (
          await memberRoute.DELETE(
            req(`/api/organizations/${org.organizationId}/members/${org.carol.id}`, 'DELETE'),
            { params: Promise.resolve({ orgId: org.organizationId, userId: org.carol.id }) },
          )
        ).status,
    },
  ],
};

/** The status an actor must get: the holder's success, else 403, a non-member 404. */
function expectedStatus(actor: Actor, capability: OrgCapability, door: Door): number {
  if (actor === 'outsider') return 404;
  return orgCan(actor, capability) ? door.ok : 403;
}

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  delete process.env['MOTIR_CLOUD'];
  process.env['MOTIR_BASE_URL'] = 'https://app.test';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_BASE_URL'];
});

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('the capability matrix — every gated door, as every org role', () => {
  for (const capability of ORG_CAPABILITY_KEYS) {
    const doors = DOORS[capability];
    if (!Array.isArray(doors)) continue;
    for (const door of doors) {
      for (const actor of ACTORS) {
        const want = expectedStatus(actor, capability, door);
        it(`${capability} · ${door.name} · ${actor} → ${want}`, async () => {
          const org = await makeOrg();
          signInAs(org.users[actor]);
          expect(await door.call(org, org.users[actor])).toBe(want);
        });
      }
    }
  }
});

describe('the Owner’s own membership is out of every member door’s reach', () => {
  // Not a capability row: the table says an Admin MAY manage members, and the
  // Owner's row is the one exception, held by `OwnerMembershipLockedError`
  // (409) whoever acts — the Owner included. A Member is refused by the
  // capability first (403) and a non-member never learns the org exists (404).
  const LOCKED: Record<Actor, number> = { owner: 409, admin: 409, member: 403, outsider: 404 };

  for (const actor of ACTORS) {
    it(`PATCH the Owner's role · ${actor} → ${LOCKED[actor]}`, async () => {
      const org = await makeOrg();
      signInAs(org.users[actor]);
      const ownerId = org.users.owner.id;
      const res = await memberRoute.PATCH(
        req(`/api/organizations/${org.organizationId}/members/${ownerId}`, 'PATCH', {
          role: 'member',
        }),
        { params: Promise.resolve({ orgId: org.organizationId, userId: ownerId }) },
      );
      expect(res.status).toBe(LOCKED[actor]);
      const owners = await adminDb.organizationMembership.findMany({
        where: { organizationId: org.organizationId, role: 'owner' },
      });
      expect(owners.map((m) => m.userId)).toEqual([ownerId]);
    });

    it(`DELETE the Owner's membership · ${actor} → ${LOCKED[actor]}`, async () => {
      const org = await makeOrg();
      signInAs(org.users[actor]);
      const ownerId = org.users.owner.id;
      const res = await memberRoute.DELETE(
        req(`/api/organizations/${org.organizationId}/members/${ownerId}`, 'DELETE'),
        { params: Promise.resolve({ orgId: org.organizationId, userId: ownerId }) },
      );
      expect(res.status).toBe(LOCKED[actor]);
      expect(
        await adminDb.organizationMembership.count({
          where: { organizationId: org.organizationId, userId: ownerId, role: 'owner' },
        }),
      ).toBe(1);
    });
  }

  it('no member door grants the Owner role — POST and PATCH with role `owner` are refused', async () => {
    const org = await makeOrg();
    signInAs(org.users.admin);
    const add = await membersRoute.POST(
      req(`/api/organizations/${org.organizationId}/members`, 'POST', {
        email: org.invitee.email,
        role: 'owner',
      }),
      { params: Promise.resolve({ orgId: org.organizationId }) },
    );
    expect(add.status).toBe(409);
    const change = await memberRoute.PATCH(
      req(`/api/organizations/${org.organizationId}/members/${org.carol.id}`, 'PATCH', {
        role: 'owner',
      }),
      { params: Promise.resolve({ orgId: org.organizationId, userId: org.carol.id }) },
    );
    expect(change.status).toBe(400);
  });
});

describe('the Owner writes in a PRIVATE project of a workspace they never joined', () => {
  async function foreignPrivateItem(org: Org) {
    // The Admin creates the workspace, so the Owner holds no membership in it.
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Sales',
      ownerUserId: org.users.admin.id,
      organizationId: org.organizationId,
    });
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: org.users.admin.id,
      identifier: 'SALE',
    });
    await adminDb.project.update({ where: { id: project.id }, data: { accessLevel: 'private' } });
    const item = await createTestWorkItem(
      {
        owner: org.users.admin,
        workspace,
        project,
        ownerId: org.users.admin.id,
        workspaceId: workspace.id,
        projectId: project.id,
        projectIdentifier: project.identifier,
        ctx: { userId: org.users.admin.id, workspaceId: workspace.id },
      } as never,
      { kind: 'task', title: 'Close the quarter' },
    );
    return { workspace, item };
  }

  it('the Owner’s title edit saves; a Member outside the workspace is refused', async () => {
    const org = await makeOrg();
    const { workspace, item } = await foreignPrivateItem(org);
    expect(
      await adminDb.workspaceMembership.count({
        where: { workspaceId: workspace.id, userId: org.users.owner.id },
      }),
    ).toBe(0);

    const updated = await workItemsService.updateWorkItem(
      item.id,
      { title: 'Close the quarter — owner edit' },
      { userId: org.users.owner.id, workspaceId: workspace.id },
    );
    expect(updated.title).toBe('Close the quarter — owner edit');

    await expect(
      workItemsService.updateWorkItem(
        item.id,
        { title: 'member edit' },
        { userId: org.users.member.id, workspaceId: workspace.id },
      ),
    ).rejects.toThrow();
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.title).toBe('Close the quarter — owner edit');
  });
});

describe('the matrix covers the table', () => {
  it('every capability has at least one door row, or a named deferral to the work item that owns it', () => {
    for (const capability of ORG_CAPABILITY_KEYS) {
      const doors = DOORS[capability];
      if (Array.isArray(doors)) {
        expect(doors.length, capability).toBeGreaterThan(0);
      } else {
        expect(doors.deferredTo, capability).toMatch(/^MOTIR-\d+$/);
      }
    }
  });

  it('only deleteOrganization is deferred — any other capability without a door is a gap', () => {
    const deferred = ORG_CAPABILITY_KEYS.filter((c) => !Array.isArray(DOORS[c]));
    expect(deferred).toEqual(['deleteOrganization']);
  });
});
