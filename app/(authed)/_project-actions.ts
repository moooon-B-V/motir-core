'use server';

import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import type { ProjectDTO } from '@/lib/dto/projects';

// Server Actions for the top-nav project switcher + project surfaces.
// HTTP/transport layer (per CLAUDE.md, Server Actions are the route-layer
// equivalent): read the session, resolve the active workspace from the
// existing cookie-backed context, and call exactly one service method.
// No db.* and no $transaction here — those belong to the service.
//
// Why the active project is NOT cookie-backed (unlike the workspace
// switcher): the active project lives on WorkspaceMembership.activeProjectId,
// so the pointer survives across devices/sessions and reads via the
// projectsService.getActiveProject() resolver. Server-side resolution
// removes the cookie/db sync problem the workspace cookie has to defend
// against in middleware.

interface ResolvedContext {
  userId: string;
  workspaceId: string;
}

async function requireContext(): Promise<ResolvedContext> {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');
  const ctx = await getWorkspaceContext();
  if (!ctx) throw new Error('NO_WORKSPACE');
  return { userId: session.user.id, workspaceId: ctx.workspaceId };
}

/**
 * Persist the active project selection on the caller's membership row.
 * The service's setActiveProject asserts membership AND that the project
 * belongs to the active workspace, so a forged projectId can't pin to a
 * project in a workspace the user can't access.
 */
export async function setActiveProjectAction(projectId: string): Promise<void> {
  const { userId, workspaceId } = await requireContext();
  await projectsService.setActiveProject({ userId, workspaceId, projectId });
}

export interface CreateProjectActionInput {
  name: string;
  identifier?: string;
}

/**
 * Create a new project in the active workspace and pin it as the caller's
 * active project. createProject already asserts membership and derives a
 * workspace-unique identifier; the follow-up setActiveProject is a separate
 * transaction because projectsService.createProject doesn't pin the new
 * project on the membership itself (the membership write would couple two
 * concerns inside the create txn). Returning the DTO lets the client reflect
 * the new project immediately before router.refresh() re-renders the tree.
 */
export async function createProjectAction(input: CreateProjectActionInput): Promise<ProjectDTO> {
  const { userId, workspaceId } = await requireContext();
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error('EMPTY_NAME');

  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: userId,
    name: trimmedName,
    identifier: input.identifier,
  });

  await projectsService.setActiveProject({
    userId,
    workspaceId,
    projectId: project.id,
  });

  return project;
}

/**
 * Archive (soft-delete) a project owned by the active workspace. The
 * service stamps archivedAt and the existing getActiveProject resolver
 * falls back to the first remaining non-archived project — or null when
 * none remain, which the route-level empty-state branch surfaces.
 */
export async function archiveProjectAction(projectId: string): Promise<void> {
  const { userId, workspaceId } = await requireContext();
  await projectsService.archiveProject({
    projectId,
    workspaceId,
    actorUserId: userId,
  });
}
