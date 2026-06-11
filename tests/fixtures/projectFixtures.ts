import { projectsService } from '@/lib/services/projectsService';
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
