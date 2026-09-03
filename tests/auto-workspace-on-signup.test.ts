import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withUserContext } from '@/lib/workspaces/context';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Subtask 1.2.4 — auto-create a default workspace on user signup.
//
// Two mechanisms under test:
//   1. The Better-Auth databaseHooks.user.create.after hook (lib/auth):
//      fires for every user-create — email/password sign-up AND Google
//      new-user sign-up. The Google *linking* path (email-first user later
//      using Google) does NOT create a user, so the hook does not fire.
//   2. workspacesService.ensureDefaultWorkspace: the idempotent,
//      concurrency-safe lazy self-heal that backstops the hook (the hook is
//      best-effort post-commit, NOT atomic with the user insert).
//
// Real Postgres; truncate between tests (CLAUDE.md: never mock the DB).

const BASE_URL = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspacesForUser(userId: string) {
  return adminDb.workspaceMembership.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: 'asc' },
  });
}

describe('email/password sign-up (Better-Auth databaseHooks)', () => {
  it('creates exactly one workspace + owner membership named "{name}\'s Workspace"', async () => {
    await auth.api.signUpEmail({
      body: {
        email: 'alice@example.com',
        password: 'hunter2hunter2',
        name: 'Alice',
      },
      headers: { origin: BASE_URL },
    });

    const user = await adminDb.user.findUnique({ where: { email: 'alice@example.com' } });
    expect(user).not.toBeNull();

    const memberships = await workspacesForUser(user!.id);
    expect(memberships).toHaveLength(1);
    // The auto-created workspace's sole member is its creator → owner (1.6.5).
    expect(memberships[0]!.role).toBe('owner');
    expect(memberships[0]!.workspace.name).toBe("Alice's Workspace");
    expect(memberships[0]!.workspace.slug).toBe('alice-s-workspace');

    // Exactly one workspace row total — the hook didn't double-fire.
    const workspaceCount = await adminDb.workspace.count();
    expect(workspaceCount).toBe(1);
  });
});

describe('Google new-user sign-up (same databaseHook, OAuth path)', () => {
  // The OAuth full round-trip is covered end-to-end by
  // tests/e2e/auth-google.spec.ts. Here we exercise the SAME post-commit
  // hook Better-Auth runs after inserting an OAuth user — a database hook
  // is keyed on the table write, not the auth method, so invoking the
  // registered after-hook against a freshly-created OAuth user is a
  // faithful unit-level test of "Google new-user → one workspace".
  it('creates one workspace when Better-Auth creates a Google user', async () => {
    const gUser = await usersService.findOrCreateOAuthUser({
      provider: 'google',
      providerAccountId: 'google-new-001',
      email: 'georgia@example.com',
      name: 'Georgia',
    });
    // findOrCreateOAuthUser does NOT route through Better-Auth's hooked
    // adapter, so no workspace exists yet — mirror the post-commit hook
    // Better-Auth would fire after its own OAuth user insert.
    const workspaceCount = await adminDb.workspace.count();
    expect(workspaceCount).toBe(0);

    const afterHook = auth.options.databaseHooks?.user?.create?.after;
    expect(afterHook).toBeTypeOf('function');
    // Better-Auth passes the after-hook a second argument — the endpoint
    // context — which our hook ignores. Both are supplied here because
    // `auth.options` is now typed by `BetterAuthOptions` (MOTIR-4293 gave the
    // instance an explicit type so the app project can emit its declaration),
    // and that type declares the hook's real two-argument arity. The call is
    // unchanged in what it exercises: the hook reads only its first argument.
    await afterHook!(gUser as never, undefined as never);

    const memberships = await workspacesForUser(gUser.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.workspace.name).toBe("Georgia's Workspace");
    const workspaceCount2 = await adminDb.workspace.count();
    expect(workspaceCount2).toBe(1);
  });
});

describe('email-first user who later links Google', () => {
  it('does NOT get a second workspace (linking creates no user, so no hook fires)', async () => {
    // Step 1: email/password sign-up via Better-Auth → hook fires, 1 workspace.
    await auth.api.signUpEmail({
      body: {
        email: 'overlap@example.com',
        password: 'hunter2hunter2',
        name: 'Overlap',
      },
      headers: { origin: BASE_URL },
    });
    const user = await adminDb.user.findUnique({ where: { email: 'overlap@example.com' } });
    expect(user).not.toBeNull();
    expect(await workspacesForUser(user!.id)).toHaveLength(1);

    // Step 2: the SAME email later signs in with Google. Better-Auth's
    // account-linking path attaches a google Account row to the EXISTING
    // user — it does not create a user row, so user.create.after never
    // fires. We model the link via findOrCreateOAuthUser (the repo-level
    // auto-link path) and assert no second workspace appears.
    const linked = await usersService.findOrCreateOAuthUser({
      provider: 'google',
      providerAccountId: 'google-overlap-002',
      email: 'overlap@example.com',
      name: 'Overlap',
    });
    expect(linked.id).toBe(user!.id);

    const accounts = await adminDb.account.findMany({ where: { userId: user!.id } });
    expect(accounts.map((a) => a.providerId).sort()).toEqual(['credential', 'google']);

    // Still exactly one workspace — the pre-existing one is preserved.
    expect(await workspacesForUser(user!.id)).toHaveLength(1);
    const workspaceCount = await adminDb.workspace.count();
    expect(workspaceCount).toBe(1);
  });
});

