import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST } from '@/app/api/internal/ai/work-items/route';
import { PLANNER_BUG_HOME_MARKER, PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { db } from '@/lib/db';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { foldersService } from '@/lib/services/foldersService';
import { readOnboardingSubstrate } from '@/lib/services/onboardingSubstrateService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The STORY GATE for "every project has a Bugs folder" — Story MOTIR-4927 ·
// Subtask MOTIR-4939. The ASSEMBLED seam, on a real Postgres: a pointer written
// by the seed or the backfill, changed through the Bugs room's service, carried by
// a folder delete, read by the resolver, and acted on by the REAL filer
// (`POST /api/internal/ai/work-items` → `aiWorkItemsService.fileBug`). Each card's
// own tests prove its layer; this file proves the joins, and nothing is mocked.
//
// What the card asks this gate to prove, and where:
//   1  created → seeded → still empty           → 'seam 1 · created, seeded, still empty'
//   2  backfilled, both populations, one DB      → 'seam 2 · backfilled'
//   3  re-pointed → filed                        → 'seam 3 · re-pointed, then filed'
//   4  root → filed                              → 'seam 4 · the root, then filed'
//   5  delete carries up → filed                 → 'seam 5 · a delete carries the destination'
//   6  the planner marker is untouched           → 'seam 6 · the planner marker'
//
// Every spec seeds its own workspace, project and users; the tables are
// truncated between specs.

const SECRET = 'bug-destination-story-gate-secret';
const PASSWORD = 'bug-destination-story-gate-pass-123';

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260914200100_backfill_project_bug_destination_folder/migration.sql',
  ),
  'utf8',
);

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenant {
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
  systemUserId: string;
}

/** A workspace, its owner, one project made by the REAL `createProject`, and the system principal the filer acts as. */
async function makeTenant(tag: string, identifier: string): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: `gate-${tag}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Gate ${tag}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Gate ${tag}`,
    identifier,
  });
  const { userId: systemUserId } = await seedSystemPrincipal({
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectKey: project.identifier,
    systemUserId,
  };
}

/**
 * A SECOND project in the tenant's workspace, the system principal enrolled in it.
 * The principal resolves to ONE workspace — the meta workspace it is seeded into —
 * so a second project the filer must reach lives beside the first, not in a
 * workspace of its own.
 */
async function addProject(t: Tenant, identifier: string): Promise<Tenant> {
  const project = await projectsService.createProject({
    workspaceId: t.ctx.workspaceId,
    actorUserId: t.ctx.userId,
    name: `Gate ${identifier}`,
    identifier,
  });
  await projectMembersService.addMember({
    key: project.identifier,
    actorUserId: t.ctx.userId,
    ctx: t.ctx,
    targetUserId: t.systemUserId,
    role: 'member',
  });
  return { ...t, projectId: project.id, projectKey: project.identifier };
}

/** File a bug through the REAL internal filer, and read it back from the database. */
async function fileBug(projectKey: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await POST(
    new Request('http://internal/api/internal/ai/work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ projectKey, kind: 'bug', title, ...extra }),
    }),
  );
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

function folder(t: Tenant, name: string, parentFolderId: string | null) {
  return foldersService.createFolder({ projectId: t.projectId, parentFolderId, name }, t.ctx);
}

async function destinationOf(projectId: string) {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return project.bugDestinationFolderId;
}

/** Execute the backfill's statements the way `migrate deploy` would, one at a time. */
async function runBackfill(): Promise<void> {
  const statements = MIGRATION_SQL.split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await adminDb.$executeRawUnsafe(stmt);
  }
}

describe('seam 1 · created, seeded, still empty', () => {
  it('a project from the real createProject has its Bugs folder and a pointer to it, and nothing to plan, dispatch or onboard from', async () => {
    const t = await makeTenant('empty', 'GEMP');

    const bugs = await seededBugsFolderId(t.projectId);
    expect(await destinationOf(t.projectId)).toBe(bugs);
    await expect(bugDestinationService.getSettings(t.projectId, t.ctx)).resolves.toMatchObject({
      folder: { id: bugs, path: ['Bugs'] },
      bugsFolder: { id: bugs },
    });

    expect(await adminDb.workItem.count({ where: { projectId: t.projectId } })).toBe(0);
    expect((await readOnboardingSubstrate(t.projectId, t.ctx)).itemCount).toBe(0);
    expect((await workItemsService.listReady(t.projectId, { limit: 100 }, t.ctx)).items).toEqual(
      [],
    );
    expect(
      await workItemsService.listRootIssues(
        t.projectId,
        { sort: { column: 'key', direction: 'asc' } },
        t.ctx,
      ),
    ).toMatchObject({ total: 1, workItemTotal: 0 });
  });
});

