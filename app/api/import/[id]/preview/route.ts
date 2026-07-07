import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { importService } from '@/lib/services/importService';
import { importErrorResponse } from '@/lib/import/httpErrors';
import type { ImportConnectionConfig } from '@/lib/dto/import';
import type { ImportMapping } from '@/lib/import/engine/types';

// POST /api/import/:id/preview (Story 7.16 · MOTIR-941) — the DRY-RUN: classify
// every source issue (CREATE/UPDATE/SKIP) with NO writes, via the SLICE-A engine.
// Body: `{ mapping, connection }`. Thin HTTP over `importService.preview`.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  let body: { mapping?: ImportMapping; connection?: ImportConnectionConfig };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  if (!body.connection || typeof body.connection !== 'object') {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }

  try {
    const result = await importService.preview(
      id,
      { mapping: body.mapping ?? {}, connection: body.connection },
      ctx,
    );
    return NextResponse.json(result);
  } catch (err) {
    return importErrorResponse(err);
  }
}
