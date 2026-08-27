import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Story MOTIR-1215 · Subtask MOTIR-3649 — THE STORY-LEVEL GATE.
//
// Every card in this story ships its own tests, and every one of them looks at
// a single piece. This file is the only thing that looks at the assembled
// machine, and it has two jobs the per-card suites structurally cannot do.
//
// ⚠️ 1. THE SEAMS. A policy written by an admin PANE and read by the ENFORCEMENT
// GATE crosses four layers and two request scopes. A unit test on either side
// mocks the other, so the join is exactly where a rename, a wrong binding or a
// tier-precedence slip survives a green suite. Real Postgres, real services, no
// mock of the policy service and none of Prisma — the single sanctioned mock is
// `getSession`, because the suite has no cookies (CLAUDE.md).
//
// ⚠️ 2. THE GUARDS, WATCHED FAILING. This story adds four structural guards, and
// a guard nobody has watched go red is indistinguishable from a guard that never
// runs. Each one's SWEEP now takes its root as a parameter
// (`tests/helpers/twoFactorGuardSweeps.ts`), so the block at the bottom builds a
// tiny tree in a temp directory with ONE violation in it, asserts the sweep
// reports exactly that, removes it, and asserts the sweep goes quiet. No
// hand-editing the repository and putting it back.

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: vi.fn() };
});

// The workspace door reads a cookie; the org action reads one too. The suite has
// no request scope, so the store is a plain map the fixtures drive.
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
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

const { db } = await import('@/lib/db');
const { getSession } = await import('@/lib/auth');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { twoFactorPolicyService } = await import('@/lib/services/twoFactorPolicyService');
const { ORGANIZATION_COOKIE_NAME } = await import('@/lib/organizations/cookie');
const { WORKSPACE_COOKIE_NAME } = await import('@/lib/workspaces');
const { ORGANIZATION_ROLE } = await import('@/lib/organizations/roles');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const {
  apiAuthFiles,
  declaringFiles,
  libFilesContainingIn,
  ungatedApiFiles,
  ungatedRouteGroups,
  uncoveredProxySegments,
} = await import('../helpers/twoFactorGuardSweeps');

const setOrgPolicyAction = (await import('@/app/(authed)/settings/organization/security/actions'))
  .setOrganizationRequireTwoFactorAction;
const setWorkspacePolicyAction = (
  await import('@/app/(authed)/settings/workspace/security/actions')
).setWorkspaceRequireTwoFactorAction;

const { requireCompliantSession } = await import('@/lib/auth/requireCompliantSession');

