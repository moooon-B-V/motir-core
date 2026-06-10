import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldErrorResponse } from '@/lib/customFields/errorResponse';

// /api/fields/[fieldId]/options (Story 5.3 · Subtask 5.3.2)
//   POST — add an option to a `select` field (project-admin gated; appends
//          to the option order; the 55-cap → 422). Body: { label }.
//
// Thin HTTP transport (CLAUDE.md 4-layer). Per-option mutations live at
// /api/fields/[fieldId]/options/[optionId].

interface RouteParams {
  params: Promise<{ fieldId: string }>;
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
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
  const label =
    body && typeof body === 'object' && 'label' in body && typeof body.label === 'string'
      ? body.label
      : null;
  if (!label) {
    return NextResponse.json(
      { error: '"label" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const option = await customFieldsService.addOption({
      fieldId,
      actorUserId: ctx.userId,
      ctx,
      label,
    });
    return NextResponse.json({ option }, { status: 201 });
  } catch (err) {
    const mapped = customFieldErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
