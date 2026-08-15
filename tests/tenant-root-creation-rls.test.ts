import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Creating a TENANT under the non-bypass role (MOTIR-2512).
//
// The four tenant-root tables — organization, organization_membership,
// workspace, workspace_membership — had RLS enabled and NO policy admitting
// INSERT, which under `motir_app` means DENIED, not ungated. Sign-up and
// workspace creation were therefore impossible as the role the application is
// meant to run as, and pointing production at it would have broken the product
// on its first request.
//
// The pairing matters as much as the INSERT policy: Prisma's `create()` always
// emits RETURNING, and Postgres applies the SELECT policies to the row it hands
// back. A `WITH CHECK (true)` INSERT policy alone therefore passes a psql probe
// and still fails the application — which is why every assertion here drives the
// REAL service rather than raw SQL.
//
// Only meaningful under the app role: as the owner these all pass trivially,
// which is exactly the blindness this file exists to remove.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * One workspace with its own org, seeded through the ADMIN client.
 *
 * Deliberately NOT through `workspacesService`: this file's arm-1 test needs TWO
 * independent tenants, and seeding both through the service would make the fixture
 * depend on the very bootstrap path other tests here are proving. Returns the
 * workspace id.
 */
async function seedWorkspace(slug: string): Promise<string> {
  const organization = await adminDb.organization.create({
    data: { name: slug, slug },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: slug, slug, organizationId: organization.id },
  });
  return workspace.id;
}

