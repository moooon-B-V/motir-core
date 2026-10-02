import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma } from '@/generated/prisma/client';
import { RLS_DENIAL, isRlsDenial } from '../helpers/sqlstate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The PAGE VERSION schema — MOTIR-7382 (Story MOTIR-5754, Epic MOTIR-5746).
//
// Proves, on real Postgres, what `20261002200000_page_version` makes the
// DATABASE do, independent of any service: the unique (page, number), the
// CHECKs, the cotenancy trigger, the restore source's SET NULL, the cascade
// from `page`, RLS under the non-bypass `motir_app` role, and the backfill —
// re-run from the migration file itself, so the statement tested is the one
// that shipped. `tests/page-schema-rls.test.ts` is the same shape.

const MIGRATION = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261002200000_page_version/migration.sql'),
  'utf8',
);
/** The migration's backfill statement, verbatim. */
const BACKFILL_SQL = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO "page_version"')).trim();

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
  p1: string;
  p1b: string;
  p2: string;
}

async function makeTenants(): Promise<Tenants> {
  const userA = await usersService.createUser({
    email: 'pv-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Version Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'pv-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Version Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'PV W1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'PV W2', ownerUserId: userB.id });
  const p1 = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'PV P1',
    identifier: 'PVONE',
  });
  const p1b = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'PV P1b',
    identifier: 'PVONEB',
  });
  const p2 = await projectsService.createProject({
    workspaceId: w2.workspace.id,
    actorUserId: userB.id,
    name: 'PV P2',
    identifier: 'PVTWO',
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

const BODY = Uint8Array.from([1, 2, 3, 4]);
const EMPTY_DOC = { type: 'doc', content: [] };

async function makePage(t: { workspaceId: string; projectId: string; userId: string }) {
  const n = next();
  const row = await adminDb.page.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      createdById: t.userId,
      updatedById: t.userId,
      title: `Page ${n}`,
      position: `a${n.toString(36)}`,
      bodyState: BODY,
      bodyJson: EMPTY_DOC,
      bodyMarkdown: `body ${n}`,
    },
  });
  return row;
}

async function makeVersion(args: {
  workspaceId: string;
  projectId: string;
  pageId: string;
  authorId: string;
  number: number;
  restoredFromVersionId?: string | null;
  restoredFromNumber?: number | null;
}) {
  const at = new Date('2026-10-02T10:00:00.000Z');
  return adminDb.pageVersion.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      pageId: args.pageId,
      authorId: args.authorId,
      number: args.number,
      bodyState: BODY,
      bodyMarkdown: `v${args.number}`,
      startedAt: at,
      savedAt: at,
      restoredFromVersionId: args.restoredFromVersionId ?? null,
      restoredFromNumber: args.restoredFromNumber ?? null,
    },
  });
}

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

describe('page_version — the backfill', () => {
  it('leaves exactly one version 1 per page, holding its current body', async () => {
    const t = await makeTenants();
    const a = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const b = await makePage({ workspaceId: t.w2, projectId: t.p2, userId: t.userBId });
    // A later edit by somebody else: the version's author is the LAST writer.
    const edited = await adminDb.page.update({
      where: { id: a.id },
      data: { updatedById: t.userBId, bodyMarkdown: 'edited', bodyState: Uint8Array.from([9]) },
    });

    await adminDb.$executeRawUnsafe(BACKFILL_SQL);

    const rows = await adminDb.pageVersion.findMany({ orderBy: { bodyMarkdown: 'asc' } });
    expect(rows).toHaveLength(2);
    const byPage = new Map(rows.map((r) => [r.pageId, r]));
    expect(byPage.get(a.id)).toMatchObject({
      number: 1,
      workspaceId: t.w1,
      projectId: t.p1,
      authorId: t.userBId,
      bodyMarkdown: 'edited',
      startedAt: edited.createdAt,
      savedAt: edited.updatedAt,
      restoredFromVersionId: null,
      restoredFromNumber: null,
    });
    expect(Buffer.from(byPage.get(a.id)!.bodyState).equals(Buffer.from([9]))).toBe(true);
    expect(byPage.get(b.id)).toMatchObject({ number: 1, authorId: t.userBId, workspaceId: t.w2 });
  });
});

