import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { triageService } from '@/lib/services/triageService';
import { triageActionErrorResponse } from '@/lib/triage/errorResponse';
import { InvalidTriageCursorError } from '@/lib/triage/triageQueue';

// GET /api/projects/[key]/triage/queue?cursor=&limit= (Subtask 6.11.6) — one
// page of a project's ACTIVE triage queue, addressed by the project IDENTIFIER
// ("PROD"). The inbox's "Load older" pagination binds to this (the page itself
// reads page 1 on the active project). Thin HTTP layer over
// triageService.getTriageQueueByKey. No db / no transaction here (CLAUDE.md).
//
// `[key]` resolves within the actor's workspace — a cross-tenant / non-browsable
// key reads as 404 (no existence leak). An unparseable cursor → 400.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam !== null ? Number(limitParam) : undefined;
  if (limit !== undefined && !Number.isFinite(limit)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`limit` must be a number.' },
      { status: 400 },
    );
  }

  try {
    const page = await triageService.getTriageQueueByKey(key, { cursor, limit }, ctx);
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof InvalidTriageCursorError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    const mapped = triageActionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
