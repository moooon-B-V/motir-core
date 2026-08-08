import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { importService } from '@/lib/services/importService';
import { importErrorResponse } from '@/lib/import/httpErrors';
import type { ImportSource } from '@/generated/prisma/client';

// POST /api/import (Story 7.16 · MOTIR-941) — create a DRAFT import for a
// project. Thin HTTP layer over `importService.createDraft` (the 4-layer rule:
// one service call, no Prisma here). Body: `{ projectId, source, sourceRef? }`.

const SOURCES: ReadonlySet<string> = new Set(['jira', 'linear', 'github', 'plane', 'csv']);

export async function POST(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let body: { projectId?: unknown; source?: unknown; sourceRef?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  if (
    typeof body.projectId !== 'string' ||
    typeof body.source !== 'string' ||
    !SOURCES.has(body.source)
  ) {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  const sourceRef = typeof body.sourceRef === 'string' ? body.sourceRef : null;

  try {
    const dto = await importService.createDraft(
      { projectId: body.projectId, source: body.source as ImportSource, sourceRef },
      ctx,
    );
    return NextResponse.json(dto, { status: 201 });
  } catch (err) {
    // MOTIR-2353 — share the `[id]` routes' mapper rather than keeping a second,
    // shorter list here. The hand-rolled one this replaced knew
    // `ProjectNotFoundError` / `ProjectAccessDeniedError` / the config error but
    // NOT `PermissionDeniedError`, so once `createDraft` grew the `import:run`
    // gate a project member's refusal fell through to a 500 instead of a 403.
    return importErrorResponse(err);
  }
}
