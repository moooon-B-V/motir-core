import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { canvasLayoutService } from '@/lib/services/canvasLayoutService';
import { InvalidCanvasPositionError } from '@/lib/canvasLayout/errors';
import type { CanvasNodePositionInput } from '@/lib/dto/canvasLayout';

// /api/canvas-layout (Subtask 7.3.77 / MOTIR-1237) — the CURRENT user's saved
// node arrangement for the ACTIVE project's planning canvas. HTTP-only (CLAUDE.md
// 4-layer): gate on session + active-project context, parse, call ONE service
// method, map the typed error to a status.
//
// The project comes from `getActiveProject` (server-resolved within the actor's
// own workspace), never the client — so a cross-tenant project is unreachable and
// a null context is simply "no active project" → 404 (the no-existence-leak
// shape). Scope is per-user-per-project: the userId is always the session user.
//
// GET  → 200 { layout: CanvasLayoutDTO } (empty positions → the consumer's
//        auto-layout default)
// PATCH { positions: [{ nodeKey, x, y }] } → 200 { layout } (upsert each, atomic;
//        an invalid coordinate → 422; a malformed body → 400)

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  const layout = await canvasLayoutService.getLayout({
    userId: ctx.userId,
    projectId: ctx.projectId,
  });
  return NextResponse.json({ layout }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function PATCH(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Expected a JSON body.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return badRequest('Expected a JSON object.');
  }
  const { positions } = body as { positions?: unknown };
  if (!Array.isArray(positions)) {
    return badRequest('`positions` must be an array.');
  }

  // Shape-narrow each entry; the SEMANTIC check (bounds) is the service's job and
  // surfaces as a typed 422.
  const inputs: CanvasNodePositionInput[] = [];
  for (const position of positions) {
    if (typeof position !== 'object' || position === null) {
      return badRequest('Each position must be an object.');
    }
    const { nodeKey, x, y } = position as Record<string, unknown>;
    if (typeof nodeKey !== 'string' || typeof x !== 'number' || typeof y !== 'number') {
      return badRequest('Each position needs a string `nodeKey` and numeric `x` / `y`.');
    }
    inputs.push({ nodeKey, x, y });
  }

  try {
    const layout = await canvasLayoutService.savePositions(
      { userId: ctx.userId, projectId: ctx.projectId },
      inputs,
    );
    return NextResponse.json({ layout });
  } catch (err) {
    if (err instanceof InvalidCanvasPositionError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}

function badRequest(error: string): Response {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}
