import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { componentsService } from '@/lib/services/componentsService';
import { mapComponentError } from '@/lib/components/errorResponse';

// PATCH/DELETE /api/components/[id] (Story 5.4 · Subtask 5.4.3) — edit /
// delete one component, both project-admin-gated (the 6.4 two-tier check).
// Thin HTTP layer over componentsService (CLAUDE.md); the `/api/fields/[id]`
// resource shape. A cross-workspace id reads as 404 (finding #44).
//
// PATCH  { name?, description?, defaultAssigneeId? } → 200 { component: ComponentDto }
// DELETE { moveToComponentId? }                      → 200 { receipt: DeleteComponentReceiptDto }
//   — the verified move-or-remove flow: with a target, every carrying issue
//   is repointed to it (duplicates skipped); without, the association is
//   removed. Issues untouched either way; the receipt reports the count.
//   The body is optional (an unused component needs no choice).

export async function PATCH(
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

  const { name, description, defaultAssigneeId } = (body ?? {}) as Record<string, unknown>;
  if (name !== undefined && typeof name !== 'string') {
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
    const component = await componentsService.updateComponent(
      id,
      { name, description, defaultAssigneeId },
      ctx,
    );
    return NextResponse.json({ component });
  } catch (err) {
    const mapped = mapComponentError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  // The move-or-remove choice rides an OPTIONAL JSON body — a bare DELETE
  // (no body / empty body) is the remove branch.
  let moveToComponentId: string | null = null;
  const raw = await req.text();
  if (raw.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
        { status: 400 },
      );
    }
    const candidate = ((body ?? {}) as Record<string, unknown>).moveToComponentId;
    if (candidate !== undefined && candidate !== null && typeof candidate !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`moveToComponentId` must be a string or null.' },
        { status: 400 },
      );
    }
    moveToComponentId = (candidate as string | null | undefined) ?? null;
  }

  try {
    const receipt = await componentsService.deleteComponent(id, { moveToComponentId }, ctx);
    return NextResponse.json({ receipt });
  } catch (err) {
    const mapped = mapComponentError(err);
    if (mapped) return mapped;
    throw err;
  }
}
