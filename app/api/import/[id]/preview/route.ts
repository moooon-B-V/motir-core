import { NextResponse } from 'next/server';
import { importService } from '@/lib/services/importService';
import { importErrorResponse } from '@/lib/import/httpErrors';
import type { ImportConnectionConfig } from '@/lib/dto/import';
import type { ImportMapping } from '@/lib/import/engine/types';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// POST /api/import/:id/preview (Story 7.16 · MOTIR-941) — the DRY-RUN: classify
// every source issue (CREATE/UPDATE/SKIP) with NO writes, via the SLICE-A engine.
// Body: `{ mapping, connection }`. Thin HTTP over `importService.preview`.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

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
