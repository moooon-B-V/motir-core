import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Shared plumbing for the throwaway `_test/*` route handlers (Subtask 1.4.8).
//
// ON-DISK PATH IS `%5Ftest`, URL IS `/api/_test/...`. Next.js App Router treats
// a folder literally prefixed with `_` as a PRIVATE folder — its whole subtree
// (route.ts included) is excluded from routing, so `app/api/_test/...` would
// 404 on every request. `%5F` is the URL-encoded underscore: naming the folder
// `%5Ftest` is Next's documented escape hatch — the segment is routable AND the
// public URL is the literal `/api/_test/...` the card specifies. (The card's
// `app/api/_test/route.ts` path predates this App-Router gotcha; logged in
// PRODECT_FINDINGS.)
//
// WHY THESE ROUTES EXIST AT ALL: Story 1.4 ships the durable issue data model
// (work_item / work_item_link / work_item_revision + service + RLS + revision
// audit) but NO production routes — those land in Epic 2. To prove the data
// layer end-to-end over real HTTP *now*, we expose a thin transport over
// workItemsService here, gated so it can never reach production. Stories 1.2.7
// / 1.3.6 ran the same isolation proof against the real routes THOSE stories
// shipped; Story 1.4 has none yet, so 1.4.8 establishes the `app/api/_test/...`
// pattern fresh. Future pre-Epic-2 stories can follow it.
//
// THREE invariants every `_test` handler upholds, in this order:
//   1. NODE_ENV gate (productionGate) — 404 in production builds. The 404 (not
//      403/501) preserves the same no-existence-leak contract the real routes
//      use, so a production probe of `_test/*` is indistinguishable from any
//      other unknown path. This is the durable mechanism that keeps these
//      endpoints out of prod.
//   2. Auth (requireContext) — every handler still requires a session; the
//      NODE_ENV gate is IN ADDITION to auth, not instead of it.
//   3. Service-layer delegation only — handlers parse the request, resolve the
//      workspace context, call ONE service method, and map typed errors to
//      HTTP status. No `db.*`, no `$transaction`, no raw Prisma (CLAUDE.md's
//      4-layer rule; the `_test` route is no exception).
//
// TENANCY NOTE (load-bearing): the dev/CI server connects as the `prodect`
// superuser, which has BYPASSRLS — so the work_item RLS policies (1.4.5) are
// INERT here. Cross-workspace / cross-project isolation in these endpoints is
// therefore enforced at the APPLICATION layer: every read/mutation is gated by
// an explicit `workspaceId` check (workItemsService.getWorkItem / getLink, or
// projectsService.assertProjectInWorkspace) that returns 404 on a tenant miss.
// RLS remains the structural backstop, proven directly in
// tests/work-item-rls.test.ts under the non-bypass prodect_app role.

/**
 * The NODE_ENV gate. Returns a 404 response when running a production build,
 * or `null` to signal "not gated — continue". Read `process.env['NODE_ENV']`
 * dynamically (not destructured) so the gating unit test can flip it at
 * runtime. The 404 body matches the no-existence-leak shape the real routes
 * return for an unknown/cross-tenant id.
 */
export function productionGate(): NextResponse | null {
  if (process.env['NODE_ENV'] === 'production') {
    return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
  }
  return null;
}

/**
 * Resolve the active workspace context as a {@link ServiceContext}, or a 401
 * response when there is no session. `getWorkspaceContext()` returns null only
 * when unauthenticated (a signed-in zero-membership user is self-healed by the
 * resolver), so a null result is exactly the 401 case.
 */
export async function requireContext(): Promise<
  { ctx: ServiceContext; response?: undefined } | { ctx?: undefined; response: NextResponse }
> {
  const wctx = await getWorkspaceContext();
  if (!wctx) {
    return { response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }) };
  }
  return { ctx: { userId: wctx.userId, workspaceId: wctx.workspaceId } };
}

/** Standard 404 body — identical for genuine-missing and cross-tenant misses. */
export function notFound(): NextResponse {
  return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
}
