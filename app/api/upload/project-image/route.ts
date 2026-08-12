import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { AttachmentError } from '@/lib/blob/errors';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';

// POST /api/upload/project-image (MOTIR-2677) — the thin HTTP layer over
// projectsService.uploadImage, mirroring app/api/upload/avatar. Multipart body
// with a `file` field plus the `projectKey` the logo belongs to. Returns
// { key } — the object KEY, never a URL, so no hosting origin is persisted; the
// caller then PATCHes it as `image` on /api/projects/[key].
//
// The project key rides in the FORM rather than the path, so this route sits
// beside `upload/avatar` and the product keeps ONE upload idiom (`/api/upload/*`
// returns a key; a resource route persists it) instead of two shapes for the
// same two-step. The gate is not weakened by that choice: the service resolves
// the key and calls assertCanManage BEFORE storing a byte.
//
// No `db.*` and no transaction here — the service owns the storage write, and it
// keeps no audit row (a logo's lifecycle is owned by `Project.image`).

export async function POST(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  let file: FormDataEntryValue | null;
  let projectKey: FormDataEntryValue | null;
  try {
    const form = await req.formData();
    file = form.get('file');
    projectKey = form.get('projectKey');
  } catch {
    return NextResponse.json(
      { error: 'Expected multipart form data.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'Expected a `file` field.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  if (typeof projectKey !== 'string' || projectKey.length === 0) {
    return NextResponse.json(
      { error: 'Expected a `projectKey` field.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const result = await projectsService.uploadImage({ key: projectKey, ctx, file });
    return NextResponse.json(result);
  } catch (err) {
    // The access/lookup family (404 no-existence-leak, 403 not-an-admin) shares
    // the same translation the project routes use, so a caller cannot tell the
    // two upload surfaces apart by their error shapes.
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    // The size / MIME family carries its own status (413 / 415).
    if (err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
