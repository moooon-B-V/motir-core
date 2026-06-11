import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { componentsService } from '@/lib/services/componentsService';
import { mapComponentError } from '@/lib/components/errorResponse';

// GET/POST /api/projects/[key]/components (Story 5.4 · Subtask 5.4.3) — the
// project's component taxonomy. Thin HTTP layer over componentsService; no
// db / no transaction here (CLAUDE.md). `[key]` is the project identifier
// ("PROD"), resolved within the actor's workspace — a cross-tenant key reads
// as 404 (no existence leak), as does a non-browsable project.
//
// GET                                              → 200 { components: ComponentWithCountDto[] }
//   (browse-gated — the admin list AND the rail picker's option source)
// POST { name, description?, defaultAssigneeId? }  → 201 { component: ComponentDto }
//   (project-admin-gated — the 6.4 two-tier check)
//
// Typed errors → status codes (see lib/components/errorResponse.ts).

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;

  try {
    const components = await componentsService.listComponents(key, ctx);
    return NextResponse.json({ components });
  } catch (err) {
    const mapped = mapComponentError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { name, description, defaultAssigneeId } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` must be a string.' },
      { status: 400 },
    );
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`description` must be a string or null.' },
      { status: 400 },
    );
  }
  if (
    defaultAssigneeId !== undefined &&
    defaultAssigneeId !== null &&
    typeof defaultAssigneeId !== 'string'
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`defaultAssigneeId` must be a string or null.' },
      { status: 400 },
    );
  }

  try {
    const component = await componentsService.createComponent(
      { key, name, description, defaultAssigneeId },
      ctx,
    );
    return NextResponse.json({ component }, { status: 201 });
  } catch (err) {
    const mapped = mapComponentError(err);
    if (mapped) return mapped;
    throw err;
  }
}
