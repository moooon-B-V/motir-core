import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import { AttachmentError } from '@/lib/blob/errors';

// POST /api/upload/avatar (Story 8.8 · Subtask 8.8.21) — the thin HTTP layer
// over usersService.uploadAvatar, mirroring app/api/upload/issue-attachment.
// Multipart body with a single `file` field. Session-required; the owner is the
// SESSION user (NOT the active project — an avatar is account-scoped personal
// substrate, so there is no project/workspace context here). Typed
// AttachmentErrors → their own status (413/415); returns { url } for the Profile
// pane's AvatarField (8.8.24), which then PATCHes it as the profile `image`.
// No `db.*` / no transaction here — the service owns the storage write.

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let file: FormDataEntryValue | null;
  try {
    const form = await req.formData();
    file = form.get('file');
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected multipart form data.' },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a `file` field.' },
      { status: 400 },
    );
  }

  try {
    const result = await usersService.uploadAvatar(file, session.user.id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
