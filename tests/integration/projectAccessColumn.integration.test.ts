import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type ProjectAccessLevel, type ProjectAccessMode } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { levelForMode } from '@/lib/projects/accessMode';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectTagRepository } from '@/lib/repositories/projectTagRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectSquareService } from '@/lib/services/projectSquareService';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { runAsCloudBuild } from '../helpers/cloudBuild';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '../helpers/projectAccess';

// THE ACCESS-COLUMN INTEGRATION GATE (Story MOTIR-6554 · Subtask MOTIR-6688).
//
// The story's single claim, against the real database: a project is public — to
// the seven RLS public-read policies and to every public read path — exactly when
// its MODE is `public`, and nothing reads the retired `accessLevel`.
//
// Two roles, deliberately. Every row is SEEDED as the owner role (`adminDb`),
// including the two rows the product can no longer produce (the columns
// deliberately disagreeing). Every policy read runs under the APP role
// (`motir_app`) with NO workspace bound — the signed-out context the public
// surface uses — and asserts that it IS that role before anything else, so a
// case cannot pass vacuously as an owner that bypasses RLS. The application's
// public reads (`findPublicByIdentifier`, the directory, the explore search, the
// tag counts) run as they run in production, through their own filters.

runAsCloudBuild();

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

type Surface = {
  ownerId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  identifier: string;
  name: string;
  workItemId: string;
  tagSlug: string;
};

/**
 * One project holding a row in every table a public-read policy guards: a work
 * item, a workflow status, a public request vote, a public address, and a tag.
 */
async function seedSurface(mode: ProjectAccessMode): Promise<Surface> {
  const n = seq++;
  const { workspace, owner } = await createTestWorkspace({ name: `PAC ${n}` });
  const identifier = `PAC${n}`;
  const name = `Access column ${n}`;
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name,
      slug: `pac-${n}`,
      identifier,
      ...projectAccessData(mode),
    },
  });
  const workItem = await adminDb.workItem.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      kind: 'task',
      identifier: `${identifier}-1`,
      key: 1,
      title: 'A public request',
      reporterId: owner.id,
      position: 'a0',
      backlogRank: 'a0',
    },
  });
  await adminDb.workflowStatus.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      position: 'a0',
      isInitial: true,
    },
  });
  const voter = await createTestUser({ email: `pac-voter-${n}@example.com` });
  await adminDb.publicRequestVote.create({ data: { workItemId: workItem.id, userId: voter.id } });
  await adminDb.publicAddress.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      hostname: `pac-${n}.example.test`,
      kind: 'custom_domain',
      status: 'issued',
      verificationToken: `motir-verify-pac-${n}`,
    },
  });
  const tagSlug = `pac-tag-${n}`;
  const tag = await adminDb.projectTag.create({ data: { slug: tagSlug, label: `Tag ${n}` } });
  await adminDb.projectTagAssignment.create({ data: { projectId: project.id, tagId: tag.id } });
  return {
    ownerId: owner.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    identifier,
    name,
    workItemId: workItem.id,
    tagSlug,
  };
}

/**
 * Write the two columns directly, as the OWNER role — the only way to build a row
 * whose mode and level disagree, which the product (`setAccessMode`) never writes.
 */
async function setColumns(projectId: string, mode: ProjectAccessMode, level: ProjectAccessLevel) {
  await adminDb.$executeRaw`
    UPDATE "project"
       SET "access_mode" = ${mode}::"project_access_mode",
           "accessLevel" = ${level}::"project_access_level"
     WHERE "id" = ${projectId}`;
}

/** Run `fn` as the app role with NO workspace bound, and prove the role first. */
async function signedOut<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    const [who] = await tx.$queryRaw<Array<{ role: string; ws: string | null }>>`
      SELECT current_user AS role, nullif(current_setting('app.workspace_id', true), '') AS ws`;
    expect(who, 'the read must run as the app role, unbound').toEqual({
      role: 'motir_app',
      ws: null,
    });
    return fn(tx);
  });
}

/** How many of the surface's rows each of the seven policy-guarded tables admits, signed out. */
async function policyReads(s: Surface): Promise<Record<string, number>> {
  return signedOut(async (tx) => {
    const count = async (q: Prisma.Sql) =>
      Number((await tx.$queryRaw<Array<{ n: bigint }>>(q))[0]!.n);
    return {
      project: await count(
        Prisma.sql`SELECT count(*) AS n FROM "project" WHERE "id" = ${s.projectId}`,
      ),
      work_item: await count(
        Prisma.sql`SELECT count(*) AS n FROM "work_item" WHERE "projectId" = ${s.projectId}`,
      ),
      workflow_status: await count(
        Prisma.sql`SELECT count(*) AS n FROM "workflow_status" WHERE "project_id" = ${s.projectId}`,
      ),
      workspace: await count(
        Prisma.sql`SELECT count(*) AS n FROM "workspace" WHERE "id" = ${s.workspaceId}`,
      ),
      organization: await count(
        Prisma.sql`SELECT count(*) AS n FROM "organization" WHERE "id" = ${s.organizationId}`,
      ),
      public_request_vote: await count(
        Prisma.sql`SELECT count(*) AS n FROM "public_request_vote" WHERE "work_item_id" = ${s.workItemId}`,
      ),
      public_address: await count(
        Prisma.sql`SELECT count(*) AS n FROM "public_address" WHERE "project_id" = ${s.projectId}`,
      ),
    };
  });
}