describe('seam 2 · backfilled', () => {
  it('adopts a root folder already named bugs and creates one where there is none — and the next filed bug lands in each', async () => {
    const adopter = await makeTenant('adopt', 'GADP');
    const creator = await addProject(adopter, 'GCRT');
    // Put both back in the state every project was in before the seed: no pointer.
    // The adopter keeps a root folder named BUGS; the creator has no folder at all.
    const adopted = await seededBugsFolderId(adopter.projectId);
    const creatorsSeeded = await seededBugsFolderId(creator.projectId);
    await adminDb.project.updateMany({
      where: { id: { in: [adopter.projectId, creator.projectId] } },
      data: { bugDestinationFolderId: null },
    });
    await adminDb.folder.update({ where: { id: adopted }, data: { name: 'BUGS' } });
    await adminDb.folder.delete({ where: { id: creatorsSeeded } });

    await runBackfill();

    expect(await destinationOf(adopter.projectId)).toBe(adopted);
    expect(await adminDb.folder.count({ where: { projectId: adopter.projectId } })).toBe(1);
    const created = await adminDb.folder.findFirstOrThrow({
      where: { projectId: creator.projectId, parentFolderId: null, name: 'Bugs' },
    });
    expect(await destinationOf(creator.projectId)).toBe(created.id);

    expect((await fileBug(adopter.projectKey, 'After the backfill')).folderId).toBe(adopted);
    expect((await fileBug(creator.projectKey, 'After the backfill')).folderId).toBe(created.id);
  });
});

describe('seam 3 · re-pointed, then filed', () => {
  it('a destination changed through the Bugs room’s service is where the real filer puts the NEXT bug', async () => {
    const t = await makeTenant('repoint', 'GRPT');
    const bugs = await seededBugsFolderId(t.projectId);
    const triage = await folder(t, 'Triage', bugs);

    const before = await fileBug(t.projectKey, 'Before the change');
    await bugDestinationService.setDestination(t.projectId, triage.id, t.ctx);
    const after = await fileBug(t.projectKey, 'After the change');

    expect(before).toMatchObject({ folderId: bugs, parentId: null });
    expect(after).toMatchObject({ folderId: triage.id, parentId: null });
    // Changing the destination moves no bug that was already filed.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: before.id } })).folderId).toBe(
      bugs,
    );
  });
});

describe('seam 4 · the root, then filed', () => {
  it('a destination set to the project root files the next bug unplaced — no folder and no parent', async () => {
    const t = await makeTenant('root', 'GROT');

    await expect(
      bugDestinationService.setDestination(t.projectId, null, t.ctx),
    ).resolves.toMatchObject({ folder: null });
    const bug = await fileBug(t.projectKey, 'At the root');

    expect(bug).toMatchObject({ folderId: null, parentId: null });
    const root = await workItemsService.listRootIssues(
      t.projectId,
      { sort: { column: 'key', direction: 'asc' } },
      t.ctx,
    );
    expect(root.rows.map((r) => r.id)).toContain(bug.id);
  });
});

describe('seam 5 · a delete carries the destination', () => {
  it('deleting a nested destination folder sends the next bug to its parent, beside the bugs the delete moved', async () => {
    const t = await makeTenant('carry', 'GCRY');
    const bugs = await seededBugsFolderId(t.projectId);
    const triage = await folder(t, 'Triage', bugs);
    await bugDestinationService.setDestination(t.projectId, triage.id, t.ctx);
    const moved = await fileBug(t.projectKey, 'Filed into Triage');
    expect(moved.folderId).toBe(triage.id);

    await foldersService.deleteFolder({ projectId: t.projectId, folderId: triage.id }, t.ctx);
    const next = await fileBug(t.projectKey, 'Filed after the delete');

    expect(await destinationOf(t.projectId)).toBe(bugs);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: moved.id } })).folderId).toBe(
      bugs,
    );
    expect(next.folderId).toBe(bugs);
  });
});

describe('seam 6 · the planner marker', () => {
  it('`@planner-bug-home` FILES into the product destination when its own pointer is unset — never under a story (MOTIR-5822)', async () => {
    const t = await makeTenant('marker', 'GMRK');
    const triage = await folder(t, 'Triage', null);
    await bugDestinationService.setDestination(t.projectId, triage.id, t.ctx);
    await workItemsService.createWorkItem(
      { projectId: t.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      t.ctx,
    );

    const bug = await fileBug(t.projectKey, 'A planning bug', {
      parentKey: PLANNER_BUG_HOME_MARKER,
    });

    expect(bug).toMatchObject({ parentId: null, folderId: triage.id });
    expect(await destinationOf(t.projectId)).toBe(triage.id);
  });
});
