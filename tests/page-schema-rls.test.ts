import type { Prisma } from '@/generated/prisma/client';
import { RLS_DENIAL, isRlsDenial } from './helpers/sqlstate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// The PAGE schema — MOTIR-7273 (Story MOTIR-5752, Epic MOTIR-5746).
//
// Proves, on real Postgres, what `20261001230000_page` makes the DATABASE
// refuse, independent of any service:
//   * a page under a parent page AND in a folder (the XOR CHECK);
//   * a page carrying 10 ancestors — an 11th level (the depth CHECK);
//   * a parent page or a folder from another project / workspace (the trigger);
//   * a page becoming its own parent or its own ancestor (the cycle backstop);
// and that the `bytea` body round-trips a full 1 MiB intact. Then the tenancy
// pair on `page` under the non-bypass `motir_app` role, by catalog AND by
// behaviour.
//
// Fixtures are written as the owner (`adminDb`), where RLS does not bite and the
// triggers still run. Every RLS assertion runs inside `asAppRole`, which drops to
// `motir_app` — `tests/folder-schema-rls.test.ts` is the same shape.

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
    email: 'page-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Page Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'page-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Page Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'Page W1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'Page W2', ownerUserId: userB.id });
  const p1 = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'Page P1',
    identifier: 'PGONE',
  });
  const p1b = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'Page P1b',
    identifier: 'PGONEB',
  });
  const p2 = await projectsService.createProject({
    workspaceId: w2.workspace.id,
    actorUserId: userB.id,
    name: 'Page P2',
    identifier: 'PGTWO',
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

// A body is opaque to the schema; any bytes and any JSON satisfy the columns.
const EMPTY_BODY = Uint8Array.from([0, 0]);
const EMPTY_DOC = { type: 'doc', content: [] };

async function makeFolder(t: { workspaceId: string; projectId: string; createdById: string }) {
  const n = next();
  const row = await adminDb.folder.create({
    data: { ...t, name: `Folder ${n}`, position: `a${n.toString(36)}` },
  });
  return row.id;
}

async function makePage(args: {
  workspaceId: string;
  projectId: string;
  createdById: string;
  parentPageId?: string | null;
  folderId?: string | null;
  ancestorPageIds?: string[];
}): Promise<string> {
  const n = next();
  const row = await adminDb.page.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      createdById: args.createdById,
      updatedById: args.createdById,
      title: `Page ${n}`,
      position: `a${n.toString(36)}`,
      parentPageId: args.parentPageId ?? null,
      folderId: args.folderId ?? null,
      ancestorPageIds: args.ancestorPageIds ?? [],
      bodyState: EMPTY_BODY,
      bodyJson: EMPTY_DOC,
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

describe('page — columns and defaults', () => {
  it('defaults the title, the derived formats, the ancestors and the revision', async () => {
    const t = await makeTenants();
    const row = await adminDb.page.create({
      data: {
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        updatedById: t.userAId,
        position: 'a0',
        bodyState: EMPTY_BODY,
        bodyJson: EMPTY_DOC,
      },
    });
    expect(row).toMatchObject({
      title: '',
      bodyMarkdown: '',
      bodyText: '',
      ancestorPageIds: [],
      revision: 1,
      parentPageId: null,
      folderId: null,
    });
  });

  it('round-trips a 1 MiB body through bytea byte for byte', async () => {
    const t = await makeTenants();
    const body = new Uint8Array(1_048_576);
    for (let i = 0; i < body.length; i += 1) body[i] = (i * 31 + 7) & 0xff;

    const id = await makePage({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    await adminDb.page.update({ where: { id }, data: { bodyState: body } });

    const read = await adminDb.page.findUniqueOrThrow({
      where: { id },
      select: { bodyState: true },
    });
    expect(read.bodyState.byteLength).toBe(1_048_576);
    expect(Buffer.from(read.bodyState).equals(Buffer.from(body))).toBe(true);
  });
});

describe('page — placement is a parent page XOR a folder, at most 10 levels', () => {
  it('refuses a page under a parent page AND in a folder, and admits either alone', async () => {
    const t = await makeTenants();
    const parent = await makePage({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    const folder = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
    });

    // Same tenancy on both sides, so the CHECK is the only thing that can refuse.
    await expect(
      makePage({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        parentPageId: parent,
        folderId: folder,
        ancestorPageIds: [parent],
      }),
    ).rejects.toThrow(/page_parent_xor_folder/);

    const child = await makePage({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      parentPageId: parent,
      ancestorPageIds: [parent],
    });
    const filed = await makePage({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      folderId: folder,
    });
    expect(
      await adminDb.page.findMany({
        where: { id: { in: [child, filed] } },
        select: { id: true, parentPageId: true, folderId: true },
        orderBy: { position: 'asc' },
      }),
    ).toEqual([
      { id: child, parentPageId: parent, folderId: null },
      { id: filed, parentPageId: null, folderId: folder },
    ]);
  });

  it('admits the tenth level (9 ancestors) and refuses an eleventh (10 ancestors)', async () => {
    const t = await makeTenants();
    const chain: string[] = [];
    let parent: string | null = null;
    // Levels 1 to 10: level N carries N - 1 ancestors.
    for (let level = 1; level <= 10; level += 1) {
      const id: string = await makePage({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        parentPageId: parent,
        ancestorPageIds: [...chain],
      });
      if (parent !== null) chain.push(parent);
      // The ancestors of the NEXT page are this page's ancestors plus itself.
      parent = id;
    }
    expect(chain).toHaveLength(9);

    await expect(
      makePage({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        parentPageId: parent,
        ancestorPageIds: [...chain, parent!],
      }),
    ).rejects.toThrow(/page_depth_limit/);
  });
});

describe('page — tenancy and cycles', () => {
  it('refuses a parent page from another project or another workspace', async () => {
    const t = await makeTenants();
    const siblingProjectPage = await makePage({
      workspaceId: t.w1,
      projectId: t.p1b,
      createdById: t.userAId,
    });
    const otherWorkspacePage = await makePage({
      workspaceId: t.w2,
      projectId: t.p2,
      createdById: t.userBId,
    });

    await expect(
      makePage({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        parentPageId: siblingProjectPage,
        ancestorPageIds: [siblingProjectPage],
      }),
    ).rejects.toThrow(/PAGE_PARENT_CROSS_PROJECT/);
    await expect(
      makePage({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        parentPageId: otherWorkspacePage,
        ancestorPageIds: [otherWorkspacePage],
      }),
    ).rejects.toThrow(/PAGE_PARENT_CROSS_WORKSPACE/);
  });

  it('refuses a folder from another project or another workspace, on insert and on move', async () => {
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
      makePage({
        workspaceId: t.w1,
        projectId: t.p1,
        createdById: t.userAId,
        folderId: siblingProjectFolder,
      }),
    ).rejects.toThrow(/PAGE_FOLDER_CROSS_PROJECT/);

    const page = await makePage({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    await expect(
      adminDb.page.update({ where: { id: page }, data: { folderId: otherWorkspaceFolder } }),
    ).rejects.toThrow(/PAGE_FOLDER_CROSS_WORKSPACE/);
  });

  it('refuses a page becoming its own parent or its own ancestor', async () => {
    const t = await makeTenants();
    const outer = await makePage({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    const middle = await makePage({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      parentPageId: outer,
      ancestorPageIds: [outer],
    });
    const inner = await makePage({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      parentPageId: middle,
      ancestorPageIds: [outer, middle],
    });

    await expect(
      adminDb.page.update({ where: { id: outer }, data: { parentPageId: outer } }),
    ).rejects.toThrow(/PAGE_PARENT_CYCLE/);
    // Moving the root under its own grandchild would close the loop.
    await expect(
      adminDb.page.update({
        where: { id: outer },
        data: { parentPageId: inner, ancestorPageIds: [outer, middle, inner] },
      }),
    ).rejects.toThrow(/PAGE_PARENT_CYCLE/);

    // The positive control: moving the innermost page up to the root is fine.
    await adminDb.page.update({
      where: { id: inner },
      data: { parentPageId: null, ancestorPageIds: [] },
    });
  });

  it('refuses deleting a page that still holds sub-pages, or a folder that still holds pages', async () => {
    const t = await makeTenants();
    const folder = await makeFolder({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
    });
    const parent = await makePage({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      folderId: folder,
    });
    await makePage({
      workspaceId: t.w1,
      projectId: t.p1,
      createdById: t.userAId,
      parentPageId: parent,
      ancestorPageIds: [parent],
    });

    await expect(adminDb.page.delete({ where: { id: parent } })).rejects.toThrow();
    await expect(adminDb.folder.delete({ where: { id: folder } })).rejects.toThrow();
  });
});

describe('page — RLS under the non-bypass role', () => {
  it('carries the folder policy pair, enabled and forced (catalog)', async () => {
    const policies = await adminDb.$queryRaw<
      { policyname: string; permissive: string; cmd: string }[]
    >`
      SELECT policyname, permissive, cmd FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'page'
       ORDER BY policyname
    `;
    expect(policies).toEqual([
      { policyname: 'page_active_workspace', permissive: 'PERMISSIVE', cmd: 'ALL' },
      { policyname: 'page_project_narrow', permissive: 'RESTRICTIVE', cmd: 'SELECT' },
    ]);

    const [flags] = await adminDb.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'page'
    `;
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('hides and refuses writes to another workspace’s pages', async () => {
    const t = await makeTenants();
    const mine = await makePage({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    const theirs = await makePage({ workspaceId: t.w2, projectId: t.p2, createdById: t.userBId });

    const visible = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
      tx.page.findMany({ select: { id: true } }),
    );
    expect(visible.map((p) => p.id)).toEqual([mine]);

    // Invisible, so an update addresses no row.
    await expect(
      asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
        tx.page.update({ where: { id: theirs }, data: { title: 'Stolen' } }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    // WITH CHECK refuses placing a page into a foreign workspace.
    await expect(
      asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
        tx.page.create({
          data: {
            workspaceId: t.w2,
            projectId: t.p2,
            createdById: t.userAId,
            updatedById: t.userAId,
            title: 'Planted',
            position: 'a0',
            bodyState: EMPTY_BODY,
            bodyJson: EMPTY_DOC,
          },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
  });

  it('narrows reads to the bound project when app.project_id is set', async () => {
    const t = await makeTenants();
    const inP1 = await makePage({ workspaceId: t.w1, projectId: t.p1, createdById: t.userAId });
    const inP1b = await makePage({ workspaceId: t.w1, projectId: t.p1b, createdById: t.userAId });

    const narrowed = await asAppRole(
      { userId: t.userAId, workspaceId: t.w1, projectId: t.p1 },
      (tx) => tx.page.findMany({ select: { id: true } }),
    );
    expect(narrowed.map((p) => p.id)).toEqual([inP1]);

    const wide = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
      tx.page.findMany({ select: { id: true } }),
    );
    expect(wide.map((p) => p.id).sort()).toEqual([inP1, inP1b].sort());
  });
});
