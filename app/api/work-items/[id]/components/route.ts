import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { componentsService } from '@/lib/services/componentsService';
import { mapComponentError } from '@/lib/components/errorResponse';

// PUT/POST /api/work-items/[id]/components (Story 5.4 · Subtask 5.4.3) — the
// issue's component set. Thin HTTP layer over componentsService; no db / no
// transaction here (CLAUDE.md). The labels-route twin: edit-gated writes, a
// hidden / cross-workspace issue reads as 404 (finding #44), a read-only
// viewer is 403; same-project validation rejections are 422.
//
// PUT  { componentIds: string[] } → 200 { components: ComponentDto[] } (replace the set)
// POST { componentId: string }    → 200 { components: ComponentDto[] } (single add)

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { componentIds } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(componentIds) || componentIds.some((c) => typeof c !== 'string')) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`componentIds` must be an array of strings.' },
      { status: 400 },
    );
  }

  try {
    const components = await componentsService.setComponents(id, componentIds as string[], ctx);
    return NextResponse.json({ components });
  } catch (err) {
    const mapped = mapComponentError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { componentId } = (body ?? {}) as Record<string, unknown>;
  if (typeof componentId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`componentId` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const components = await componentsService.addComponent(id, componentId, ctx);
    return NextResponse.json({ components });
  } catch (err) {
    const mapped = mapComponentError(err);
    if (mapped) return mapped;
    throw err;
  }
}
