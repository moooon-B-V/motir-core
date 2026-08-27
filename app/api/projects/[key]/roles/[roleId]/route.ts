import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { roleDefinitionErrorResponse } from '@/lib/permissions/errorResponse';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// /api/projects/[key]/roles/[roleId] (Story MOTIR-2257 · Subtask MOTIR-2474)
//   PATCH  — a partial { name?, permissions? }, so the editor's rename AND
//            re-permission are ONE round trip when it saves both.
//   DELETE — with an optional ?reassignTo=. Called WITHOUT it, a role people
//            hold is refused 409 WITH THE COUNT — which is exactly how the
//            dialog learns what to say before it asks; called WITH it, the move
//            and the delete happen together.
//
// Thin HTTP transport (the 4-layer rule): parse, delegate, map. Every rule —
// the permission set, the cap, name uniqueness, built-in immutability, the
// reassign transaction — belongs to `projectRoleDefinitionService`.
//
// ⚠️ `reassignTo` RIDES THE QUERY STRING, not a DELETE body. Request bodies on
// DELETE are permitted but poorly supported across intermediaries and clients,
// and the shipped custom-field / workflow deletes take their parameters the same
// way. The value is a role id or one of `admin` / `member` / `viewer`.

interface RouteParams {
  params: Promise<{ key: string; roleId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  // The 2FA hold (MOTIR-3653) — inserted after this route's own no-context
  // arm rather than folded into `requireCompliantWorkspaceContext`, because
  // that arm carries a body of its own that must not change.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { key, roleId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: 'A JSON object is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  const patch = body as { name?: unknown; permissions?: unknown };
  if (patch.name === undefined && patch.permissions === undefined) {
    return NextResponse.json(
      { error: 'Provide "name", "permissions", or both.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  // Shape only; legality is the service's.
  if (patch.name !== undefined && typeof patch.name !== 'string') {
    return NextResponse.json(
      { error: '"name" must be a string.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  if (patch.permissions !== undefined && !Array.isArray(patch.permissions)) {
    return NextResponse.json(
      { error: '"permissions" must be an array.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const projectId = await projectRoleDefinitionService.resolveProjectIdByKey(key, ctx);
    const role = await projectRoleDefinitionService.update({
      projectId,
      roleId,
      ctx,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
    });
    return NextResponse.json({ role });
  } catch (err) {
    const mapped = roleDefinitionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  // The 2FA hold (MOTIR-3653) — inserted after this route's own no-context
  // arm rather than folded into `requireCompliantWorkspaceContext`, because
  // that arm carries a body of its own that must not change.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { key, roleId } = await params;
  const reassignTo = new URL(req.url).searchParams.get('reassignTo');

  try {
    const projectId = await projectRoleDefinitionService.resolveProjectIdByKey(key, ctx);
    await projectRoleDefinitionService.delete({
      projectId,
      roleId,
      ctx,
      ...(reassignTo ? { reassignTo } : {}),
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = roleDefinitionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
