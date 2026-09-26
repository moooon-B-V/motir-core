import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { workspaceRoleDefinitionService } from '@/lib/services/workspaceRoleDefinitionService';
import { workspaceRoleErrorResponse } from '@/lib/workspaces/roleErrorResponse';

// GET  /api/workspaces/:workspaceId/roles — the workspace role catalog (any member).
// POST /api/workspaces/:workspaceId/roles — author a custom role (a Manager).
//
// Story MOTIR-6168 · MOTIR-6460. HTTP only: parse, read the session, call ONE
// service method, map the typed errors (`workspaceRoleErrorResponse`).

interface RouteParams {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { workspaceId } = await params;
  try {
    const catalog = await workspaceRoleDefinitionService.listForWorkspace(workspaceId, ctx);
    return NextResponse.json(catalog);
  } catch (err) {
    const mapped = workspaceRoleErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId } = await params;
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
  const { name, basedOn, permissions } = body as {
    name?: unknown;
    basedOn?: unknown;
    permissions?: unknown;
  };
  if (typeof name !== 'string' || typeof basedOn !== 'string') {
    return NextResponse.json(
      { error: '"name" and "basedOn" must be strings.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  if (permissions !== undefined && !Array.isArray(permissions)) {
    return NextResponse.json(
      { error: '"permissions" must be an array.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const role = await workspaceRoleDefinitionService.create(
      { workspaceId, name, basedOn, ...(permissions !== undefined ? { permissions } : {}) },
      ctx,
    );
    return NextResponse.json({ role }, { status: 201 });
  } catch (err) {
    const mapped = workspaceRoleErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
