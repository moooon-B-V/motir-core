import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import type { ProjectDTO } from '@/lib/dto/projects';

// Public re-exports — callers import everything project-context-shaped
// from '@/lib/projects' the same way workspace callers import from
// '@/lib/workspaces' and auth callers from '@/lib/auth'.
export type { ProjectDTO } from '@/lib/dto/projects';

/**
 * The active project context for a server-side render. The shape MIRRORS
 * `WorkspaceContext` from `@/lib/workspaces`: the workspace context returns
 * `{ userId, workspaceId }` (the minimum needed to open a
 * withWorkspaceContext tx), and ProjectContext extends it with a `project`
 * DTO.
 *
 * Why the full DTO and not just `{ projectId }`: every consuming surface
 * we can foresee (the projects switcher in the sidebar, the breadcrumb,
 * the keyboard-shortcut launcher, the work-item composer's
 * "<identifier>-N" preview) needs the project's name + identifier +
 * slug. Returning just the id would force every consumer to do a second
 * round-trip to render it. Returning the DTO keeps the existing
 * `getWorkspaceContext()` shape compatible (callers needing only ids can
 * destructure) AND saves the second round-trip. The 1.3.4 UI is the
 * first consumer and explicitly needs the human-readable identifier for
 * the breadcrumb.
 */
export interface ProjectContext {
  userId: string;
  workspaceId: string;
  projectId: string;
  project: ProjectDTO;
}

/**
 * Server-side helper for reading the active project context from a React
 * Server Component, Route Handler, or Server Action — the project analogue
 * of `getWorkspaceContext()` in `lib/workspaces/index.ts`.
 *
 * Returns null when:
 *   - there is no session (no signed-in user);
 *   - the user has no resolvable workspace (rare; the workspace resolver
 *     already self-heals via ensureDefaultWorkspace);
 *   - the workspace has projects but the user can ENTER none of them — a
 *     Limited member added to no project, or a Full member whose every project
 *     is Members only (Story MOTIR-6169 · MOTIR-6548). A project-scoped page
 *     answers that with `redirect(NO_PROJECT_PATH)`, never `/sign-in`, which
 *     bounces a signed-in reader straight back. (A workspace with NO projects
 *     is healed by `ensureDefaultProject` before this returns.)
 *
 * Pair with withWorkspaceContext to actually run a project-scoped query:
 *
 *   const ctx = await getActiveProject();
 *   if (!ctx) redirect('/projects/new');
 *   const workItems = await withWorkspaceContext(
 *     { userId: ctx.userId, workspaceId: ctx.workspaceId },
 *     (tx) => tx.workItem.findMany({ where: { projectId: ctx.projectId } }),
 *   );
 */
export async function getActiveProject(): Promise<ProjectContext | null> {
  const workspaceCtx = await getWorkspaceContext();
  if (!workspaceCtx) return null;

  const project = await projectsService.getActiveProject(
    workspaceCtx.userId,
    workspaceCtx.workspaceId,
  );
  if (!project) return null;

  return {
    userId: workspaceCtx.userId,
    workspaceId: workspaceCtx.workspaceId,
    projectId: project.id,
    project,
  };
}
