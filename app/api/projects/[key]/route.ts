import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';

// PATCH /api/projects/[key] (Story 6.8 · Subtask 6.8.1)
// Edit a project's details, OR change its key. Project-admin gated (the gate is
// in the service). Body shape:
//   { name?, avatarIcon?, avatarColor? }  → updateDetails (name + avatar)
//   { identifier? }                       → changeKey (the guarded key change)
// The presence of `identifier` selects the change-key flow — it is its own
// request in the UI (a consequence modal), distinct from a details Save, so the
// two never mix in one PATCH. `avatarIcon`/`avatarColor` accept `null` to clear
// (back to the mono-identifier rendering); an ABSENT field is left untouched, so
// the route distinguishes "key present with null" from "key absent". Thin HTTP
// transport per CLAUDE.md: parse, one service call, map typed errors.

interface RouteParams {
  params: Promise<{ key: string }>;
}

// Read an optional `string | null` field: undefined when absent, the value when
// present (string or null), or `false` when present but the wrong type (→ 400).
function readNullableString(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined | false {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null || typeof value === 'string') return value;
  return false;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
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
      { error: 'A JSON object body is required.', code: 'BAD_REQUEST' },
      {
        status: 400,
      },
    );
  }
  const obj = body as Record<string, unknown>;

  try {
    // Change-key flow takes precedence when `identifier` is present.
    if ('identifier' in obj) {
      if (typeof obj.identifier !== 'string') {
        return NextResponse.json(
          { error: 'An "identifier" must be a string.', code: 'BAD_REQUEST' },
          { status: 400 },
        );
      }
      const project = await projectsService.changeKey({ key, newKey: obj.identifier, ctx });
      return NextResponse.json({ project });
    }

    // Otherwise, a details edit (name + avatar).
    const name = 'name' in obj ? obj.name : undefined;
    if (name !== undefined && typeof name !== 'string') {
      return NextResponse.json(
        { error: 'A "name" must be a string.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }
    const avatarIcon = readNullableString(obj, 'avatarIcon');
    const avatarColor = readNullableString(obj, 'avatarColor');
    if (avatarIcon === false || avatarColor === false) {
      return NextResponse.json(
        { error: 'An avatar field must be a string or null.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    const project = await projectsService.updateDetails({
      key,
      ctx,
      name,
      avatarIcon,
      avatarColor,
    });
    return NextResponse.json({ project });
  } catch (err) {
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
