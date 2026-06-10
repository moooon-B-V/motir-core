import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { labelsService } from '@/lib/services/labelsService';
import { mapLabelError } from '@/lib/labels/errorResponse';

// GET /api/projects/[key]/labels?q=<prefix> (Story 5.4 · Subtask 5.4.2) —
// the label-picker autocomplete: a case-insensitive prefix match over the
// project's labels, bounded (LABEL_SEARCH_LIMIT — finding #57). An empty /
// absent `q` lists the first window (opening the picker before typing, the
// Jira field's behaviour). `[key]` is the project identifier ("PROD"),
// resolved within the actor's workspace — a cross-tenant key reads as 404
// (no existence leak), as does a non-browsable project.
//
// GET → 200 { labels: LabelDto[] }

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  const q = new URL(req.url).searchParams.get('q') ?? '';

  try {
    const labels = await labelsService.searchLabels(key, q, ctx);
    return NextResponse.json({ labels });
  } catch (err) {
    const mapped = mapLabelError(err);
    if (mapped) return mapped;
    throw err;
  }
}