describe('creating a tenant as the non-bypass role', () => {
  it('creates a workspace end-to-end through the service', async () => {
    const user = await adminDb.user.create({
      data: { email: 'root-create@example.com', name: 'Root Create' },
    });

    // The whole root chain — organization, org membership, workspace, owner
    // membership — in one transaction, through the code production runs, on the
    // restricted connection. Before this card's migration this threw
    // `new row violates row-level security policy for table "organization"`.
    const { workspace, membership } = await workspacesService.createWorkspace({
      name: 'Root Create',
      ownerUserId: user.id,
    });

    expect(workspace.id).toBeTruthy();
    expect(workspace.slug).toBe('root-create');
    expect(membership.userId).toBe(user.id);
    expect(membership.workspaceId).toBe(workspace.id);

    // Read back as the OWNER: the rows really landed, rather than the service
    // having returned an object it never persisted.
    const persisted = await adminDb.workspace.findUnique({
      where: { id: workspace.id },
      select: { id: true, organizationId: true },
    });
    expect(persisted?.id).toBe(workspace.id);
    const org = await adminDb.organization.findUnique({
      where: { id: persisted!.organizationId },
      select: { slug: true },
    });
    expect(org?.slug).toBe('root-create');
  });

  it('creates a SECOND workspace when the first slug collides', async () => {
    // The retry loop opens a FRESH transaction per attempt, so the bootstrap GUC
    // must be re-bound inside the function rather than around it. If it were
    // bound once, outside, the retry would attempt slug B while the policy still
    // admitted only slug A — and fail in a way no single-workspace test sees.
    const [one, two] = [
      await usersService.createUser({
        email: 'collide-1@example.com',
        password: 'hunter2hunter2',
        name: 'Collide One',
      }),
      await usersService.createUser({
        email: 'collide-2@example.com',
        password: 'hunter2hunter2',
        name: 'Collide Two',
      }),
    ];
    const first = await workspacesService.createWorkspace({
      name: 'Same Name',
      ownerUserId: one.id,
    });
    const second = await workspacesService.createWorkspace({
      name: 'Same Name',
      ownerUserId: two.id,
    });

    expect(first.workspace.slug).toBe('same-name');
    // Suffixed by the retry, and — the point — actually created.
    expect(second.workspace.slug).toMatch(/^same-name-[a-z0-9]{4}$/);
    expect(second.workspace.id).not.toBe(first.workspace.id);
  });

  it('still refuses to insert a tenant-root row outside a bootstrap context', async () => {
    // The policies admit exactly the row whose slug the creating transaction
    // bound. With no `app.bootstrap_slug` the predicate is NULL and the INSERT is
    // refused — so this is a widening of exactly one row, not of the table.
    await expect(
      db.organization.create({ data: { name: 'Smuggled', slug: 'smuggled' } }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('still refuses to insert a row whose slug is NOT the one bound', async () => {
    // The sharper case: a bootstrap context IS open, and a second row rides
    // along on it. The predicate is per-row, so only the bound slug passes.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bootstrap_slug', 'the-real-one', true)`;
        return tx.organization.create({ data: { name: 'Rider', slug: 'a-different-slug' } });
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a bound ACTIVE-workspace context admits a membership only for THAT workspace', async () => {
    // The mirror of the two cases above, for arm 1 rather than the bootstrap arm —
    // and the check MOTIR-2777 owes. Binding `app.workspace_id` is what makes
    // invite-accept work; this pins that the bind is worth exactly one workspace.
    //
    // Without it the fix would be indistinguishable from the self-join arm the
    // policy migration deliberately refused: both make the accept pass, and only
    // one of them also lets a user join a workspace they were never invited to.
    const invitee = await adminDb.user.create({
      data: { email: 'arm1-scope@example.com', name: 'Arm One' },
    });
    const [a, b] = await Promise.all([seedWorkspace('arm1-a'), seedWorkspace('arm1-b')]);

    // Bound to A, targeting A: admitted, exactly as the accept path relies on.
    const admitted = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${invitee.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a}, true)`;
      return tx.workspaceMembership.create({
        data: { userId: invitee.id, workspaceId: a, role: 'member' },
      });
    });
    expect(admitted.workspaceId).toBe(a);

    // Bound to A, targeting B: refused. The GUC names the workspace, not the user,
    // so holding one workspace's context buys nothing anywhere else.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${invitee.id}, true)`;
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a}, true)`;
        return tx.workspaceMembership.create({
          data: { userId: invitee.id, workspaceId: b, role: 'member' },
        });
      }),
    ).rejects.toThrow(/row-level security/i);

    // And it really did not land — read as the owner, so "refused" is a statement
    // about the row rather than about what the app role can see.
    const leaked = await adminDb.workspaceMembership.findFirst({
      where: { userId: invitee.id, workspaceId: b },
    });
    expect(leaked).toBeNull();
  });
});

describe('RLS coverage across the public schema', () => {
  it('every RLS-enabled table admits all four verbs', async () => {
    // The check that would have caught this card's defect at authoring time. It
    // is a TOTALITY over the live policy set, so a future table shipped with
    // ENABLE ROW LEVEL SECURITY and a missing verb trips a test instead of
    // becoming a denial nobody notices until a cutover.
    const gaps = await adminDb.$queryRawUnsafe<{ relname: string; missing: string }[]>(
      `SELECT c.relname,
              concat_ws(',',
                CASE WHEN NOT bool_or(p.cmd IN ('ALL','SELECT')) THEN 'SELECT' END,
                CASE WHEN NOT bool_or(p.cmd IN ('ALL','INSERT')) THEN 'INSERT' END,
                CASE WHEN NOT bool_or(p.cmd IN ('ALL','UPDATE')) THEN 'UPDATE' END,
                CASE WHEN NOT bool_or(p.cmd IN ('ALL','DELETE')) THEN 'DELETE' END
              ) AS missing
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_policies p
                ON p.schemaname = 'public'
               AND p.tablename = c.relname
               AND p.permissive = 'PERMISSIVE'
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        GROUP BY c.relname
       HAVING NOT (bool_or(p.cmd IN ('ALL','SELECT')) AND bool_or(p.cmd IN ('ALL','INSERT'))
                   AND bool_or(p.cmd IN ('ALL','UPDATE')) AND bool_or(p.cmd IN ('ALL','DELETE')))
        ORDER BY c.relname`,
    );
    expect(gaps).toEqual([]);
  });

  it('the tables WITHOUT RLS are exactly the documented set', async () => {
    // Every table here is deliberate. Written as a set comparison rather than a
    // count so that ADDING one and REMOVING one cannot cancel out, and so the
    // justification lives next to the name.
    const DELIBERATELY_UNGUARDED: Record<string, string> = {
      // Prisma's own migration ledger. Not application data; the runtime role
      // has no business reading it and the migration lane runs as the owner.
      _prisma_migrations: 'Prisma migration ledger, written only by the owner',
      // Better-Auth's tables. Reached BEFORE any workspace context exists — you
      // cannot bind a tenant GUC while resolving who the user is.
      account: 'Better-Auth credential rows, read during authentication',
      session: 'Better-Auth session rows, read on every request before context',
      user: 'the global identity; users are not workspace-scoped',
      verification: 'short-lived auth tokens, consumed before any context',
      device_code: 'CLI device-authorisation grants, pre-authentication by design',
      email_change_request: 'a pending email change, keyed to the user not a tenant',
      // User-scoped preference rows: keyed to the USER, who spans workspaces.
      notification_preference: 'per-user preference, deliberately cross-workspace',
      user_appearance_preference: 'per-user preference, deliberately cross-workspace',
      // Anonymous / pre-tenant rows.
      idea_draft: 'anonymous pre-signup drafts; no tenant exists yet',
      // The shared rate-limit counter (8.5.9 / MOTIR-1165). The surfaces it
      // protects — sign-in, sign-up, password reset, public writes — are limited
      // BEFORE any workspace is known, so `workspace_id NOT NULL` would be
      // unfillable on exactly the requests that need it most and an RLS policy
      // reading `app.workspace_id` would deny those writes outright, turning a
      // protection into an outage on the pre-auth path. Every caller component in
      // `key` is SHA-256 hashed, so there is no tenant content to guard.
      // Reasoned out in full in `docs/decisions/production-service-stack.md` §7
      // and restated in the table's migration header.
      rate_limit_counter: 'pre-auth counters keyed by a hash; no tenant exists at write time',
      // Project-scoped tables reached through an already-guarded parent.
      canvas_node_position: 'reached only via project, which is workspace-guarded',
      project_tag: 'reached only via project, which is workspace-guarded',
      project_tag_assignment: 'reached only via project, which is workspace-guarded',
    };

    const rows = await adminDb.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(Object.keys(DELIBERATELY_UNGUARDED).sort());
  });
});
