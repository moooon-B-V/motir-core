import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { paginateKeyset, parsePageRequest } from '@/lib/api/v1/pagination';
import { presentWorkspaceSummary } from '@/lib/api/v1/identity/schema';
import { workspacesService } from '@/lib/services/workspacesService';

// GET /api/v1/workspaces (Story 11.1 · Subtask 11.1.3 — MOTIR-1859) — the
// first paginated v1 collection, and the endpoint that proves the cursor.
//
// Chosen as the proving endpoint because it is a genuinely unbounded collection
// whose access rules the service ALREADY enforces, so this card tests
// PAGINATION rather than resource modelling.
//
// ⚠️ SCOPE OF THE READ — account-level, deliberately.
// `listUserWorkspaces` returns the workspaces the TOKEN OWNER is a member of,
// not only the one the token is bound to. That is a discovery read, and it is
// the one place v1 answers at the account level rather than the bound
// workspace (ADR §2). It discloses exactly what the owner already sees in
// their own workspace switcher and nothing more: no other user's memberships,
// no workspace they do not belong to, and no resource inside any of them —
// every RESOURCE endpoint stays bound-workspace-scoped. Without it a client
// holding a fresh token has no way to learn which workspace ids exist for it.
//
// 4-layer: parse the page params, call ONE service method, shape the envelope,
// return. No `db.*`, no `$transaction`. Rows are `presentWorkspaceSummary`'s
// output — shaped field by field, never spread; that mapper's header records
// why (ADR Amendment 5 §4: a v1 route MAPS THROUGH its schema).
export const GET = withV1Route({ scope: 'read' }, async (ctx) => {
  const page = parsePageRequest(ctx.req);
  const workspaces = await workspacesService.listUserWorkspaces(ctx.userId);

  return NextResponse.json(paginateKeyset(workspaces, page, presentWorkspaceSummary));
});
