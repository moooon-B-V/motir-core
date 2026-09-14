import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from '../helpers/adminDb';
import type { ProjectDTO } from '@/lib/dto/projects';

// Shared test fixtures — project rows (Subtask 1.4.7).
//
// Extracted from the inlined `makeFixture` helpers. `createTestProject` builds
// a real project via the service (which asserts the actor's workspace
// membership, derives/normalises the identifier, and de-dupes the slug). The
// default identifier 'PROD' makes work-item identifiers read as PROD-1,
// PROD-2, … which several existing assertions depend on; pass `identifier`
// when a test needs two distinct projects in one workspace.
//
// Note the service returns a ProjectDTO ({ id, name, slug, identifier }) — it
// does NOT carry workspaceId. The bundled fixture (makeWorkItemFixture) keeps
// the workspaceId alongside it for the work-item create dance.

export interface CreateTestProjectOptions {
  workspaceId: string;
  actorUserId: string;
  /** Override the project name (default 'Motir'). */
  name?: string;
  /** Override the project identifier prefix (default 'PROD'). */
  identifier?: string;
}

/**
 * Create a real project in `workspaceId`, acting as `actorUserId` (who must
 * be a workspace member — the service asserts it).
 */
export async function createTestProject(opts: CreateTestProjectOptions): Promise<ProjectDTO> {
  return projectsService.createProject({
    workspaceId: opts.workspaceId,
    actorUserId: opts.actorUserId,
    name: opts.name ?? 'Motir',
    identifier: opts.identifier ?? 'PROD',
  });
}

/**
 * The id of the Bugs folder every project is created with — its bug destination
 * at birth (Story MOTIR-4927 · MOTIR-4935). A test that reads a project's
 * folders sees this one too; name it through here, never by its label.
 */
export async function seededBugsFolderId(projectId: string): Promise<string> {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.bugDestinationFolderId === null) {
    throw new Error(`project ${projectId} has no bug destination folder`);
  }
  return project.bugDestinationFolderId;
}

/** Every project's seeded Bugs folder, for a test that reads folders across projects. */
export async function seededBugsFolderIds(): Promise<Set<string>> {
  const projects = await adminDb.project.findMany({ select: { bugDestinationFolderId: true } });
  return new Set(
    projects.flatMap((p) => (p.bugDestinationFolderId ? [p.bugDestinationFolderId] : [])),
  );
}

/**
 * Put a project back to NO folders: clear its bug destination, then delete the
 * seeded Bugs folder (MOTIR-4935). For a spec that drives the folder doors over a
 * folder set it fully controls, or that needs a project with no folders at all.
 * The seed itself is asserted in `tests/projects/bugsFolderSeed.test.ts`.
 */
export async function removeSeededBugsFolder(projectId: string): Promise<void> {
  const folderId = await seededBugsFolderId(projectId);
  await adminDb.project.update({
    where: { id: projectId },
    data: { bugDestinationFolderId: null },
  });
  await adminDb.folder.delete({ where: { id: folderId } });
}
