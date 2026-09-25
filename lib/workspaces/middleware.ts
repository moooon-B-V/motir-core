import { readSession } from '@/lib/auth';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from './context';

// Workspace-context resolution. Given a Better-Auth session and an
// optional cookie hint, decide which workspace the request acts within.
// Returns null only when there is no session — a signed-in user with zero
// memberships is SELF-HEALED (Subtask 1.2.4) rather than stranded.
//
// This module is the HTTP/cookie seam only: it reads the session, parses
// the workspace_id cookie, and delegates the resolution + self-heal to
// workspacesService.resolveActiveWorkspace. The membership reads, the
// RLS GUC binding, and the zero-membership backfill all live in the
// service/repository layers per the 4-layer rule (CLAUDE.md). This module
// no longer touches Prisma directly (PRODECT_FINDINGS #5/#7).
//
// Two surfaces share this logic:
//   - resolveWorkspaceContext(request) — for route handlers / Next.js
//     middleware where a Request object is available.
//   - getWorkspaceContext() (lib/workspaces/index.ts) — for server
//     components / actions that read via next/headers.
// Both call resolveActiveWorkspaceId() below, which wraps the service.

export const WORKSPACE_COOKIE_NAME = 'workspace_id';

/**
 * Thin wrapper over workspacesService.resolveActiveWorkspace, kept so the
 * next/headers-based getWorkspaceContext() helper and the Request-based
 * resolveWorkspaceContext() share one call site with a stable name.
 */
async function resolveActiveWorkspaceId(
  userId: string,
  cookieWorkspaceId: string | null,
  userName?: string,
): Promise<string | null> {
  return workspacesService.resolveActiveWorkspace(userId, cookieWorkspaceId, userName);
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
  // Through `readSession`, so a dropped connection on the session read is retried
  // and named rather than escaping as Better-Auth's 500 (MOTIR-5864).
  const session = await readSession(request.headers);
  if (!session) return null;

  const userId = session.user.id;
  const cookieWorkspaceId = parseCookieHeader(request.headers.get('cookie'), WORKSPACE_COOKIE_NAME);

  const workspaceId = await resolveActiveWorkspaceId(userId, cookieWorkspaceId, session.user.name);
  if (!workspaceId) return null;
  return { userId, workspaceId };
}

// Exported for the next/headers-based getWorkspaceContext() helper in
// lib/workspaces/index.ts — same resolution logic, different inputs.
export { resolveActiveWorkspaceId as resolveWorkspaceFromIds };