describe('workspacesService.ensureDefaultWorkspace (lazy self-heal)', () => {
  it('backfills a workspace for a user with zero memberships', async () => {
    // A user that exists with no workspace (e.g. the hook missed, or a
    // signup path bypassed it). createUser goes through usersService, not
    // Better-Auth's hooked adapter, so it lands a user with no workspace.
    const user = await usersService.createUser({
      email: 'lonely@example.com',
      password: 'hunter2hunter2',
      name: 'Lonely',
    });
    expect(await workspacesForUser(user.id)).toHaveLength(0);

    const { workspace, membership } = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });
    expect(workspace.name).toBe("Lonely's Workspace");
    expect(membership.userId).toBe(user.id);
    // Creator of the auto-created workspace is its owner (1.6.5).
    expect(membership.role).toBe('owner');

    const memberships = await workspacesForUser(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.workspaceId).toBe(workspace.id);
  });

  it('is idempotent — calling twice yields exactly one workspace', async () => {
    const user = await usersService.createUser({
      email: 'twice@example.com',
      password: 'hunter2hunter2',
      name: 'Twice',
    });

    const first = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });
    const second = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });

    // Same workspace returned both times; no duplicate row.
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(await workspacesForUser(user.id)).toHaveLength(1);
    const workspaceCount = await adminDb.workspace.count();
    expect(workspaceCount).toBe(1);
  });

  it('returns the existing workspace without creating a second when one already exists', async () => {
    const user = await usersService.createUser({
      email: 'has-ws@example.com',
      password: 'hunter2hunter2',
      name: 'HasWs',
    });
    const created = await workspacesService.createWorkspace({
      name: 'Pre-existing',
      ownerUserId: user.id,
    });

    const ensured = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });
    expect(ensured.workspace.id).toBe(created.workspace.id);
    const workspaceCount = await adminDb.workspace.count();
    expect(workspaceCount).toBe(1);
  });

  // MOTIR-2874 — the idempotency guard is a READ, and it was reading through a
  // bare `db.$transaction`. Under `motir_app`, `membership_visible_active_or_own`
  // admits a row on `"workspaceId" = app.workspace_id` OR `"userId" =
  // app.user_id`; this path is resolving the workspace, so only the `_or_own`
  // arm can fire and nothing was binding `app.user_id`. `countByUser` therefore
  // read 0 for a user who already had memberships and the guard failed OPEN.
  //
  // The cases above assert the OUTCOME (one workspace). This one asserts the
  // INPUT the guard actually acts on — a NON-EMPTY count under the restricted
  // role — because the outcome is reachable for the wrong reason and the count
  // is not: a `0` from an unbound read is indistinguishable from a `0` that is
  // the truth, which is exactly why nothing caught this.
  it('sees its own membership count under the restricted role, so a second call mints nothing (MOTIR-2874)', async () => {
    const user = await usersService.createUser({
      email: 'bound-count@example.com',
      password: 'hunter2hunter2',
      name: 'Bound',
    });
    const created = await workspacesService.createWorkspace({
      name: 'Already Here',
      ownerUserId: user.id,
    });

    // The guard's own read, on the guard's own context tier. Non-empty is the
    // assertion; a denial test here would pass against a policy set that
    // refuses everyone.
    const boundCount = await withUserContext(user.id, (tx) =>
      workspaceMembershipRepository.countByUser(user.id, tx),
    );
    expect(boundCount).toBe(1);

    const ensured = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });

    // Same workspace back — and, decisively, no "{name}'s Workspace" alongside
    // it. That second row is what an unbound count produces, and it is a
    // duplicate DEFAULT workspace, not a harmless extra.
    expect(ensured.workspace.id).toBe(created.workspace.id);
    expect(ensured.workspace.name).toBe('Already Here');
    const all = await adminDb.workspace.findMany({ select: { name: true } });
    expect(all.map((w) => w.name)).toEqual(['Already Here']);
  });

  it('survives concurrent first-calls without creating duplicate workspaces', async () => {
    const user = await usersService.createUser({
      email: 'race@example.com',
      password: 'hunter2hunter2',
      name: 'Race',
    });

    // Two parallel self-heals (two browser tabs right after signup). The
    // FOR UPDATE lock on the user row serializes them: the second sees the
    // first's membership and returns it instead of inserting a duplicate.
    const [a, b] = await Promise.all([
      workspacesService.ensureDefaultWorkspace({ userId: user.id, userName: user.name }),
      workspacesService.ensureDefaultWorkspace({ userId: user.id, userName: user.name }),
    ]);

    expect(a.workspace.id).toBe(b.workspace.id);
    expect(await workspacesForUser(user.id)).toHaveLength(1);
    const workspaceCount = await adminDb.workspace.count();
    expect(workspaceCount).toBe(1);
  });
});
