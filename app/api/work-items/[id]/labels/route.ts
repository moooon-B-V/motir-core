import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { labelsService } from '@/lib/services/labelsService';
import { mapLabelError } from '@/lib/labels/errorResponse';

// PUT/POST /api/work-items/[id]/labels (Story 5.4 · Subtask 5.4.2) — the
// issue's label set. Thin HTTP layer over labelsService; no db / no
// transaction here (CLAUDE.md).
//
// PUT  { names: string[] } → 200 { labels: LabelDto[] }  (replace the set)
// POST { name: string }    → 200 { labels: LabelDto[] }  (type-to-create add)
//
// Typed errors → status codes (see lib/labels/errorResponse.ts): a hidden /
// cross-workspace issue reads as 404 (finding #44); a read-only viewer is
// 403; the folksonomy validation rejections are 422.

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { names } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`names` must be an array of strings.' },
      { status: 400 },
    );
  }

  try {
    const labels = await labelsService.setLabels(id, names as string[], ctx);
    return NextResponse.json({ labels });
  } catch (err) {
    const mapped = mapLabelError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { name } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const labels = await labelsService.addLabel(id, name, ctx);
    return NextResponse.json({ labels });
  } catch (err) {
    const mapped = mapLabelError(err);
    if (mapped) return mapped;
    throw err;
  }
}
