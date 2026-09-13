import type { Prisma, WorkItemKind } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// The FOLDER schema — MOTIR-5312 (Story MOTIR-5308, Epic MOTIR-5307).
//
// Proves, on real Postgres, what `20260913090000_folder` makes the DATABASE
// refuse, independent of any service:
//   * a work item under a work-item parent AND in a folder (the CHECK);
//   * a folder from another project / workspace (the work_item trigger);
//   * a parent folder from another project / workspace (the folder trigger);
//   * a folder becoming its own ancestor (the folder cycle backstop);
//   * two sibling folders whose names differ only by case, at the root and
//     inside a folder (the expression UNIQUE index);
//   * and it ADMITS a subtask filed in a folder with no work-item parent — the
//     epic's "any kind means any kind" decision — while still refusing a root
//     subtask that is not filed.
// And the tenancy pair on `folder` under the non-bypass `motir_app` role, by
// catalog AND by behaviour.
//
// Fixtures are written as the owner (`adminDb`), where RLS does not bite and the
// triggers still run. Every RLS assertion runs inside `asAppRole`, which drops to
// `motir_app` — under the default superuser each assertion would pass for the
// wrong reason (tests/work-item-rls.test.ts explains the role switch at length).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenants {
  userAId: string;
  userBId: string;
  w1: string;
  w2: string;
  // W1 has two projects (p1, p1b); W2 has one (p2).
  p1: string;
  p1b: string;
  p2: string;
}

async function makeTenants(): Promise<Tenants> {
  const userA = await usersService.createUser({
    email: 'folder-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Folder Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'folder-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Folder Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'Folder W1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'Folder W2', ownerUserId: userB.id });
  const p1 = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'Folder P1',
    identifier: 'FONE',
  });
  const p1b = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'Folder P1b',
    identifier: 'FONEB',
  });
  const p2 = await projectsService.createProject({
    workspaceId: w2.workspace.id,
    actorUserId: userB.id,
    name: 'Folder P2',
    identifier: 'FTWO',
  });
  return {
    userAId: userA.id,
    userBId: userB.id,
    w1: w1.workspace.id,
    w2: w2.workspace.id,
    p1: p1.id,
    p1b: p1b.id,
    p2: p2.id,
  };
}

let counter = 0;
function next(): number {
  counter += 1;
  return counter;
}

async function makeFolder(args: {
  workspaceId: string;
  projectId: string;
  createdById: string;
  name?: string;
  parentFolderId?: string | null;
}): Promise<string> {
  const n = next();
  const row = await adminDb.folder.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      createdById: args.createdById,
      name: args.name ?? `Folder ${n}`,
      position: `a${n.toString(36)}`,
      parentFolderId: args.parentFolderId ?? null,
    },
  });
  return row.id;
}

// Keys start high so they can never collide with anything a project seeds.
async function makeWorkItem(args: {
  workspaceId: string;
  projectId: string;
  reporterId: string;
  kind: WorkItemKind;
  parentId?: string | null;
  folderId?: string | null;
}): Promise<string> {
  const n = next();
  const row = await adminDb.workItem.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      reporterId: args.reporterId,
      kind: args.kind,
      key: 1000 + n,
      identifier: `FLD-${1000 + n}-${args.projectId.slice(-4)}`,
      title: `Item ${n}`,
      position: `a${n.toString(36)}`,
      parentId: args.parentId ?? null,
      folderId: args.folderId ?? null,
    },
  });
  return row.id;
}

