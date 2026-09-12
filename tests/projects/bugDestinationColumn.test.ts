import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The project's BUG DESTINATION pointer — Story MOTIR-4927 · Subtask MOTIR-4934.
//
// The column has no readers yet (the resolver, the seed, the backfill and the
// settings picker are siblings blocked on this card), so everything provable
// about it is provable only against the DATABASE. Four properties, and the order
// below is deliberate:
//
//   1. `NULL` IS A VALUE. Nullable, and no non-null default — read from the
//      CATALOG rather than from the migration file, because a migration is a
//      claim about the database and `information_schema` is the fact. This is
//      the property the whole story rests on: `null` means "file at the project
//      ROOT", so a later default, or a later NOT NULL, silently overwrites the
//      answer a team gave in settings.
//   2. `ON DELETE SET NULL` ACTUALLY FIRES, asserted by deleting a real
//      container rather than by reading the constraint's action.
//   3. THE TENANCY TRIGGER ADMITS AND REFUSES, IN THAT ORDER. ⚠️ The ADMIT case
//      comes first, for the reason `tests/publicAddresses/publicAddressRepository.test.ts`
//      states: a check that refuses everything passes every denial test ever
//      written. A same-project pointer must be shown to LAND before a
//      cross-project one is shown to bounce.
//   4. RLS COVERS THE NEW COLUMN WITHOUT A NEW POLICY. `project` already carries
//      `project_workspace_or_system_read` (created as `project_active_workspace`
//      in 20260529202445, renamed by 20260727225458 — the catalog is the name of
//      record), a PERMISSIVE `FOR ALL` policy whose WITH CHECK pins the row's
//      workspace to the bound one — so the column is governed the moment it
//      exists; its two sibling arms are SELECT-only and cannot admit a write. Same
//      order: the in-workspace write is shown to succeed under the non-bypass
//      role before the cross-workspace one is shown to be refused, or "refused"
//      would be indistinguishable from "the role cannot write this column at
//      all".

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
  /** A `task` in this project — a legal bug container (`task -> bug` is legal in
   *  the kind-parent matrix, which is why MOTIR-4935 seeds a `task`). */
  containerId: string;
}

let seq = 0;

/** Seed one tenant as the OWNER, so RLS does not bite during setup — a
 *  two-tenant fixture writes across tenants, which is exactly what the policies
 *  exist to refuse (`tests/helpers/adminDb.ts`). */
async function seedTenant(tag: string): Promise<Tenant> {
  const n = seq++;
  const user = await adminDb.user.create({
    data: { name: `User ${tag}`, email: `bug-dest-${tag}-${n}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `bug-dest-org-${tag}-${n}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: org.id, userId: user.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS ${tag}`, slug: `bug-dest-ws-${tag}-${n}`, organizationId: org.id },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Project ${tag}`,
      slug: `bug-dest-p-${tag}-${n}`,
      identifier: `BD${tag}${n}`,
      workspaceId: workspace.id,
    },
  });
  const container = await adminDb.workItem.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      reporterId: user.id,
      kind: 'task',
      key: 1,
      identifier: `${project.identifier}-1`,
      title: `Bugs ${tag}`,
      position: `a${n}c`,
    },
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    containerId: container.id,
  };
}

/** The tenant under test. */
let home: Tenant;
/** A second tenant in a DIFFERENT workspace — the cross-workspace counterparty. */
let neighbour: Tenant;