describe('page_version — constraints', () => {
  it('refuses a second (page, number)', async () => {
    const t = await makeTenants();
    const page = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const base = { workspaceId: t.w1, projectId: t.p1, pageId: page.id, authorId: t.userAId };
    await makeVersion({ ...base, number: 1 });
    await expect(makeVersion({ ...base, number: 1 })).rejects.toMatchObject({ code: 'P2002' });
    await makeVersion({ ...base, number: 2 });
  });

  it('refuses a number below 1 and a saved_at before started_at', async () => {
    const t = await makeTenants();
    const page = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const base = { workspaceId: t.w1, projectId: t.p1, pageId: page.id, authorId: t.userAId };
    await expect(makeVersion({ ...base, number: 0 })).rejects.toThrow(
      /page_version_number_positive/,
    );
    await expect(
      adminDb.pageVersion.create({
        data: {
          ...base,
          number: 1,
          bodyState: BODY,
          bodyMarkdown: '',
          startedAt: new Date('2026-10-02T10:00:00Z'),
          savedAt: new Date('2026-10-02T09:59:59Z'),
        },
      }),
    ).rejects.toThrow(/page_version_saved_after_started/);
  });

  it('refuses a restore id without its number', async () => {
    const t = await makeTenants();
    const page = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const base = { workspaceId: t.w1, projectId: t.p1, pageId: page.id, authorId: t.userAId };
    const v1 = await makeVersion({ ...base, number: 1 });
    await expect(
      makeVersion({ ...base, number: 2, restoredFromVersionId: v1.id, restoredFromNumber: null }),
    ).rejects.toThrow(/page_version_restore_keeps_number/);
  });

  it('keeps a restore row and its number when its source is deleted', async () => {
    const t = await makeTenants();
    const page = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const base = { workspaceId: t.w1, projectId: t.p1, pageId: page.id, authorId: t.userAId };
    const v1 = await makeVersion({ ...base, number: 1 });
    const v2 = await makeVersion({
      ...base,
      number: 2,
      restoredFromVersionId: v1.id,
      restoredFromNumber: 1,
    });

    await adminDb.pageVersion.delete({ where: { id: v1.id } });

    expect(await adminDb.pageVersion.findUniqueOrThrow({ where: { id: v2.id } })).toMatchObject({
      restoredFromVersionId: null,
      restoredFromNumber: 1,
    });
  });

  it('deletes a page’s versions with the page', async () => {
    const t = await makeTenants();
    const page = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const base = { workspaceId: t.w1, projectId: t.p1, pageId: page.id, authorId: t.userAId };
    await makeVersion({ ...base, number: 1 });
    await makeVersion({ ...base, number: 2 });

    await adminDb.page.delete({ where: { id: page.id } });

    expect(await adminDb.pageVersion.count({ where: { pageId: page.id } })).toBe(0);
  });
});

describe('page_version — cotenancy', () => {
  it('refuses a version whose project or workspace differs from its page’s', async () => {
    const t = await makeTenants();
    const page = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    await expect(
      makeVersion({
        workspaceId: t.w1,
        projectId: t.p1b,
        pageId: page.id,
        authorId: t.userAId,
        number: 1,
      }),
    ).rejects.toThrow(/PAGE_VERSION_CROSS_PROJECT/);
    await expect(
      makeVersion({
        workspaceId: t.w2,
        projectId: t.p2,
        pageId: page.id,
        authorId: t.userAId,
        number: 1,
      }),
    ).rejects.toThrow(/PAGE_VERSION_CROSS_WORKSPACE/);
  });

  it('refuses a restore that names another page’s version', async () => {
    const t = await makeTenants();
    const page = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const other = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const foreign = await makeVersion({
      workspaceId: t.w1,
      projectId: t.p1,
      pageId: other.id,
      authorId: t.userAId,
      number: 1,
    });
    await expect(
      makeVersion({
        workspaceId: t.w1,
        projectId: t.p1,
        pageId: page.id,
        authorId: t.userAId,
        number: 1,
        restoredFromVersionId: foreign.id,
        restoredFromNumber: 1,
      }),
    ).rejects.toThrow(/PAGE_VERSION_RESTORE_CROSS_PAGE/);
  });
});

describe('page_version — RLS under the non-bypass role', () => {
  it('carries the page policy pair, enabled and forced (catalog)', async () => {
    const policies = await adminDb.$queryRaw<
      { policyname: string; permissive: string; cmd: string }[]
    >`
      SELECT policyname, permissive, cmd FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'page_version'
       ORDER BY policyname
    `;
    expect(policies).toEqual([
      { policyname: 'page_version_active_workspace', permissive: 'PERMISSIVE', cmd: 'ALL' },
      { policyname: 'page_version_project_narrow', permissive: 'RESTRICTIVE', cmd: 'SELECT' },
    ]);
    const [flags] = await adminDb.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'page_version'
    `;
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('hides another workspace’s versions and refuses writing one', async () => {
    const t = await makeTenants();
    const mine = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const theirs = await makePage({ workspaceId: t.w2, projectId: t.p2, userId: t.userBId });
    const v = await makeVersion({
      workspaceId: t.w1,
      projectId: t.p1,
      pageId: mine.id,
      authorId: t.userAId,
      number: 1,
    });
    await makeVersion({
      workspaceId: t.w2,
      projectId: t.p2,
      pageId: theirs.id,
      authorId: t.userBId,
      number: 1,
    });

    const visible = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
      tx.pageVersion.findMany({ select: { id: true } }),
    );
    expect(visible.map((r) => r.id)).toEqual([v.id]);

    await expect(
      asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
        tx.pageVersion.create({
          data: {
            workspaceId: t.w2,
            projectId: t.p2,
            pageId: theirs.id,
            authorId: t.userAId,
            number: 2,
            bodyState: BODY,
            bodyMarkdown: '',
            startedAt: new Date(),
            savedAt: new Date(),
          },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
  });

  it('narrows reads to the bound project when app.project_id is set', async () => {
    const t = await makeTenants();
    const inP1 = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const inP1b = await makePage({ workspaceId: t.w1, projectId: t.p1b, userId: t.userAId });
    const v1 = await makeVersion({
      workspaceId: t.w1,
      projectId: t.p1,
      pageId: inP1.id,
      authorId: t.userAId,
      number: 1,
    });
    const v1b = await makeVersion({
      workspaceId: t.w1,
      projectId: t.p1b,
      pageId: inP1b.id,
      authorId: t.userAId,
      number: 1,
    });

    const narrowed = await asAppRole(
      { userId: t.userAId, workspaceId: t.w1, projectId: t.p1 },
      (tx) => tx.pageVersion.findMany({ select: { id: true } }),
    );
    expect(narrowed.map((r) => r.id)).toEqual([v1.id]);

    const wide = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
      tx.pageVersion.findMany({ select: { id: true } }),
    );
    expect(wide.map((r) => r.id).sort()).toEqual([v1.id, v1b.id].sort());
  });
});
