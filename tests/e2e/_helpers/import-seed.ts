// Import E2E seed (Story 7.16 · MOTIR-945 / 7.16.9). Mirrors backlog-seed.ts's
// makeTenant: a sign-in-able owner + workspace + project PINNED active (the
// import wizard resolves the destination project the same active-project way
// /backlog does), PLUS a second workspace member so a CSV `assignee` email
// resolves to a real teammate (≠ the importer) — proving the assignee-email
// match, exactly as the MOTIR-944 seam test does. Seeded entirely through the
// shipped services (the one sanctioned cross-layer reach for E2E setup, as
// backlog-seed.ts / work-item-setup.ts do). No raw inserts.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// Satisfies the credential-strength rule (same shape as backlog-seed's).
export const IMPORT_SEED_PASSWORD = 'import-e2e-pass-9';

export interface ImportSeed {
  email: string;
  password: string;
  ownerId: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  projectIdentifier: string;
  /** A second workspace member — the CSV `assignee` email resolves to THIS
   *  user, so a matched assignee is provably someone OTHER than the importer. */
  memberEmail: string;
  memberId: string;
}

export async function seedImportTenant(email: string): Promise<ImportSeed> {
  const owner = await usersService.createUser({
    email,
    password: IMPORT_SEED_PASSWORD,
    name: 'Import Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Import E2E',
    ownerUserId: owner.id,
  });
  const projectName = 'Import Target';
  const project = await projectsService.createProject({
    name: projectName,
    identifier: 'IMP',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });

  // A second member so a CSV assignee email maps to a real teammate (≠ importer).
  const memberEmail = 'dev.two@import.dev';
  const member = await usersService.createUser({
    email: memberEmail,
    password: IMPORT_SEED_PASSWORD,
    name: 'Dev Two',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

  // Pin the project active for the owner so the active-project-scoped import
  // wizard (and /backlog) resolve it on sign-in (the same pin backlog-seed uses).
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  return {
    email,
    password: IMPORT_SEED_PASSWORD,
    ownerId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectName,
    projectIdentifier: project.identifier,
    memberEmail,
    memberId: member.id,
  };
}
