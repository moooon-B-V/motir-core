import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { adminDb } from '../../helpers/adminDb';

// The seed for `planner-bug-destination.spec.ts` (Story MOTIR-5818 · MOTIR-5828).
//
// ⚠️ EVERY DIRECT STATEMENT HERE IS ON `adminDb`, NEVER ON `@/lib/db`. Under the
// non-bypass `motir_app` role a seeding write through the singleton is REFUSED
// and a seeding read returns `[]` — neither raises — so the spec would drive a
// browser against a database it believes it populated. `tests/rls/
// test-singleton-statement-guard.test.ts` ratchets that population down, and a
// new spec seeding through the singleton raises it; the remedy it names is a
// helper exactly like this one.
//
// ⚠️ AND THE POINTER IS WRITTEN DIRECTLY BECAUSE NOTHING IN THE PRODUCT WRITES
// IT. The meta tenant's own planner-bug destination is set by the data migration
// (MOTIR-5824); the story ships no settings control, so there is no route or
// service call to drive here (the re-plan of 2026-09-19 — MOTIR-5832).

export const PLANNER_BUG_SEED_EMAIL = 'e2e-planner-bug-destination@example.com';
export const PLANNER_BUG_SEED_PASSWORD = 'planner-bug-destination-e2e-pass-123';

export interface PlannerBugSeed {
  projectId: string;
  projectKey: string;
  /** The project's seeded Bugs folder — the PRODUCT destination, and rung 2. */
  bugsFolderId: string;
  /** `Bugs ▸ Planning bugs`, the planner-bug destination this seed points at. */
  planningFolderId: string;
}

/** A workspace, a project born with its Bugs folder, the system principal the
 *  filer acts as, and a `Planning bugs` folder the project points at — the shape
 *  the data migration adopts on the meta tenant. */
export async function seedPlannerBugDestination(): Promise<PlannerBugSeed> {
  const owner = await usersService.createUser({
    email: PLANNER_BUG_SEED_EMAIL,
    password: PLANNER_BUG_SEED_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Planner bugs',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Motir',
    identifier: 'PBUG',
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });

  const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
  const bugsFolderId = row.bugDestinationFolderId;
  if (bugsFolderId === null) throw new Error('the project was created with no Bugs folder');

  const planning = await foldersService.createFolder(
    { projectId: project.id, parentFolderId: bugsFolderId, name: 'Planning bugs' },
    { userId: owner.id, workspaceId: workspace.id },
  );
  await adminDb.project.update({
    where: { id: project.id },
    data: { plannerBugDestinationFolderId: planning.id },
  });

  return {
    projectId: project.id,
    projectKey: project.identifier,
    bugsFolderId,
    planningFolderId: planning.id,
  };
}

/** Re-point (or unset) the PLANNER-bug destination, as the migration would. */
export async function setPlannerBugDestination(
  projectId: string,
  folderId: string | null,
): Promise<void> {
  await adminDb.project.update({
    where: { id: projectId },
    data: { plannerBugDestinationFolderId: folderId },
  });
}

/** Re-point (or unset) the PRODUCT bug destination — rung 2 of the ladder. */
export async function setProductBugDestination(
  projectId: string,
  folderId: string | null,
): Promise<void> {
  await adminDb.project.update({
    where: { id: projectId },
    data: { bugDestinationFolderId: folderId },
  });
}

/** Where a filed record actually SITS, read back from the row the filer wrote. */
export async function placementOf(id: string): Promise<{
  folderId: string | null;
  parentId: string | null;
}> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return { folderId: row.folderId, parentId: row.parentId };
}
