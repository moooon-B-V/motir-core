import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { AttachmentError } from '@/lib/blob/errors';

// POST /api/upload/issue-attachment (Subtask 2.3.7) — the thin HTTP layer over
// attachmentsService.uploadAttachment. Multipart body with a single `file`
// field. Session-required; the workspace is resolved from the active-project
// context (NEVER the client payload). Typed AttachmentErrors → their own status
// (413/415/429); returns { url, mime, isImage } so the editor chooses `![]` vs
// `[]`. No `db.*` / no transaction here — the service owns both.

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

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
    const result = await attachmentsService.uploadAttachment(file, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