/** `withWorkspaceContext`'s GUC binding plus the drop to the non-bypass role. */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; projectId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.projectId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('work_item.folderId — placement is a work-item parent XOR a folder', () => {
  it('refuses a row with both a work-item parent and a folder, and admits either alone', async () => {
    const t = await makeTenants();
    const epic = await makeWorkItem({
      workspaceId: t.w1,
      projectId: t.p1,
      reporterId: t.userAId,
      kind: 'epic',
    });
    const story = await makeWorkItem({
      workspaceId: t.w1,
      projectId: t.p1,
      reporterId: t.userAId,
      kind: 'story',
      parentId: epic,
    });
    const folder = await makeFolder({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });

    // Same tenancy and a kind-legal parent, so the CHECK is the only thing
    // that can refuse this write.
    await expect(
      adminDb.workItem.update({ where: { id: story }, data: { folderId: folder } }),
    ).rejects.toThrow(/work_item_parent_xor_folder/);

    // The positive control: filing it (clearing the parent) is admitted.
    await adminDb.workItem.update({
      where: { id: story },
      data: { parentId: null, folderId: folder },
    });
    const filed = await adminDb.workItem.findUniqueOrThrow({ where: { id: story } });
    expect(filed).toMatchObject({ parentId: null, folderId: folder });
  });

  it('refuses a folder from another project or another workspace', async () => {
    const t = await makeTenants();
    const epic = await makeWorkItem({
      workspaceId: t.w1,
      projectId: t.p1,
      reporterId: t.userAId,
      kind: 'epic',
    });
    const siblingProjectFolder = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1b,
      createdById: t.userAId,
    });
    const otherWorkspaceFolder = await makeFolder({
      workspaceId: t.w2,
      projectId: t.p2,
      createdById: t.userBId,
    });

    await expect(
      adminDb.workItem.update({ where: { id: epic }, data: { folderId: siblingProjectFolder } }),
    ).rejects.toThrow(/WI_FOLDER_CROSS_PROJECT/);
    await expect(
      adminDb.workItem.update({ where: { id: epic }, data: { folderId: otherWorkspaceFolder } }),
    ).rejects.toThrow(/WI_FOLDER_CROSS_WORKSPACE/);
  });

  it('still refuses a cross-project folder under the app role, where that folder is invisible', async () => {
    const t = await makeTenants();
    const epic = await makeWorkItem({
      workspaceId: t.w1,
      projectId: t.p1,
      reporterId: t.userAId,
      kind: 'epic',
    });
    const siblingProjectFolder = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1b,
      createdById: t.userAId,
    });

    // Bound to P1, the P1b folder is hidden by `folder_project_narrow`; a
    // SECURITY INVOKER lookup would read NULL, defer to the FK and admit it.
    await expect(
      asAppRole(
        { userId: t.userAId, workspaceId: t.w1, projectId: t.p1 },
        (tx) =>
          tx.$executeRaw`UPDATE "work_item" SET "folderId" = ${siblingProjectFolder} WHERE "id" = ${epic}`,
      ),
    ).rejects.toThrow(/WI_FOLDER_CROSS_PROJECT/);
  });

  it('admits a subtask filed in a folder with no work-item parent, and refuses un-filing it into a bare root', async () => {
    const t = await makeTenants();
    const story = await makeWorkItem({
      workspaceId: t.w1,
      projectId: t.p1,
      reporterId: t.userAId,
      kind: 'story',
    });
    const subtask = await makeWorkItem({
      workspaceId: t.w1,
      projectId: t.p1,
      reporterId: t.userAId,
      kind: 'subtask',
      parentId: story,
    });
    const folder = await makeFolder({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });

    await adminDb.workItem.update({
      where: { id: subtask },
      data: { parentId: null, folderId: folder },
    });
    expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask } })).toMatchObject({
      parentId: null,
      folderId: folder,
    });

    // An UPDATE touching only "folderId" must still reach the kind rule.
    await expect(
      adminDb.workItem.update({ where: { id: subtask }, data: { folderId: null } }),
    ).rejects.toThrow(/WI_SUBTASK_NEEDS_PARENT/);

    // And an unfiled root subtask is refused exactly as before.
    await expect(
      makeWorkItem({ workspaceId: t.w1, projectId: t.p1, reporterId: t.userAId, kind: 'subtask' }),
    ).rejects.toThrow(/WI_SUBTASK_NEEDS_PARENT/);
  });
});

