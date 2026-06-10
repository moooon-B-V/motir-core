import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { AttachmentError } from '@/lib/blob/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// GET/POST /api/work-items/[id]/attachments (Story 5.2 · Subtask 5.2.2) — the
// issue's attachment panel. Thin HTTP layer over attachmentsService; no db /
// no transaction here (CLAUDE.md).
//
// GET  ?cursor=<attachmentId>            → one AttachmentsPageDTO window
// POST multipart form, one `file` field  → 201 AttachmentDTO (upload + attach)
//
// Typed errors → status codes (finding #44 — a hidden / cross-workspace id
// reads as 404, never "exists but forbidden"):
//   WorkItemNotFoundError / ProjectNotFoundError → 404
//   AttachmentError                              → its own status: 403 role /
//     404 not-found / 409 editor-sourced / the 2.3.7 upload trio passed
//     through untouched (413 too large / 415 unsupported type / 429 rate)

function mapAttachmentError(err: unknown): NextResponse | null {
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof AttachmentError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
  }
  return null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  const cursor = new URL(req.url).searchParams.get('cursor') ?? undefined;

  try {
    const page = await attachmentsService.listForWorkItem(id, { cursor }, ctx);
    return NextResponse.json(page);
  } catch (err) {
    const mapped = mapAttachmentError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

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
    const attachment = await attachmentsService.attachToWorkItem(id, file, ctx);
    return NextResponse.json(attachment, { status: 201 });
  } catch (err) {
    const mapped = mapAttachmentError(err);
    if (mapped) return mapped;
    throw err;
  }
}
