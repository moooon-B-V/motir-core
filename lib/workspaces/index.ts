import { cookies, headers } from 'next/headers';
import { getSession } from '@/lib/auth';
import { contentLanguageFromAcceptLanguage } from '@/lib/i18n/contentLanguage';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
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
 * Returns null when there is no session, and when the active org (the org
 * cookie) is one the user belongs to that has no workspace (MOTIR-8777) — the
 * user is then in that org with no workspace, and project pages send them to
 * `/no-project`, which lands them on the org. Otherwise a signed-in user with
 * zero workspace memberships is self-healed by the resolver (Subtask 1.2.4):
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
  // Through `getSession()`, NOT `auth.api.getSession` directly (MOTIR-2453).
  // This is the `next/headers` context, so the two were already the identical
  // call — but the direct one bypassed the request memoisation, which is why an
  // authed page render validated the session four times instead of two: the
  // `(authed)` layout calls this helper right after its own `getSession()`.
  // The Request-taking sibling in ./middleware.ts (`resolveWorkspaceContext`)
  // legitimately stays direct: it is handed explicit headers and has no render
  // scope to share.
  const session = await getSession();
  if (!session) return null;

  // A staff "View as" session (MOTIR-749) is pinned to its own workspace — the
  // operator's `workspace_id` cookie names THEIR workspace, not the customer's.
  const pinned = session.impersonation?.session.workspaceId ?? null;
  const cookieStore = pinned ? null : await cookies();
  const cookieWorkspaceId = pinned ?? cookieStore?.get(WORKSPACE_COOKIE_NAME)?.value ?? null;
  const cookieOrganizationId = cookieStore?.get(ORGANIZATION_COOKIE_NAME)?.value ?? null;

  const userId = session.user.id;
  // Seeds the content language of a default org the self-heal mints (Story
  // MOTIR-7731 · MOTIR-8093) — `getSession()` already read these headers.
  const acceptLanguage = (await headers()).get('accept-language');
  const workspaceId = await resolveWorkspaceFromIds(
    userId,
    cookieWorkspaceId,
    session.user.name,
    contentLanguageFromAcceptLanguage(acceptLanguage),
    cookieOrganizationId,
  );
  if (!workspaceId) return null;
  return { userId, workspaceId };
}
