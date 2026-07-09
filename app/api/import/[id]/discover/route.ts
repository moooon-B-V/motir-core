import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { importService } from '@/lib/services/importService';
import { importErrorResponse } from '@/lib/import/httpErrors';
import type { ImportConnectionConfig } from '@/lib/dto/import';

// POST /api/import/:id/discover (Story 7.16 · MOTIR-942) — the wizard's
// CONNECT-step probe: build the connector from `{ connection }` and return the
// reachability/issue-count probe + the source field vocabulary the mapping step
// maps from. Read-only (no writes). Thin HTTP over `importService.discoverFields`
// (the 4-layer rule: one service call, no Prisma here). A pre-flight failure —
// unknown id (404), no edit access (403), source not connected (422) — comes back
// as a real status code via `importErrorResponse`, exactly as preview/run do.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  let body: { connection?: ImportConnectionConfig };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  if (!body.connection || typeof body.connection !== 'object') {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }

  try {
    const result = await importService.discoverFields(id, { connection: body.connection }, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return importErrorResponse(err);
  }
}