beforeEach(async () => {
  await truncateAuthTables();
  home = await seedTenant('home');
  neighbour = await seedTenant('nbr');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────

describe('the column, read from the catalog', () => {
  it('is nullable and carries NO default — `null` is the ROOT destination, not an unset field', async () => {
    const rows = await adminDb.$queryRaw<
      Array<{ is_nullable: string; column_default: string | null; data_type: string }>
    >`
      SELECT is_nullable, column_default, data_type
        FROM information_schema.columns
       WHERE table_name = 'project' AND column_name = 'bug_destination_id'
    `;

    expect(rows).toHaveLength(1);
    // The two halves of "null is a value". A NOT NULL column cannot express the
    // root choice at all; a DEFAULT would mean a project that has never been
    // configured is indistinguishable from one whose team picked the root.
    expect(rows[0]!.is_nullable).toBe('YES');
    expect(rows[0]!.column_default).toBeNull();
    expect(rows[0]!.data_type).toBe('text');
  });

  it('defaults to the ROOT for a project created without one', async () => {
    const created = await adminDb.project.findUniqueOrThrow({ where: { id: home.projectId } });
    expect(created.bugDestinationId).toBeNull();
  });

  it('carries the index the SET NULL delete scan needs', async () => {
    // Declared in BOTH the datamodel and the migration: a database index the
    // schema does not carry is the drift `CLAUDE.md`'s migration rules describe,
    // and the `build` job's `prisma migrate diff --exit-code` fails on it.
    const rows = await adminDb.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'project' AND indexdef LIKE '%bug_destination_id%'
    `;
    expect(rows.map((r) => r.indexname)).toContain('project_bug_destination_id_idx');
  });
});

describe('the pointer, set and then destroyed', () => {
  it('accepts a container in its OWN project', async () => {
    // ⚠️ THE ADMIT CASE, FIRST. Every refusal below is meaningless without it.
    await adminDb.project.update({
      where: { id: home.projectId },
      data: { bugDestinationId: home.containerId },
    });

    const row = await adminDb.project.findUniqueOrThrow({ where: { id: home.projectId } });
    expect(row.bugDestinationId).toBe(home.containerId);
  });

  it('SET NULLs the pointer when the container is DELETED, leaving the project intact', async () => {
    await adminDb.project.update({
      where: { id: home.projectId },
      data: { bugDestinationId: home.containerId },
    });

    await adminDb.workItem.delete({ where: { id: home.containerId } });

    // The project survives — a deleted container must not cascade into it —
    // and the pointer now says ROOT, which is a FACT in the column rather than
    // something MOTIR-4937's resolver has to infer from a lookup miss.
    const row = await adminDb.project.findUnique({ where: { id: home.projectId } });
    expect(row).not.toBeNull();
    expect(row!.bugDestinationId).toBeNull();
  });

  it('rejects a container in ANOTHER PROJECT of the same workspace', async () => {
    // A second project in the SAME workspace, so RLS cannot be what refuses
    // this — the trigger is the only thing that can, which is the point.
    const sibling = await adminDb.project.create({
      data: {
        name: 'Sibling',
        slug: `bug-dest-sibling-${seq++}`,
        identifier: `BDS${seq}`,
        workspaceId: home.workspaceId,
      },
    });

    await expect(
      adminDb.project.update({
        where: { id: sibling.id },
        data: { bugDestinationId: home.containerId },
      }),
    ).rejects.toThrow(/PROJECT_BUG_DESTINATION_CROSS_PROJECT/);

    const row = await adminDb.project.findUniqueOrThrow({ where: { id: sibling.id } });
    expect(row.bugDestinationId).toBeNull();
  });

  it('rejects a container in another WORKSPACE, and names the coarser boundary', async () => {
    // Two violations at once (another workspace is also another project). The
    // trigger checks workspace FIRST so the message names the larger of the two,
    // exactly as `enforce_work_item_parent_tenancy` does.
    await expect(
      adminDb.project.update({
        where: { id: home.projectId },
        data: { bugDestinationId: neighbour.containerId },
      }),
    ).rejects.toThrow(/PROJECT_BUG_DESTINATION_CROSS_WORKSPACE/);
  });

  it('refuses a pointer at a work item that does not exist, via the foreign key', async () => {
    // The trigger DEFERS this case ("no such row") so the FK gives the clearer
    // error. Asserted because that deferral branch is the one that would become
    // a hole if the trigger were ever relabelled SECURITY INVOKER — an invoker
    // lookup cannot tell "absent" from "hidden by RLS".
    await expect(
      adminDb.project.update({
        where: { id: home.projectId },
        data: { bugDestinationId: 'cmzzzzzzzzzzzzzzzzzzzzzzzz' },
      }),
    ).rejects.toThrow(/project_bug_destination_id_fkey|Foreign key constraint/i);
  });
});

describe('row-level security over the new column, under the non-bypass role', () => {
  it('lets the bound workspace write it', async () => {
    // ⚠️ ADMIT FIRST. `db` is the non-bypass `motir_app` role, so this proves
    // the runtime role can write the column at all — without which the refusal
    // below would prove nothing.
    await withWorkspaceContext({ userId: home.userId, workspaceId: home.workspaceId }, (tx) =>
      tx.project.update({
        where: { id: home.projectId },
        data: { bugDestinationId: home.containerId },
      }),
    );

    const row = await adminDb.project.findUniqueOrThrow({ where: { id: home.projectId } });
    expect(row.bugDestinationId).toBe(home.containerId);
  });

  it('REFUSES a cross-workspace write of the column — the existing row policy covers it', async () => {
    // No column-specific policy was authored by MOTIR-4934, and this is the
    // assertion that says none was needed: `project_workspace_or_system_read` is
    // PERMISSIVE `FOR ALL` over the ROW, so a caller bound to `home` cannot
    // reach `neighbour`'s project row at all. Prisma's update emits RETURNING,
    // so an invisible row surfaces as a not-found rather than as 0 rows.
    await expect(
      withWorkspaceContext({ userId: home.userId, workspaceId: home.workspaceId }, (tx) =>
        tx.project.update({
          where: { id: neighbour.projectId },
          data: { bugDestinationId: neighbour.containerId },
        }),
      ),
    ).rejects.toThrow();

    const untouched = await adminDb.project.findUniqueOrThrow({
      where: { id: neighbour.projectId },
    });
    expect(untouched.bugDestinationId).toBeNull();
  });

  it('runs under a role that does NOT bypass RLS', async () => {
    // The guard on every assertion above: if `@/lib/db` were the owner, each
    // "refused" case would be vacuous. Pinned here rather than assumed.
    const rows = await db.$queryRaw<Array<{ rolbypassrls: boolean }>>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows[0]!.rolbypassrls).toBe(false);
  });
});
