import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { AttachmentError } from '@/lib/blob/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/attachments/[id]/content (Story MOTIR-1665 · Subtask MOTIR-1667) —
// the AUTHENTICATED content read for a PRIVATE attachment. Content blobs (comment
// / description embeds, panel files, acceptance video) live in a private store
// with no public URL; this route authorizes the viewer against the owning work
// item (the shipped item-read authz, reused via attachmentsService) and then
// 302-redirects to a short-lived signed blob URL — so it's usable directly as
// `<img src>` / `<video src>` (browsers follow the 302) without the serverless
// function ever streaming the bytes. A hidden / cross-workspace / missing /
// orphan attachment reads 404 (finding #44 — never "exists but forbidden");
// no session reads 401. Thin HTTP layer (CLAUDE.md § 4-layer): auth → one
// service call → redirect.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const url = await attachmentsService.getContentRedirect(id, ctx);
    return NextResponse.redirect(url, 302);
  } catch (err) {
    // The owning item isn't visible / doesn't exist → 404 (never 403).
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    // AttachmentNotFoundError (missing / cross-workspace / orphan) → its 404.
    if (err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
