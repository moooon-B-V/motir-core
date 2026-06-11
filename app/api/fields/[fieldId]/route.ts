import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldErrorResponse } from '@/lib/customFields/errorResponse';

// /api/fields/[fieldId] (Story 5.3 · Subtask 5.3.2) — project-admin gated.
//   PATCH  — exactly ONE of:
//            { label }       → rename (the machine `key` is immutable)
//            { position }    → reorder (a client-minted fractional key — the
//                              board-settings precedent)
//            { description } → update the description (5.3.6's edit modal;
//                              empty string clears to null)
//   DELETE — HARD-delete the field (team-managed semantics: immediate,
//            permanent; options + stored values cascade). Returns the
//            receipt naming the destroyed value count.
//
// Thin HTTP transport (CLAUDE.md 4-layer). An unknown or cross-workspace
// fieldId is a 404 (no existence leak, finding #44).

interface RouteParams {
  params: Promise<{ fieldId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { fieldId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const label = typeof b.label === 'string' ? b.label : null;
  const position = typeof b.position === 'string' ? b.position : null;
  const description = typeof b.description === 'string' ? b.description : null;
  const provided = [label, position, description].filter((v) => v !== null).length;
  if (provided !== 1) {
    return NextResponse.json(
      {
        error: 'Provide exactly one of "label", "position", or "description".',
        code: 'BAD_REQUEST',
      },
      { status: 400 },
    );
  }

  try {
    const base = { fieldId, actorUserId: ctx.userId, ctx };
    const field =
      label !== null
        ? await customFieldsService.renameField({ ...base, label })
        : position !== null
          ? await customFieldsService.reorderField({ ...base, position })
          : await customFieldsService.updateFieldDescription({ ...base, description });
    return NextResponse.json({ field });
  } catch (err) {
    const mapped = customFieldErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { fieldId } = await params;

  try {
    const deleted = await customFieldsService.deleteField({
      fieldId,
      actorUserId: ctx.userId,
      ctx,
    });
    return NextResponse.json({ deleted });
  } catch (err) {
    const mapped = customFieldErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
