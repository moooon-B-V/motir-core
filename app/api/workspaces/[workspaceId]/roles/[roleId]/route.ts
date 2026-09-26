import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { workspaceRoleDefinitionService } from '@/lib/services/workspaceRoleDefinitionService';
import { workspaceRoleErrorResponse } from '@/lib/workspaces/roleErrorResponse';

// PATCH  /api/workspaces/:workspaceId/roles/:roleId — rename and/or re-permission.
// DELETE /api/workspaces/:workspaceId/roles/:roleId?reassignToRole=…|reassignToDefinitionId=…
//
// Story MOTIR-6168 · MOTIR-6460. Manager-only (the service asserts it).

interface RouteParams {
  params: Promise<{ workspaceId: string; roleId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId, roleId } = await params;
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
  if (patch.permissions !== undefined && !Array.isArray(patch.permissions)) {
    return NextResponse.json(
      { error: '"permissions" must be an array.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const role = await workspaceRoleDefinitionService.update(
      {
        workspaceId,
        roleId,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
      },
      ctx,
    );
    return NextResponse.json({ role });
  } catch (err) {
    const mapped = workspaceRoleErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId, roleId } = await params;
  const search = new URL(req.url).searchParams;
  const reassignToRole = search.get('reassignToRole');
  const reassignToDefinitionId = search.get('reassignToDefinitionId');

  try {
    await workspaceRoleDefinitionService.delete(
      { workspaceId, roleId, reassignToRole, reassignToDefinitionId },
      ctx,
    );
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = workspaceRoleErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
