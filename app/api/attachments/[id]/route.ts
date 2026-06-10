import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { AttachmentError } from '@/lib/blob/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// DELETE /api/attachments/[id] (Story 5.2 · Subtask 5.2.2) — permanently
// remove one attachment from its issue's panel (row + blob; no tombstone).
// Thin HTTP layer over attachmentsService; no db / no transaction here
// (CLAUDE.md).
//
// DELETE → 204
//
// Typed errors → status codes (finding #44 — hidden / cross-workspace /
// unlinked ids read as 404):
//   AttachmentNotFoundError / WorkItemNotFoundError /
//   ProjectNotFoundError                          → 404
//   AttachmentForbiddenError (not uploader/admin) → 403
//   AttachmentEditorSourcedError (embed-sourced)  → 409

function mapAttachmentError(err: unknown): NextResponse | null {
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof AttachmentError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
  }
  return null;
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    await attachmentsService.deleteAttachment(id, ctx);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapAttachmentError(err);
    if (mapped) return mapped;
    throw err;
  }
}