describe('folder — tenancy, cycles and sibling names', () => {
  it('refuses a parent folder from another project or another workspace', async () => {
    const t = await makeTenants();
    const siblingProjectFolder = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1b,
      createdById: t.userAId,
    });
    const otherWorkspaceFolder = await makeFolder({
      workspaceId: t.w2,
      projectId: t.p2,
      createdById: t.userBId,
    });

    await expect(
      makeFolder({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        parentFolderId: siblingProjectFolder,
      }),
    ).rejects.toThrow(/FOLDER_PARENT_CROSS_PROJECT/);
    await expect(
      makeFolder({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        parentFolderId: otherWorkspaceFolder,
      }),
    ).rejects.toThrow(/FOLDER_PARENT_CROSS_WORKSPACE/);
  });

  it('refuses a folder becoming its own parent or its own ancestor', async () => {
    const t = await makeTenants();
    const outer = await makeFolder({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    const middle = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      parentFolderId: outer,
    });
    const inner = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      parentFolderId: middle,
    });

    await expect(
      adminDb.folder.update({ where: { id: outer }, data: { parentFolderId: outer } }),
    ).rejects.toThrow(/FOLDER_PARENT_CYCLE/);
    await expect(
      adminDb.folder.update({ where: { id: outer }, data: { parentFolderId: inner } }),
    ).rejects.toThrow(/FOLDER_PARENT_CYCLE/);

    // A legal move is admitted: the innermost folder up to the root.
    await adminDb.folder.update({ where: { id: inner }, data: { parentFolderId: null } });
  });

  it('refuses sibling names that differ only by case, at the root and inside a folder', async () => {
    const t = await makeTenants();
    await makeFolder({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId, name: 'Later' });
    await expect(
      makeFolder({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId, name: 'later' }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const parent = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      name: 'Archive',
    });
    await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      name: 'Later',
      parentFolderId: parent,
    });
    await expect(
      makeFolder({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        name: 'LATER',
        parentFolderId: parent,
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('admits the same name under two different parents, and in two different projects', async () => {
    const t = await makeTenants();
    const a = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      name: 'A',
    });
    const b = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      name: 'B',
    });
    await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      name: '2025',
      parentFolderId: a,
    });
    await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      name: '2025',
      parentFolderId: b,
    });
    await makeFolder({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId, name: 'Later' });
    await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1b,
      createdById: t.userAId,
      name: 'Later',
    });

    expect(await adminDb.folder.count({ where: { name: '2025' } })).toBe(2);
    expect(await adminDb.folder.count({ where: { name: 'Later' } })).toBe(2);
  });
});

describe('folder — RLS under the non-bypass role', () => {
  it('carries the work_item policy pair, enabled and forced (catalog)', async () => {
    const policies = await adminDb.$queryRaw<
      { policyname: string; permissive: string; cmd: string }[]
    >`
      SELECT policyname, permissive, cmd FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'folder'
       ORDER BY policyname
    `;
    expect(policies).toEqual([
      { policyname: 'folder_active_workspace', permissive: 'PERMISSIVE', cmd: 'ALL' },
      { policyname: 'folder_project_narrow', permissive: 'RESTRICTIVE', cmd: 'SELECT' },
    ]);

    const [flags] = await adminDb.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'folder'
    `;
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('hides and refuses writes to another workspace’s folders', async () => {
    const t = await makeTenants();
    const mine = await makeFolder({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    const theirs = await makeFolder({ workspaceId: t.w2, projectId: t.p2, createdById: t.userBId });

    const visible = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
      tx.folder.findMany({ select: { id: true } }),
    );
    expect(visible.map((f) => f.id)).toEqual([mine]);

    // Invisible, so an update addresses no row.
    await expect(
      asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
        tx.folder.update({ where: { id: theirs }, data: { name: 'Stolen' } }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    // WITH CHECK refuses placing a folder into a foreign workspace.
    await expect(
      asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
        tx.folder.create({
          data: {
            workspaceId: t.w2,
            projectId: t.p2,
            createdById: t.userAId,
            name: 'Planted',
            position: 'a0',
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('narrows reads to the bound project when app.project_id is set', async () => {
    const t = await makeTenants();
    const inP1 = await makeFolder({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    const inP1b = await makeFolder({ workspaceId: t.w1, projectId: t.p1b, createdById: t.userAId });

    const narrowed = await asAppRole(
      { userId: t.userAId, workspaceId: t.w1, projectId: t.p1 },
      (tx) => tx.folder.findMany({ select: { id: true } }),
    );
    expect(narrowed.map((f) => f.id)).toEqual([inP1]);

    const wide = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
      tx.folder.findMany({ select: { id: true }, orderBy: { position: 'asc' } }),
    );
    expect(wide.map((f) => f.id).sort()).toEqual([inP1, inP1b].sort());
  });
});