beforeEach(async () => {
  vi.clearAllMocks();
  cookieJar.clear();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function makeUser(name = 'Ada') {
  const email = `two-factor-story-${++seq}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  return { ...user, email };
}

/** One org, one workspace, one owner — the shape every account starts in. */
async function makeOrgWithWorkspace(name = 'Acme') {
  const owner = await makeUser();
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  return { owner, workspace, organizationId: workspace.organizationId };
}

/** Sign in as this person, with these tiers bound in the cookie jar. */
function signIn(
  user: { id: string; email: string },
  bind: { organizationId?: string; workspaceId?: string } = {},
): void {
  vi.mocked(getSession).mockResolvedValue({
    user: { id: user.id, email: user.email, name: 'Ada' },
  } as never);
  if (bind.organizationId) cookieJar.set(ORGANIZATION_COOKIE_NAME, bind.organizationId);
  if (bind.workspaceId) cookieJar.set(WORKSPACE_COOKIE_NAME, bind.workspaceId);
}

/** Fixture setup, never the code under test. */
const setOrgColumn = (organizationId: string, requiresTwoFactor: boolean) =>
  adminDb.organization.update({ where: { id: organizationId }, data: { requiresTwoFactor } });
const setWorkspaceColumn = (workspaceId: string, requiresTwoFactor: boolean) =>
  adminDb.workspace.update({ where: { id: workspaceId }, data: { requiresTwoFactor } });

/** Enrol by PASSKEY — deliberately, since it leaves `twoFactorEnabled` false. */
const enrolByPasskey = (userId: string) =>
  adminDb.passkey.create({
    data: {
      id: `pk_${userId}`,
      name: 'YubiKey',
      publicKey: 'pub',
      userId,
      credentialID: `cred_${userId}`,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: 'usb',
    },
  });

// ════════════════════════════════════════════════════════════════════════════
// 1. THE PRECEDENCE MATRIX, over real rows
// ════════════════════════════════════════════════════════════════════════════

describe('the precedence matrix — org × workspace, against real rows', () => {
  const MATRIX = [
    { org: false, ws: false, required: false, tier: null },
    { org: false, ws: true, required: true, tier: 'workspace' as const },
    { org: true, ws: false, required: true, tier: 'organization' as const },
    { org: true, ws: true, required: true, tier: 'organization' as const },
  ];

  it.each(MATRIX)(
    'org=$org workspace=$ws ⇒ required=$required, mandatedBy=$tier',
    async ({ org, ws, required, tier }) => {
      const { owner, workspace, organizationId } = await makeOrgWithWorkspace('Acme');
      if (org) await setOrgColumn(organizationId, true);
      if (ws) await setWorkspaceColumn(workspace.id, true);

      const dto = await twoFactorPolicyService.resolveRequirement(owner.id);

      expect(dto.required).toBe(required);
      if (tier === null) expect(dto.mandatedBy).toBeNull();
      else expect(dto.mandatedBy).toMatchObject({ tier });
    },
  );

  it('⚠️ the ORGANIZATION wins when both ask — the floor names its own owner', async () => {
    // Not cosmetic. The workspace control renders LOCKED with "required by your
    // organization", and that lock is computed from which tier `mandatedBy`
    // names. Answer `workspace` here and a workspace admin is shown a switch
    // they appear free to turn off, which would let them escape the org's floor.
    const { owner, workspace, organizationId } = await makeOrgWithWorkspace('Acme');
    await setOrgColumn(organizationId, true);
    await setWorkspaceColumn(workspace.id, true);

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto.mandatedBy).toEqual({ tier: 'organization', id: organizationId, name: 'Acme' });
  });

  it('the matrix is crossed with the ACCOUNT state, which moves `compliant` and not `required`', async () => {
    // Two independent axes, and conflating them is the shape of the passkey
    // regression below: a policy is about the TENANT, compliance is about the
    // PERSON, and a tier that requires nothing leaves an unenrolled account
    // perfectly able to work.
    const { owner, organizationId } = await makeOrgWithWorkspace();
    await setOrgColumn(organizationId, true);

    const held = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(held).toMatchObject({ required: true, compliant: false });

    await enrolByPasskey(owner.id);
    const free = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(free).toMatchObject({ required: true, compliant: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE WRITE-TO-READ ROUND TRIP — the pane's action, the gate's read
// ════════════════════════════════════════════════════════════════════════════

describe('what an admin pane WRITES is what the gate READS', () => {
  it('the ORG action lands, and a member of that org is held on their next request', async () => {
    const { owner, workspace, organizationId } = await makeOrgWithWorkspace('Acme');
    signIn(owner, { organizationId, workspaceId: workspace.id });

    await expect(setOrgPolicyAction(true)).resolves.toEqual({ ok: true });

    // Read back through the ENFORCEMENT path, not through the pane's own read —
    // the seam is between two different queries over one column.
    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto).toMatchObject({ required: true, mandatedBy: { tier: 'organization' } });

    // …and the API gate refuses on the strength of it.
    const gate = await requireCompliantSession();
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.response.status).toBe(403);
  });

  it('the WORKSPACE action lands the same way, at its own tier', async () => {
    const { owner, workspace, organizationId } = await makeOrgWithWorkspace('Acme');
    signIn(owner, { organizationId, workspaceId: workspace.id });

    await expect(setWorkspacePolicyAction(true)).resolves.toEqual({ ok: true });

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto).toMatchObject({
      required: true,
      mandatedBy: { tier: 'workspace', id: workspace.id },
    });
  });

  it('⚠️ the ORG-ON-THEN-OFF round trip leaves the workspace’s own value ALONE', async () => {
    // The lock RENDERS; it does not WRITE THROUGH. A workspace that
    // independently chose to require 2FA must still require it after the org
    // turns its floor off — otherwise switching the org policy on and off again
    // silently disarms every workspace that had made its own decision.
    const { owner, workspace, organizationId } = await makeOrgWithWorkspace('Acme');
    signIn(owner, { organizationId, workspaceId: workspace.id });

    await setWorkspacePolicyAction(true);
    await setOrgPolicyAction(true);
    await setOrgPolicyAction(false);

    const row = await adminDb.workspace.findUnique({ where: { id: workspace.id } });
    expect(row!.requiresTwoFactor).toBe(true);

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto).toMatchObject({ required: true, mandatedBy: { tier: 'workspace' } });
  });

  it('a MEMBER cannot write the org policy through the action — the UI is not the gate', async () => {
    const { workspace, organizationId } = await makeOrgWithWorkspace('Acme');
    const member = await makeUser('Grace');
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: member.id, role: ORGANIZATION_ROLE.member },
    });
    signIn(member, { organizationId, workspaceId: workspace.id });

    // Asserted rather than assumed: this fixture really is a plain member, so a
    // refusal here is the gate refusing and not the role constant resolving to
    // `undefined` and Prisma quietly applying a column default.
    expect(
      (await adminDb.organizationMembership.findFirst({
        where: { organizationId, userId: member.id },
      }))!.role,
    ).toBe('member');

    const result = await setOrgPolicyAction(true);
    expect(result.ok).toBe(false);

    const row = await adminDb.organization.findUnique({ where: { id: organizationId } });
    expect(row!.requiresTwoFactor).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. ⚠️ THE MULTI-WORKSPACE BINDING CASE — the assertion this card is for
// ════════════════════════════════════════════════════════════════════════════

describe('⚠️ the bound read spans every workspace, not the active one', () => {
  /**
   * The fixture is built so the actor's VIEW and the true population DIFFER: two
   * workspaces in one org, only the SECOND requiring 2FA, and the request bound
   * to the FIRST. A fixture where the actor sees everything cannot tell a
   * correctly-bound read from a broken one — it passes either way.
   */
  async function twoWorkspaceFixture() {
    const { owner, workspace: first, organizationId } = await makeOrgWithWorkspace('Acme');
    const { workspace: second } = await workspacesService.createWorkspace({
      name: 'Second',
      ownerUserId: owner.id,
      organizationId,
    });
    await setWorkspaceColumn(second.id, true);
    return { owner, first, second, organizationId };
  }

  it('holds a member whose OTHER workspace requires it, with the active one bound', async () => {
    // The failure this exists to prevent is silent in every direction: a read
    // scoped to the active workspace comes back SHORT, short computes to "no
    // requirement", the query succeeds, nothing is logged, and somebody who
    // should have been stopped walks straight through.
    const { owner, first, second, organizationId } = await twoWorkspaceFixture();
    signIn(owner, { organizationId, workspaceId: first.id });

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto.required).toBe(true);
    expect(dto.mandatedBy).toEqual({ tier: 'workspace', id: second.id, name: 'Second' });
  });

  it('and the API gate refuses on that answer, bound to the wrong workspace', async () => {
    // One layer up from the service: the assembled path a `fetch` actually
    // takes, with the cookie naming the workspace that requires NOTHING.
    const { owner, first, organizationId } = await twoWorkspaceFixture();
    signIn(owner, { organizationId, workspaceId: first.id });

    const gate = await requireCompliantSession();
    expect(gate.ok).toBe(false);
    expect(!gate.ok && (await gate.response.json()).tierName).toBe('Second');
  });

  it('a member of only the QUIET workspace is not held — the OR is over THEIR memberships', async () => {
    // The other direction, and the one that stops the fix from being "return
    // true whenever any workspace anywhere asks".
    const { owner, organizationId } = await twoWorkspaceFixture();
    const { workspace: quiet } = await workspacesService.createWorkspace({
      name: 'Quiet',
      ownerUserId: (await makeUser('Grace')).id,
      organizationId,
    });
    const outsider = await makeUser('Hopper');
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: outsider.id, role: ORGANIZATION_ROLE.member },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: quiet.id, userId: outsider.id, role: 'member' },
    });

    const dto = await twoFactorPolicyService.resolveRequirement(outsider.id);
    expect(dto.required).toBe(false);
    // …on the SAME rows, in the SAME org, where the owner of `second` IS held.
    // Both answers come from one fixture, which is what makes this a statement
    // about the membership join rather than about the policy column.
    expect(await twoFactorPolicyService.resolveRequirement(owner.id)).toMatchObject({
      required: true,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE PASSKEY-ONLY ACCOUNT — the regression this story was named for
// ════════════════════════════════════════════════════════════════════════════

describe('⚠️ a passkey satisfies the requirement, with `twoFactorEnabled` false', () => {
  it('is compliant, and the API gate lets it through', async () => {
    // `lib/dto/twoFactor.ts` wrote the warning addressed to this story: the test
    // is `methods.length > 0`, NOT the column. A naive `enabled` check locks out
    // precisely the people who took the strongest option available.
    const { owner, organizationId } = await makeOrgWithWorkspace();
    await setOrgColumn(organizationId, true);
    await enrolByPasskey(owner.id);
    signIn(owner, { organizationId });

    const row = await adminDb.user.findUnique({ where: { id: owner.id } });
    expect(row!.twoFactorEnabled).toBe(false);

    expect(await twoFactorPolicyService.resolveRequirement(owner.id)).toMatchObject({
      required: true,
      compliant: true,
    });
    expect((await requireCompliantSession()).ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. CROSS-TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════

describe('one tenant’s policy is not another’s', () => {
  it('org B turning it on does not hold a member of org A', async () => {
    const a = await makeOrgWithWorkspace('Alpha');
    const b = await makeOrgWithWorkspace('Beta');
    await setOrgColumn(b.organizationId, true);
    await setWorkspaceColumn(b.workspace.id, true);

    expect(await twoFactorPolicyService.resolveRequirement(a.owner.id)).toMatchObject({
      required: false,
      mandatedBy: null,
    });
    expect(await twoFactorPolicyService.resolveRequirement(b.owner.id)).toMatchObject({
      required: true,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. THE ONE UNCOVERED ARM, and the invariant that makes it dead
// ════════════════════════════════════════════════════════════════════════════

describe('the `!workspace` arm in getWorkspacePolicy is unreachable, and here is why', () => {
  it('⚠️ a workspace_membership cannot outlive its workspace — the FK cascades', async () => {
    // `lib/services/twoFactorPolicyService.ts` resolves ACCESS first and only
    // then loads the workspace row, so `if (!workspace)` can fire only if a
    // membership existed for a workspace that does not. This is the invariant
    // that forbids it, asserted over a fixture built to violate it: delete the
    // workspace and watch the membership go with it.
    //
    // ⚠️ THIS TEST IS WHAT THE `c8 ignore` DIRECTIVE ON THAT ARM CITES. An
    // ignore with no test to cite hides the gap instead of closing it.
    const { owner, workspace } = await makeOrgWithWorkspace();
    expect(
      await adminDb.workspaceMembership.count({ where: { workspaceId: workspace.id } }),
    ).toBeGreaterThan(0);

    await adminDb.workspace.delete({ where: { id: workspace.id } });

    expect(await adminDb.workspaceMembership.count({ where: { workspaceId: workspace.id } })).toBe(
      0,
    );
    // …so there is no state in which the access gate admits and the row is absent.
    expect(await adminDb.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(owner.id).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. ⚠️ THE FOUR GUARDS, WATCHED FAILING
// ════════════════════════════════════════════════════════════════════════════

/** Write a tiny source tree under a fresh temp root, removed when the file ends. */
const tempRoots: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'motir-guard-'));
  tempRoots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const GATED_LAYOUT = `
import { getSession } from '@/lib/auth';
import { assertTwoFactorCompliance } from '@/lib/auth/twoFactorGate';
export default async function Layout({ children }) {
  const session = await getSession();
  await assertTwoFactorCompliance(session.user.id);
  return children;
}
`;
const UNGATED_LAYOUT = `
import { getSession } from '@/lib/auth';
export default async function Layout({ children }) {
  const session = await getSession();
  return children;
}
`;
const GATED_ROUTE = `
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
export async function GET() {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
}
`;
const UNGATED_ROUTE = `
import { getWorkspaceContext } from '@/lib/workspaces';
export async function GET() {
  const ctx = await getWorkspaceContext();
  if (!ctx) return new Response(null, { status: 401 });
}
`;
const PAGE = 'export default function Page() { return null; }\n';

describe('⚠️ the route-group totality guard FAILS on an ungated group', () => {
  it('names the offender, and goes quiet once it gates', () => {
    const app = join(
      tree({
        'app/(authed)/layout.tsx': GATED_LAYOUT,
        'app/(planning)/layout.tsx': UNGATED_LAYOUT,
        'app/(auth)/layout.tsx': UNGATED_LAYOUT,
      }),
      'app',
    );
    const exempt = new Set(['(auth)']);

    expect(ungatedRouteGroups(app, exempt)).toEqual(['(planning)']);

    writeFileSync(join(app, '(planning)/layout.tsx'), GATED_LAYOUT, 'utf8');
    expect(ungatedRouteGroups(app, exempt)).toEqual([]);
  });

  it('a MENTION in a comment does not count as a call', () => {
    // The sweep strips comments, and it has to: a layout whose header explains
    // why it does NOT gate would otherwise read as gated.
    const app = join(
      tree({
        'app/(planning)/layout.tsx': `// TODO: call assertTwoFactorCompliance here\n${UNGATED_LAYOUT}`,
      }),
      'app',
    );
    expect(ungatedRouteGroups(app, new Set())).toEqual(['(planning)']);
  });
});

