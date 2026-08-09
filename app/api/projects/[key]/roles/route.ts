import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { roleDefinitionErrorResponse } from '@/lib/permissions/errorResponse';

// /api/projects/[key]/roles (Story MOTIR-2257 · Subtask MOTIR-2474)
//   POST — author a custom role. Body: { name, permissions[] }.
//
// ⚠️ NO `basedOn`. The editor lets an author START FROM a built-in, but that
// pick only SEEDS the grid — it is an authoring convenience, not a property of
// the role, so it is never sent and never stored (Yue, 2026-08-09). What arrives
// is the set the author actually composed.
//
// Thin HTTP transport, per the 4-layer rule: read the workspace context, parse
// the body's SHAPE, call the service, map its typed refusal to a status. No
// `db`, no `$transaction`, and — deliberately — no re-checking of a rule the
// service owns. A route that re-validated the permission set, the cap, the name
// or built-in immutability would be a second policy implementation, and two
// copies of a policy drift.
//
// ⚠️ NO GET. The settings screens are SERVER COMPONENTS that read through
// `projectAccessService.getRoleCatalog`; nothing fetches a role list from the
// client. And no `v1` public-API route and no MCP tool: a project's role
// vocabulary is administered exactly the way workflow statuses and custom fields
// are, not exposed on the client-facing item API.

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { key } = await params;

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
  // SHAPE only — that `name` is a string and `permissions` is an array. WHICH
  // values are legal is the service's, and it answers with a typed refusal the
  // map below turns into a 400.
  const { name, permissions } = body as { name?: unknown; permissions?: unknown };
  if (typeof name !== 'string' || !Array.isArray(permissions)) {
    return NextResponse.json(
      { error: '"name" must be a string and "permissions" an array.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const projectId = await projectRoleDefinitionService.resolveProjectIdByKey(key, ctx);
    const role = await projectRoleDefinitionService.create({ projectId, ctx, name, permissions });
    return NextResponse.json({ role }, { status: 201 });
  } catch (err) {
    const mapped = roleDefinitionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
