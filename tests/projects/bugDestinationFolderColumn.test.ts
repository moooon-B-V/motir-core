import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The project's BUG DESTINATION pointer, to a FOLDER — Story MOTIR-4927 ·
// Subtask MOTIR-4934 (re-scoped 2026-09-14 from a work-item pointer).
//
// The column has no readers yet, so everything provable about it is provable
// only against the DATABASE. Four properties, in a deliberate order:
//
//   1. `NULL` IS A VALUE — nullable, no default, read from the CATALOG.
//   2. THE DELETE RULE IS `NO ACTION` — a raw delete of a folder the pointer
//      names FAILS, while an unrelated folder delete and a whole-project
//      delete still go through. `SET NULL` would silently turn a deleted nested
//      folder into "root, chosen"; the service carries the pointer up instead
//      (MOTIR-5537).
//   3. THE SAME-PROJECT TRIGGER ADMITS, THEN REFUSES. The admit case comes
//      first: a check that refuses everything passes every denial test.
//   4. RLS COVERS THE COLUMN WITHOUT A NEW POLICY — admit first, then refuse.

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
  /** A root folder named Bugs. */
  bugsFolderId: string;
  /** A folder nested under Bugs. */
  nestedFolderId: string;
}

let seq = 0;

/** Seed one tenant as the OWNER, so RLS does not bite during setup
 *  (`tests/helpers/adminDb.ts`). */
async function seedTenant(tag: string): Promise<Tenant> {
  const n = seq++;
  const user = await adminDb.user.create({
    data: { name: `User ${tag}`, email: `bug-dest-folder-${tag}-${n}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `bdf-org-${tag}-${n}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: org.id, userId: user.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS ${tag}`, slug: `bdf-ws-${tag}-${n}`, organizationId: org.id },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Project ${tag}`,
      slug: `bdf-p-${tag}-${n}`,
      identifier: `BDF${tag.toUpperCase()}${n}`,
      workspaceId: workspace.id,
    },
  });
  const bugs = await adminDb.folder.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Bugs',
      position: 'a0',
      createdById: user.id,
    },
  });
  const nested = await adminDb.folder.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      parentFolderId: bugs.id,
      name: 'Incoming',
      position: 'a0',
      createdById: user.id,
    },
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    bugsFolderId: bugs.id,
    nestedFolderId: nested.id,
  };
}

async function pointAt(projectId: string, folderId: string | null) {
  await adminDb.project.update({
    where: { id: projectId },
    data: { bugDestinationFolderId: folderId },
  });
}

async function destinationOf(projectId: string) {
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return row.bugDestinationFolderId;
}

