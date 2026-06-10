import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldErrorResponse } from '@/lib/customFields/errorResponse';

// /api/fields/[fieldId]/options/[optionId] (Story 5.3 · Subtask 5.3.2) —
// project-admin gated.
//   PATCH  — exactly ONE of:
//            { label }    → rename
//            { position } → reorder (client-minted fractional key)
//            { archived } → archive (true) / un-archive (false): the
//                           verified mirror split — archive any time,
//                           hidden from new selection, existing values
//                           keep rendering
//   DELETE — delete the option, ONLY when unused (in-use → 409, archive
//            offered; the value FK's RESTRICT backstops at the DB layer).
//
// Thin HTTP transport (CLAUDE.md 4-layer). Unknown / cross-workspace ids
// are 404s (no existence leak, finding #44). The option is resolved by its
// own id; the [fieldId] segment is the resource path's parent (the service
// resolves the parent through the option row itself).

interface RouteParams {
  params: Promise<{ fieldId: string; optionId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { optionId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const label = typeof b.label === 'string' ? b.label : null;
  const position = typeof b.position === 'string' ? b.position : null;
  const archived = typeof b.archived === 'boolean' ? b.archived : null;
  const provided = [label, position, archived].filter((v) => v !== null).length;
  if (provided !== 1) {
    return NextResponse.json(
      { error: 'Provide exactly one of "label", "position", or "archived".', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const base = { optionId, actorUserId: ctx.userId, ctx };
    const option =
      label !== null
        ? await customFieldsService.renameOption({ ...base, label })
        : position !== null
          ? await customFieldsService.reorderOption({ ...base, position })
          : archived
            ? await customFieldsService.archiveOption(base)
            : await customFieldsService.unarchiveOption(base);
    return NextResponse.json({ option });
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
  const { optionId } = await params;

  try {
    const option = await customFieldsService.deleteOption({
      optionId,
      actorUserId: ctx.userId,
      ctx,
    });
    return NextResponse.json({ option });
  } catch (err) {
    const mapped = customFieldErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