const ALL_SEVEN = (n: 0 | 1) => ({
  project: n,
  work_item: n,
  workflow_status: n,
  workspace: n,
  organization: n,
  public_request_vote: n,
  public_address: n,
});

/** Whether the project is visible on each application public read path. */
async function publicPaths(s: Surface) {
  const byKey = await projectRepository.findPublicByIdentifier(s.identifier);
  const directory = await projectRepository.listPublic();
  const explore = await projectSquareService.listDirectory({ search: s.name });
  const tags = await projectTagRepository.listWithPublicCounts();
  return {
    byIdentifier: byKey?.id === s.projectId,
    directory: directory.some((p) => p.identifier === s.identifier),
    explore: explore.items.some((c) => c.identifier === s.identifier),
    tagCount: tags.find((t) => t.slug === s.tagSlug)?.publicProjectCount ?? 0,
  };
}

const VISIBLE = { byIdentifier: true, directory: true, explore: true, tagCount: 1 };
const HIDDEN = { byIdentifier: false, directory: false, explore: false, tagCount: 0 };

describe('the seven public-read policies', () => {
  it('ADMIT every row of a project whose mode is public, signed out', async () => {
    const s = await seedSurface('public');
    expect(await policyReads(s)).toEqual(ALL_SEVEN(1));
  });

  it.each(['members', 'workspace'] as const)(
    'REFUSE every row of a project whose mode is %s, signed out',
    async (mode) => {
      const s = await seedSurface(mode);
      expect(await policyReads(s)).toEqual(ALL_SEVEN(0));
    },
  );
});

describe('the two columns deliberately disagreeing — nothing reads the level', () => {
  it('mode members with level public is refused on every public path', async () => {
    const s = await seedSurface('public');
    await setColumns(s.projectId, 'members', 'public');
    expect(await policyReads(s)).toEqual(ALL_SEVEN(0));
    expect(await publicPaths(s)).toEqual(HIDDEN);
  });

  it('mode public with level open is readable on every public path', async () => {
    const s = await seedSurface('workspace');
    await setColumns(s.projectId, 'public', 'open');
    expect(await policyReads(s)).toEqual(ALL_SEVEN(1));
    expect(await publicPaths(s)).toEqual(VISIBLE);
  });
});

describe('creation', () => {
  it('a project created with no mode is Open to the workspace: a Full member enters, no public path lists it', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: `PAC create ${seq++}` });
    const full = await createTestUser({ email: `pac-full-${seq++}@example.com` });
    await workspacesService.addMember({ userId: full.id, workspaceId: workspace.id });
    const dto = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Created unset',
    });
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: dto.id } });
    expect([row.accessMode, row.accessLevel]).toEqual(['workspace', 'open']);
    expect(
      await projectAccessService.getCapabilities(row.id, {
        userId: full.id,
        workspaceId: workspace.id,
      }),
    ).toMatchObject({ canBrowse: true });
    expect(await projectRepository.findPublicByIdentifier(dto.identifier)).toBeNull();
    expect((await projectRepository.listPublic()).map((p) => p.identifier)).not.toContain(
      dto.identifier,
    );
  });
});

describe('the setter', () => {
  it('public → members → workspace shows at once on the listings and the policies, writing levelForMode beside each', async () => {
    const s = await seedSurface('workspace');
    const ctx = { userId: s.ownerId, workspaceId: s.workspaceId };
    for (const [mode, visible] of [
      ['public', true],
      ['members', false],
      ['workspace', false],
    ] as const) {
      await projectMembersService.setAccessMode({
        key: s.identifier,
        actorUserId: s.ownerId,
        ctx,
        mode,
      });
      const row = await adminDb.project.findUniqueOrThrow({ where: { id: s.projectId } });
      expect([row.accessMode, row.accessLevel], mode).toEqual([mode, levelForMode(mode)]);
      expect(await publicPaths(s), mode).toEqual(visible ? VISIBLE : HIDDEN);
      expect(await policyReads(s), mode).toEqual(ALL_SEVEN(visible ? 1 : 0));
    }
  });
});
