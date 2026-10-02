import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { PAGE_SAVE_MAX_BYTES } from '@/lib/pages';
import { pagesService } from '@/lib/services/pagesService';
import { pageBodyTooLargeResponse, pageErrorResponse } from '@/lib/pages/routeErrors';

// POST /api/pages/[pageId]/updates (Story MOTIR-5752 · MOTIR-7278) — ONE Yjs
// update as raw bytes (`application/octet-stream`), merged into the page by
// `pagesService.savePageUpdate`. Returns `{ revision }`.
//
// ⚠️ THE 1 MiB CAP IS ENFORCED ON THE STREAM, NOT TRUSTED FROM THE HEADER. A
// declared `Content-Length` over the cap is refused before a byte is read; the
// body is then read with a running count and abandoned the moment it passes the
// cap, so a missing or lying header cannot buffer more than the limit + one
// chunk. The service re-checks the size it is handed, which is the backstop.

type Params = { params: Promise<{ pageId: string }> };

/** The body, or the size it reached when it passed `limit`. */
async function readCapped(
  req: Request,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; size: number }> {
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return { ok: false, size };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function POST(req: Request, { params }: Params): Promise<Response> {
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

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PAGE_SAVE_MAX_BYTES) {
    return pageBodyTooLargeResponse(PAGE_SAVE_MAX_BYTES, declared);
  }
  const body = await readCapped(req, PAGE_SAVE_MAX_BYTES);
  if (!body.ok) return pageBodyTooLargeResponse(PAGE_SAVE_MAX_BYTES, body.size);

  try {
    const result = await pagesService.savePageUpdate(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, update: body.bytes },
    );
    return NextResponse.json(result);
  } catch (err) {
    return pageErrorResponse(err);
  }
}