/** The tenant under test. */
let home: Tenant;
/** A second tenant in a DIFFERENT workspace. */
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
       WHERE table_name = 'project' AND column_name = 'bug_destination_folder_id'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe('YES');
    expect(rows[0]!.column_default).toBeNull();
    expect(rows[0]!.data_type).toBe('text');
  });

  it('is NULL on a project created without one', async () => {
    expect(await destinationOf(home.projectId)).toBeNull();
  });

  it('carries the index a folder delete scans `project` with', async () => {
    const rows = await adminDb.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'project' AND indexdef LIKE '%bug_destination_folder_id%'
    `;
    expect(rows.map((r) => r.indexname)).toContain('project_bug_destination_folder_id_idx');
  });
});

describe('the same-project trigger', () => {
  it('accepts a ROOT folder and a NESTED folder of its OWN project', async () => {
    // ⚠️ THE ADMIT CASE, FIRST. Every refusal below is meaningless without it.
    await pointAt(home.projectId, home.bugsFolderId);
    expect(await destinationOf(home.projectId)).toBe(home.bugsFolderId);

    await pointAt(home.projectId, home.nestedFolderId);
    expect(await destinationOf(home.projectId)).toBe(home.nestedFolderId);

    // And back to the root, which is always legal.
    await pointAt(home.projectId, null);
    expect(await destinationOf(home.projectId)).toBeNull();
  });

  it('rejects a folder of ANOTHER PROJECT in the same workspace', async () => {
    // Same workspace, so RLS cannot be what refuses this — only the trigger can.
    const sibling = await adminDb.project.create({
      data: {
        name: 'Sibling',
        slug: `bdf-sibling-${seq++}`,
        identifier: `BDFS${seq}`,
        workspaceId: home.workspaceId,
      },
    });

    await expect(pointAt(sibling.id, home.bugsFolderId)).rejects.toThrow(
      /PROJECT_BUG_DESTINATION_FOLDER_CROSS_PROJECT/,
    );
    expect(await destinationOf(sibling.id)).toBeNull();
  });

  it('rejects a folder of another WORKSPACE, and names the coarser boundary', async () => {
    await expect(pointAt(home.projectId, neighbour.bugsFolderId)).rejects.toThrow(
      /PROJECT_BUG_DESTINATION_FOLDER_CROSS_WORKSPACE/,
    );
    expect(await destinationOf(home.projectId)).toBeNull();
  });

  it('refuses a folder id that does not exist, via the foreign key', async () => {
    // The trigger DEFERS this case so the FK gives the clearer error — the
    // branch that would become a hole if the function were ever SECURITY INVOKER.
    await expect(pointAt(home.projectId, 'cmzzzzzzzzzzzzzzzzzzzzzzzz')).rejects.toThrow(
      /project_bug_destination_folder_id_fkey|Foreign key constraint/i,
    );
  });
});

describe('the delete rule — NO ACTION, so the service decides where the destination goes', () => {
  it('FAILS a raw delete of the folder the pointer names, and leaves both rows as they were', async () => {
    await pointAt(home.projectId, home.nestedFolderId);

    await expect(adminDb.folder.delete({ where: { id: home.nestedFolderId } })).rejects.toThrow(
      /project_bug_destination_folder_id_fkey|Foreign key constraint/i,
    );

    expect(await adminDb.folder.findUnique({ where: { id: home.nestedFolderId } })).not.toBeNull();
    expect(await destinationOf(home.projectId)).toBe(home.nestedFolderId);
  });

  it('does not stand in the way of deleting a folder the pointer does NOT name', async () => {
    await pointAt(home.projectId, home.bugsFolderId);

    await adminDb.folder.delete({ where: { id: home.nestedFolderId } });

    expect(await adminDb.folder.findUnique({ where: { id: home.nestedFolderId } })).toBeNull();
    expect(await destinationOf(home.projectId)).toBe(home.bugsFolderId);
  });

  it('lets a PROJECT whose pointer names one of its own folders be deleted, taking the folders with it', async () => {
    await pointAt(home.projectId, home.nestedFolderId);

    await adminDb.project.delete({ where: { id: home.projectId } });

    expect(await adminDb.project.findUnique({ where: { id: home.projectId } })).toBeNull();
    expect(await adminDb.folder.count({ where: { projectId: home.projectId } })).toBe(0);
  });
});

describe('row-level security over the new column, under the non-bypass role', () => {
  it('lets the bound workspace write it', async () => {
    // ⚠️ ADMIT FIRST — proves the runtime role can write the column at all.
    await withWorkspaceContext({ userId: home.userId, workspaceId: home.workspaceId }, (tx) =>
      tx.project.update({
        where: { id: home.projectId },
        data: { bugDestinationFolderId: home.bugsFolderId },
      }),
    );

    expect(await destinationOf(home.projectId)).toBe(home.bugsFolderId);
  });

  it('REFUSES a cross-workspace write of the column — the existing row policy covers it', async () => {
    await expect(
      withWorkspaceContext({ userId: home.userId, workspaceId: home.workspaceId }, (tx) =>
        tx.project.update({
          where: { id: neighbour.projectId },
          data: { bugDestinationFolderId: neighbour.bugsFolderId },
        }),
      ),
    ).rejects.toThrow();

    expect(await destinationOf(neighbour.projectId)).toBeNull();
  });
  // Every "refused" case above is vacuous if `@/lib/db` bypasses RLS; that the
  // harness role does not is pinned once, in `tests/app-role-identity.test.ts`.
});
