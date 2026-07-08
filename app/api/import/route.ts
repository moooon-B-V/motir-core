import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { importService } from '@/lib/services/importService';
import { ImportConnectionConfigError } from '@/lib/import/errors';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { ImportSource } from '@prisma/client';

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
    if (err instanceof ProjectNotFoundError)
      return NextResponse.json({ code: err.code }, { status: 404 });
    if (err instanceof ProjectAccessDeniedError)
      return NextResponse.json({ code: err.code }, { status: 403 });
    if (err instanceof ImportConnectionConfigError)
      return NextResponse.json({ code: err.code }, { status: 422 });
    throw err;
  }
}