describe('⚠️ the API guard FAILS on an ungated route', () => {
  it('names the offender, and goes quiet once it gates', () => {
    const root = tree({
      'app/api/notifications/route.ts': GATED_ROUTE,
      'app/api/items/route.ts': UNGATED_ROUTE,
    });
    const api = join(root, 'app/api');

    expect(ungatedApiFiles(root, api, new Set()).map((f) => f.rel)).toEqual([
      'app/api/items/route.ts',
    ]);

    writeFileSync(join(api, 'items/route.ts'), GATED_ROUTE, 'utf8');
    expect(ungatedApiFiles(root, api, new Set())).toEqual([]);
  });

  it('⚠️ counts a FOLDED route as authenticating, though it names no door', () => {
    // The subtle half. Once a route folds its preamble into the gate, the words
    // `getSession` / `getWorkspaceContext` leave its source — so an enumeration
    // by door alone sees the RESIDUE of the sweep and calls it the API.
    const root = tree({ 'app/api/notifications/route.ts': GATED_ROUTE });
    const files = apiAuthFiles(root, join(root, 'app/api'));

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ reads: 0, gated: true });
  });

  it('⚠️ an IMPORT of the gate module is not a CALL of the gate', () => {
    // Every gated file imports from `@/lib/auth/requireCompliantSession`, so a
    // bare substring test matches the module PATH and reports a route adopted
    // when it only imported a type.
    const root = tree({
      'app/api/items/route.ts': `import type { TwoFactorRequiredBody } from '@/lib/auth/requireCompliantSession';\n${UNGATED_ROUTE}`,
    });
    expect(ungatedApiFiles(root, join(root, 'app/api'), new Set()).map((f) => f.rel)).toEqual([
      'app/api/items/route.ts',
    ]);
  });
});

