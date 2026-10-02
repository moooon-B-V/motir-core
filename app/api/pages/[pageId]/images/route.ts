import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { AttachmentError } from '@/lib/blob/errors';
import { EntitlementExceededError } from '@/lib/billing/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { pageErrorResponse } from '@/lib/pages/routeErrors';

// POST /api/pages/[pageId]/images (Story MOTIR-5752 · MOTIR-7279) — upload one
// image INTO a page: multipart with a single `file` field, filed under the page
// so the orphan sweep never takes it. The thin layer over
// `attachmentsService.uploadPageImage`, mapping errors as
// `app/api/upload/issue-attachment/route.ts` does, plus the page refusals.
// Returns `{ url }` — the `/api/attachments/<id>/content` path the editor embeds.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }
  const { pageId } = await params;

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
    const result = await attachmentsService.uploadPageImage(file, {
      ctx: { userId: ctx.userId, workspaceId: ctx.workspaceId },
      projectId: ctx.projectId,
      pageId,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    if (err instanceof EntitlementExceededError) {
      return NextResponse.json(
        { code: err.code, error: err.message, entitlement: err.entitlement, detail: err.detail },
        { status: 402 },
      );
    }
    const gate = workItemGateErrorResponse(err);
    if (gate) return gate;
    return pageErrorResponse(err);
  }
}
