import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from './helpers/adminDb';
import { currentWorkerAdminUrl, currentWorkerUrl, isAppRoleTestMode } from './helpers/parallelDb';
import { truncateAuthTables } from './helpers/db';

// The two-client test harness (MOTIR-2513).
//
// `TEST_DB_APP_ROLE=1` points `@/lib/db` — the singleton every service and
// repository imports — at the NON-BYPASS runtime role, so the workspace RLS
// policies execute against the code under test. Fixtures and teardown stay on
// the OWNER via `adminDb`, because they need privileges the runtime role must
// never have (TRUNCATE needs ownership; a two-tenant fixture writes across
// tenants, which is exactly what the policies forbid).
//
// The flag is opt-in and the default path is a strict no-op — asserted below
// rather than assumed, because "this change is inert unless you ask for it" is
// the claim the rest of the suite's greenness rests on.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the two-client harness wiring', () => {
  it('leaves both URLs on the base credentials when the flag is unset', () => {
    // The no-op default, as a CHECKED property. With the flag off the code under
    // test and the fixtures share one role, exactly as before this card.
    if (isAppRoleTestMode()) {
      expect(new URL(currentWorkerUrl()).username).toBe(
        process.env['TEST_APP_DB_ROLE'] ?? 'motir_app',
      );
    } else {
      expect(currentWorkerUrl()).toBe(currentWorkerAdminUrl());
    }
  });

  it('points both clients at the SAME worker database either way', () => {
    // The roles may differ; the database must not. A fixture written by the
    // admin client that the app-role client cannot see would otherwise look
    // exactly like an RLS denial, and every proof below would be meaningless.
    expect(new URL(currentWorkerUrl()).pathname).toBe(new URL(currentWorkerAdminUrl()).pathname);
  });

  it('can TRUNCATE through the admin client', async () => {
    // The `beforeEach` above already exercises this; asserting it explicitly
    // names WHY the admin client exists. Under the flag this statement is
    // impossible on the runtime role — TRUNCATE requires ownership.
    await expect(truncateAuthTables()).resolves.not.toThrow();
  });

  it('does NOT append the per-worker suffix outside a Vitest worker', () => {
    // The regression this pins: Playwright imports these helpers
    // (`tests/e2e/_helpers/db-reset.ts` → `truncateAuthTables`) and runs against
    // DATABASE_URL directly, with no `…_test_wN` clones — those exist only
    // because a Vitest globalSetup creates them. Appending the suffix there
    // produced `database "prodect_test_w1" does not exist` and took out nine of
    // eleven E2E shards.
    //
    // It failed SILENTLY rather than loudly: `currentWorkerIndex()` falls back
    // to 1 when VITEST_POOL_ID is unset, so a plausible-looking name is built
    // for a database nobody created.
    const saved = process.env['VITEST_DB_BASE_URL'];
    try {
      delete process.env['VITEST_DB_BASE_URL'];
      // DATABASE_URL is returned UNCHANGED. (Note this assertion is run from
      // inside a worker, where DATABASE_URL is itself already a clone — so what
      // it pins is "no further suffix is added", which is exactly the bug: in
      // Playwright, DATABASE_URL is the real database and must be left alone.)
      expect(currentWorkerAdminUrl()).toBe(process.env['DATABASE_URL']);
      expect(currentWorkerAdminUrl()).not.toMatch(/_test_w\d+_test_w\d+/);
    } finally {
      if (saved !== undefined) process.env['VITEST_DB_BASE_URL'] = saved;
    }
  });
});

describe.runIf(isAppRoleTestMode())('under TEST_DB_APP_ROLE=1', () => {
  it('runs the code under test as the non-bypass role, with RLS live', async () => {
    const [who] = await db.$queryRawUnsafe<{ current_user: string; active: boolean }[]>(
      `SELECT current_user, row_security_active('public.work_item') AS active`,
    );
    expect(who?.current_user).toBe(process.env['TEST_APP_DB_ROLE'] ?? 'motir_app');
    // The assertion that matters: a BYPASSRLS role would report false here, and
    // every RLS test in the repository would pass while proving nothing.
    expect(who?.active).toBe(true);
  });

  it('returns ZERO rows for another tenant — the policies EXECUTE', async () => {
    // The proof this whole effort exists for.
    //
    // The two tenants are seeded through the ADMIN client, with direct writes
    // rather than the services. That is deliberate on both counts: a
    // cross-tenant fixture writes rows in two tenants, which is exactly what the
    // policies forbid, and the services write through `@/lib/db` — the very
    // connection under test. Seeding through them would make this test depend on
    // tenant creation working under the role (MOTIR-2512's subject), when what
    // it is here to prove is that READS are gated.
    const { a, b } = await seedTwoTenants();

    // Tenant A's context, on the restricted connection, reading the project
    // table through the same helper production uses.
    const visible = await withWorkspaceContext(
      { userId: a.userId, workspaceId: a.workspaceId },
      async (tx) => tx.project.findMany({ select: { id: true, workspaceId: true } }),
    );

    // A's OWN project comes back. This assertion is what stops the two below
    // being vacuous: on an empty result `every` is trivially true and `some` is
    // trivially false, so a read that returned nothing at all — a broken
    // fixture, a wrong database, a policy that hides everything — would pass a
    // denial test that never denied anything.
    expect(visible).toHaveLength(1);
    expect(visible[0]?.workspaceId).toBe(a.workspaceId);

    // B's project is simply not there — not filtered out by an application
    // `where`, but absent because the database refused to return it.
    expect(visible.every((p) => p.workspaceId === a.workspaceId)).toBe(true);
    expect(visible.some((p) => p.workspaceId === b.workspaceId)).toBe(false);

    // And it DOES exist — read back as the owner, so the assertion above is a
    // statement about VISIBILITY rather than about an empty table. Without this
    // line the test would pass just as happily against a seed that never ran.
    const all = await adminDb.project.findMany({ select: { workspaceId: true } });
    expect(all.some((p) => p.workspaceId === b.workspaceId)).toBe(true);
  });
});

interface SeededTenant {
  userId: string;
  workspaceId: string;
}

/**
 * Two independent tenants, written through the ADMIN client.
 *
 * Direct model writes rather than the service layer — see the call site for why.
 * Each tenant gets the full root chain the app builds at signup (organization →
 * org membership → workspace → workspace membership) plus one project, so the
 * read under test traverses the same shape production does.
 */
async function seedTwoTenants(): Promise<{ a: SeededTenant; b: SeededTenant }> {
  async function seed(tag: string): Promise<SeededTenant> {
    const user = await adminDb.user.create({
      data: { email: `harness-${tag}@example.com`, name: `Harness ${tag.toUpperCase()}` },
    });
    const organization = await adminDb.organization.create({
      data: { name: `Harness ${tag}`, slug: `harness-${tag}` },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: organization.id, userId: user.id, role: 'owner' },
    });
    const workspace = await adminDb.workspace.create({
      data: { name: `Harness ${tag}`, slug: `harness-${tag}`, organizationId: organization.id },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
    });
    await adminDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: `Project ${tag.toUpperCase()}`,
        slug: `project-${tag}`,
        identifier: tag.toUpperCase() === 'A' ? 'ALPHA' : 'BRAVO',
      },
    });
    return { userId: user.id, workspaceId: workspace.id };
  }
  return { a: await seed('a'), b: await seed('b') };
}