describe('⚠️ the proxy-matcher totality guard FAILS on an uncovered segment', () => {
  it('names the segment, and goes quiet once the matcher lists it', () => {
    const app = join(
      tree({
        'app/(authed)/items/page.tsx': PAGE,
        'app/(authed)/roadmap/page.tsx': PAGE,
      }),
      'app',
    );
    const groups = ['(authed)'];

    expect(uncoveredProxySegments(app, groups, ['/items/:path*'])).toEqual(['roadmap']);
    expect(uncoveredProxySegments(app, groups, ['/items/:path*', '/roadmap/:path*'])).toEqual([]);
  });

  it('a directory that serves NO page contributes no segment', () => {
    // `_private` folders and component directories are not routes, and counting
    // them would make the guard demand matcher entries for paths nobody serves.
    const app = join(
      tree({
        'app/(authed)/items/page.tsx': PAGE,
        'app/(authed)/_components/Thing.tsx': PAGE,
        'app/(authed)/helpers/util.ts': 'export const x = 1;\n',
      }),
      'app',
    );
    expect(uncoveredProxySegments(app, ['(authed)'], ['/items/:path*'])).toEqual([]);
  });
});

describe('⚠️ the one-implementation guards FAIL on a second copy', () => {
  it('a second `hasSecondFactor` declaration is reported', () => {
    const root = tree({
      'lib/twoFactor/hasSecondFactor.ts':
        'export function hasSecondFactor(i) { return i.enabled || i.passkeyCount >= 1; }\n',
      'lib/services/shadowService.ts': 'export function hasSecondFactor(i) { return i.enabled; }\n',
    });

    expect(declaringFiles(join(root, 'lib'), root, 'hasSecondFactor')).toEqual([
      'lib/services/shadowService.ts',
      'lib/twoFactor/hasSecondFactor.ts',
    ]);
  });

  it('a NEW reader of `twoFactorEnabled` outside the allowlist is reported', () => {
    const root = tree({
      'lib/twoFactor/hasSecondFactor.ts': '// twoFactorEnabled is NOT the test\n',
      'lib/services/rogueService.ts': 'export const ok = (u) => u.twoFactorEnabled;\n',
    });

    expect(libFilesContainingIn(root, 'twoFactorEnabled')).toEqual([
      'lib/services/rogueService.ts',
      'lib/twoFactor/hasSecondFactor.ts',
    ]);
  });

  it('the real tree still holds exactly one of each', () => {
    // The positive statement, so the block above cannot pass by testing only
    // synthetic trees.
    const lib = join(process.cwd(), 'lib');
    expect(declaringFiles(lib, process.cwd(), 'hasSecondFactor')).toEqual([
      'lib/twoFactor/hasSecondFactor.ts',
    ]);
    expect(declaringFiles(lib, process.cwd(), 'assertTwoFactorCompliance')).toEqual([
      'lib/auth/twoFactorGate.ts',
    ]);
    expect(declaringFiles(lib, process.cwd(), 'resolveTwoFactorHold')).toEqual([
      'lib/auth/requireCompliantSession.ts',
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. ONE SWITCH COMPONENT
// ════════════════════════════════════════════════════════════════════════════

describe('the require-2FA switch is ONE component with two hosts', () => {
  it('`RequireTwoFactorCard` is declared exactly once in the tree', async () => {
    // Two hosts, one control: the standalone panes and the organization-tier
    // fold-in all mount the same file. A second copy is how the org and
    // workspace surfaces drift apart, and the one nobody is looking at drifts
    // first.
    const { walkSources } = await import('../helpers/twoFactorGuardSweeps');
    const found = walkSources(join(process.cwd(), 'app')).filter((p) =>
      p.endsWith('RequireTwoFactorCard.tsx'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.includes('settings/organization/_components/')).toBe(true);
  });
});
