import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST } from '@/app/api/internal/ai/work-items/route';
import { PLANNER_BUG_HOME_MARKER } from '@/lib/ai/plannerBugHome';
import { db } from '@/lib/db';
import { PROJECT_FOLDER_POINTERS } from '@/lib/repositories/projectRepository';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Deleting a folder carries the PLANNER-BUG destination up too — Story MOTIR-5818
// · Subtask MOTIR-5821. `foldersService.deleteFolder` already carried the product
// bug destination (MOTIR-5537, `bugDestinationCarry.test.ts`, untouched); the
// carry now runs over the SET of project folder pointers, `PROJECT_FOLDER_POINTERS`,
// so the planner pointer never dangles and a third pointer joins by declaration.

const SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The meta tenant's shape: a workspace, the `MOTIR` project and the system
 *  principal, so the marker can be filed through the real route. */
async function makeTenant() {
  const owner = await usersService.createUser({
    email: 'planner-carry@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  return { ctx, projectId: project.id };
}

type Tenant = Awaited<ReturnType<typeof makeTenant>>;

async function folder(t: Tenant, name: string, parentFolderId: string | null) {
  return foldersService.createFolder({ projectId: t.projectId, parentFolderId, name }, t.ctx);
}

async function pointPlannerAt(t: Tenant, folderId: string | null) {
  await adminDb.project.update({
    where: { id: t.projectId },
    data: { plannerBugDestinationFolderId: folderId },
  });
}

async function pointers(t: Tenant) {
  const p = await adminDb.project.findUniqueOrThrow({ where: { id: t.projectId } });
  return { product: p.bugDestinationFolderId, planner: p.plannerBugDestinationFolderId };
}

async function filePlannerBug() {
  const res = await POST(
    new Request('http://internal/api/internal/ai/work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        projectKey: 'MOTIR',
        kind: 'bug',
        title: 'A planning bug',
        parentKey: PLANNER_BUG_HOME_MARKER,
      }),
    }),
  );
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

describe('deleteFolder carries the planner-bug destination', () => {
  it('moves it to the PARENT when a nested destination folder is deleted', async () => {
    const t = await makeTenant();
    const bugs = await seededBugsFolderId(t.projectId);
    const planning = await folder(t, 'Planning bugs', bugs);
    await pointPlannerAt(t, planning.id);

    await foldersService.deleteFolder({ projectId: t.projectId, folderId: planning.id }, t.ctx);

    expect(await pointers(t)).toEqual({ product: bugs, planner: bugs });
  });

  it('leaves it NULL when a ROOT destination folder is deleted — and the next planner bug lands at the PRODUCT destination', async () => {
    const t = await makeTenant();
    const bugs = await seededBugsFolderId(t.projectId);
    const planning = await folder(t, 'Planning bugs', null);
    await pointPlannerAt(t, planning.id);

    await foldersService.deleteFolder({ projectId: t.projectId, folderId: planning.id }, t.ctx);

    expect(await pointers(t)).toEqual({ product: bugs, planner: null });
    const bug = await filePlannerBug();
    expect(bug.folderId).toBe(bugs);
    expect(bug.parentId).toBeNull();
  });

  it('carries BOTH pointers in one delete when one folder is both destinations', async () => {
    const t = await makeTenant();
    const bugs = await seededBugsFolderId(t.projectId);
    const triage = await folder(t, 'Triage', bugs);
    await adminDb.project.update({
      where: { id: t.projectId },
      data: { bugDestinationFolderId: triage.id, plannerBugDestinationFolderId: triage.id },
    });

    await foldersService.deleteFolder({ projectId: t.projectId, folderId: triage.id }, t.ctx);

    expect(await pointers(t)).toEqual({ product: bugs, planner: bugs });
    expect(await adminDb.folder.findUnique({ where: { id: triage.id } })).toBeNull();
  });

  it('leaves the planner pointer alone when a folder it does NOT name is deleted', async () => {
    const t = await makeTenant();
    const bugs = await seededBugsFolderId(t.projectId);
    const planning = await folder(t, 'Planning bugs', bugs);
    const later = await folder(t, 'Later', null);
    await pointPlannerAt(t, planning.id);

    await foldersService.deleteFolder({ projectId: t.projectId, folderId: later.id }, t.ctx);

    expect(await pointers(t)).toEqual({ product: bugs, planner: planning.id });
  });

  it('carries through the ID-ADDRESSED door too, which delegates to the same rule', async () => {
    const t = await makeTenant();
    const bugs = await seededBugsFolderId(t.projectId);
    const planning = await folder(t, 'Planning bugs', bugs);
    await pointPlannerAt(t, planning.id);

    await foldersService.deleteFolderById(planning.id, t.ctx);

    expect((await pointers(t)).planner).toBe(bugs);
  });
});

describe('PROJECT_FOLDER_POINTERS is the WHOLE set — read from the database, not from memory', () => {
  it('names every `project` column that is a foreign key to `folder`', async () => {
    // A folder pointer the carry does not know about makes a folder delete fail
    // on its NoAction FK (or dangle, under any other rule). The catalog is the
    // authority on which columns point at `folder`, so compare against it.
    const rows = await adminDb.$queryRaw<Array<{ column_name: string }>>`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_name = 'project'
         AND ccu.table_name = 'folder'
    `;
    const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

    expect(rows.map((r) => r.column_name).sort()).toEqual(
      PROJECT_FOLDER_POINTERS.map(snake).sort(),
    );
  });
});
