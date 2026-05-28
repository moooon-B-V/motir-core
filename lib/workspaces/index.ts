import { cookies, headers } from 'next/headers';
import { auth } from '@/lib/auth';
import type { WorkspaceContext } from './context';
import { WORKSPACE_COOKIE_NAME, resolveWorkspaceFromIds } from './middleware';

// Public re-exports — callers import everything workspace-shaped from
// '@/lib/workspaces' the same way auth callers import from '@/lib/auth'.
export type { WorkspaceContext } from './context';
export { withWorkspaceContext } from './context';
export { resolveWorkspaceContext, WORKSPACE_COOKIE_NAME } from './middleware';

/**
 * Server-side helper for reading the active workspace context from a
 * React Server Component, Route Handler, or Server Action — the
 * workspace analogue of `getSession()` in lib/auth/index.ts.
 *
 * Returns null only when there is no session. A signed-in user with zero
 * workspace memberships is self-healed by the resolver (Subtask 1.2.4):
 * it calls workspacesService.ensureDefaultWorkspace and returns the
 * backfilled workspace rather than stranding the user with null.
 *
 * Pair with withWorkspaceContext to actually run a tenant-scoped query:
 *
 *   const ctx = await getWorkspaceContext();
 *   if (!ctx) redirect('/sign-in');
 *   const projects = await withWorkspaceContext(ctx, (tx) =>
 *     tx.project.findMany(),
 *   );
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const cookieStore = await cookies();
  const cookieWorkspaceId = cookieStore.get(WORKSPACE_COOKIE_NAME)?.value ?? null;

  const userId = session.user.id;
  const workspaceId = await resolveWorkspaceFromIds(userId, cookieWorkspaceId, session.user.name);
  if (!workspaceId) return null;
  return { userId, workspaceId };
}
