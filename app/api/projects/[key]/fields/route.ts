import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldErrorResponse } from '@/lib/customFields/errorResponse';

// /api/projects/[key]/fields (Story 5.3 · Subtask 5.3.2)
//   GET  — the project's custom-field definitions (position order, each with
//          its option set + issue-value count). Browse-gated: any member who
//          can see the project — read-only viewers included — can read them.
//   POST — create a definition (project-admin gated). Body:
//          { label, fieldType, description?, options? } — `options` is the
//          initial option-label list for `select` fields.
//
// Thin HTTP transport (CLAUDE.md 4-layer): read the workspace context, parse,
// call ONE service method, map typed domain errors via the shared
// customFieldErrorResponse. The `[key]` is the project's identifier ("PROD");
// a cross-tenant key is a 404 (no existence leak, finding #26).

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { key } = await params;

  try {
    const fields = await customFieldsService.listFields({ key, actorUserId: ctx.userId, ctx });
    return NextResponse.json({ fields });
  } catch (err) {
    const mapped = customFieldErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
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
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const label = typeof b.label === 'string' ? b.label : null;
  const fieldType = typeof b.fieldType === 'string' ? b.fieldType : null;
  const description = typeof b.description === 'string' ? b.description : null;
  const options =
    Array.isArray(b.options) && b.options.every((o): o is string => typeof o === 'string')
      ? b.options
      : undefined;
  if (!label || !fieldType || (b.options !== undefined && options === undefined)) {
    return NextResponse.json(
      {
        error: 'Both "label" and "fieldType" are required; "options" must be a string array.',
        code: 'BAD_REQUEST',
      },
      { status: 400 },
    );
  }

  try {
    const field = await customFieldsService.createField({
      key,
      actorUserId: ctx.userId,
      ctx,
      label,
      fieldType,
      description,
      options,
    });
    return NextResponse.json({ field }, { status: 201 });
  } catch (err) {
    const mapped = customFieldErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
