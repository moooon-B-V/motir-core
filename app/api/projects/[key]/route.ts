import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// PATCH /api/projects/[key] (Story 6.8 · Subtask 6.8.1)
// Edit a project's details, OR change its key. Project-admin gated (the gate is
// in the service). Body shape:
//   { name?, image? } → updateDetails (the name + the mark)
//   { identifier? }   → changeKey (the guarded key change)
// The presence of `identifier` selects the change-key flow — it is its own
// request in the UI (a consequence modal), distinct from a details Save, so the
// two never mix in one PATCH. `image` accepts `null` to clear it, which leaves
// the project with NO mark at all (`docs/decisions/entity-marks.md` §3); an
// ABSENT field is left untouched, so the route distinguishes "key present with
// null" from "key absent". It carries an object KEY the upload route returned —
// the service gates it to this project's own prefix. Thin HTTP transport per
// CLAUDE.md: parse, one service call, map typed errors.
//
// ⚠️ The retired preset icon/colour pair (MOTIR-2680) is NOT read here any
// more. A body still carrying one is not an error — it is simply an unknown
// key, and this route has never rejected those.

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
  // The 2FA hold (MOTIR-3653) — inserted after this route's own no-context
  // arm rather than folded into `requireCompliantWorkspaceContext`, because
  // that arm carries a body of its own that must not change.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

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

    // Otherwise, a details edit (name + mark).
    const name = 'name' in obj ? obj.name : undefined;
    if (name !== undefined && typeof name !== 'string') {
      return NextResponse.json(
        { error: 'A "name" must be a string.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }
    const image = readNullableString(obj, 'image');
    if (image === false) {
      return NextResponse.json(
        { error: 'An "image" must be a string or null.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    const project = await projectsService.updateDetails({
      key,
      ctx,
      name,
      image,
    });
    return NextResponse.json({ project });
  } catch (err) {
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
