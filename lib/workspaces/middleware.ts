import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from './context';

// Workspace-context resolution. Given a Better-Auth session and an
// optional cookie hint, decide which workspace the request acts within.
// Returns null only when there is no session — a signed-in user with zero
// memberships is SELF-HEALED here (Subtask 1.2.4) rather than stranded.
//
// Resolution order:
//   1. session.user.id is present (no session → null).
//   2. If a workspace_id cookie is set AND the user has a membership in
//      that workspace → use it.
//   3. Otherwise fall back to the user's first membership ordered by
//      createdAt asc (the auto-created default from 1.2.4 lands first).
//   4. Zero memberships → call workspacesService.ensureDefaultWorkspace to
//      backfill the default workspace (the best-effort signup hook in
//      lib/auth/index.ts is not atomic with the user insert, so this is
//      the correctness backstop) and use the workspace it returns.
//
// Two surfaces share this logic:
//   - resolveWorkspaceContext(request) — for route handlers / Next.js
//     middleware where a Request object is available.
//   - getWorkspaceContext() (lib/workspaces/index.ts) — for server
//     components / actions that read via next/headers.
// Both delegate to resolveFromUserAndCookie() below.

export const WORKSPACE_COOKIE_NAME = 'workspace_id';

/**
 * Find the workspaceId of the user's first-membership workspace, or
 * verify the cookie-provided workspaceId is one the user belongs to.
 * Opens a transaction with `app.user_id` bound so the read respects RLS
 * even when the connection role is not a superuser.
 *
 * When the user has zero memberships, falls back to
 * workspacesService.ensureDefaultWorkspace (the lazy self-heal) so a
 * freshly-signed-up user is never stranded without a workspace.
 * `userName` seeds the default workspace name; when absent (no session
 * object on hand) we read it off the user row before backfilling.
 */
async function resolveFromUserAndCookie(
  userId: string,
  cookieWorkspaceId: string | null,
  userName?: string,
): Promise<string | null> {
  const existing = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;

    if (cookieWorkspaceId) {
      const membership = await tx.workspaceMembership.findUnique({
        where: { userId_workspaceId: { userId, workspaceId: cookieWorkspaceId } },
      });
      if (membership) return cookieWorkspaceId;
    }

    const first = await tx.workspaceMembership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { workspaceId: true },
    });
    return first?.workspaceId ?? null;
  });

  if (existing) return existing;

  // Zero memberships → self-heal. ensureDefaultWorkspace owns its own
  // transaction (and a FOR UPDATE lock on the user row), so it stays
  // outside the read transaction above. Idempotent + concurrency-safe.
  const name = userName ?? (await db.user.findUnique({ where: { id: userId } }))?.name ?? 'My';
  const { workspace } = await workspacesService.ensureDefaultWorkspace({ userId, userName: name });
  return workspace.id;
}

function parseCookieHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  // Cookie header is `name=value; name=value`. Naive split is fine here —
  // names and ids are URL-safe characters, and we own the cookie name.
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Resolve the active workspace context for an incoming Request. Returns
 * null when there is no session or the user has no memberships.
 */
export async function resolveWorkspaceContext(request: Request): Promise<WorkspaceContext | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;

  const userId = session.user.id;
  const cookieWorkspaceId = parseCookieHeader(request.headers.get('cookie'), WORKSPACE_COOKIE_NAME);

  const workspaceId = await resolveFromUserAndCookie(userId, cookieWorkspaceId, session.user.name);
  if (!workspaceId) return null;
  return { userId, workspaceId };
}

// Exported for the next/headers-based getWorkspaceContext() helper in
// lib/workspaces/index.ts — same resolution logic, different inputs.
export { resolveFromUserAndCookie as resolveWorkspaceFromIds };
