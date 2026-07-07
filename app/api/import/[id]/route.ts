import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { importService } from '@/lib/services/importService';
import { ImportNotFoundError } from '@/lib/import/errors';

// GET /api/import/:id (Story 7.16 · MOTIR-941) — one import's status + per-outcome
// counts, for the wizard's progress / resume view. Thin HTTP layer over
// `importService.getImport` (tenant-scoped: a cross-workspace id is a 404).

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const dto = await importService.getImport(id, ctx);
    return NextResponse.json(dto);
  } catch (err) {
    if (err instanceof ImportNotFoundError)
      return NextResponse.json({ code: err.code }, { status: 404 });
    throw err;
  }
}
