import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { importService } from '@/lib/services/importService';
import { importErrorResponse } from '@/lib/import/httpErrors';
import type { ImportRunProgress } from '@/lib/import/engine/importPersistService';
import type { ImportConnectionConfig } from '@/lib/dto/import';
import type { ImportMapping } from '@/lib/import/engine/types';

// POST /api/import/:id/run (Story 7.16 · MOTIR-941) — execute the import (the
// SLICE-A engine with writes ON) and STREAM progress as newline-delimited JSON
// (one `item` event per issue, then a final `summary`). Thin HTTP over
// `importService.run`. Body: `{ mapping?, connection }` (mapping falls back to
// the one stored at preview).
//
// The generator is PRIMED before the streaming response is constructed, so a
// pre-run failure — unknown id (404), no edit access (403), source not connected
// (422), or an already-running import (409) — is returned as a real status code
// rather than a mid-stream error on a 200.

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

  let gen: AsyncGenerator<ImportRunProgress>;
  let first: IteratorResult<ImportRunProgress>;
  try {
    gen = await importService.run(id, { mapping: body.mapping, connection: body.connection }, ctx);
    // Prime — runs the run-status guard + the first issue, so 4xx lands here.
    first = await gen.next();
  } catch (err) {
    return importErrorResponse(err);
  }

  const encoder = new TextEncoder();
  const line = (p: ImportRunProgress) => encoder.encode(`${JSON.stringify(p)}\n`);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!first.done) controller.enqueue(line(first.value));
        for (;;) {
          const next = await gen.next();
          if (next.done) break;
          controller.enqueue(line(next.value));
        }
      } catch (err) {
        // A failure AFTER streaming began — the status is already 200; surface it
        // as a terminal error event rather than dropping the connection silently.
        controller.enqueue(
          line({
            type: 'item',
            externalId: '(run)',
            plan: 'create',
            workItemKey: null,
            warnings: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
    },
  });
}
