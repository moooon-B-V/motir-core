import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { labelsService } from '@/lib/services/labelsService';
import { mapLabelError } from '@/lib/labels/errorResponse';

// DELETE /api/work-items/[id]/labels/[labelId] (Story 5.4 · Subtask 5.4.2) —
// detach one label chip from the issue. The service runs the
// delete-on-last-use rule (the label row dies with its last use); removing a
// label the issue doesn't carry is an idempotent no-op. Thin HTTP layer;
// errors map per lib/labels/errorResponse.ts.
//
// DELETE → 200 { labels: LabelDto[] } (the resulting set)

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; labelId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id, labelId } = await params;

  try {
    const labels = await labelsService.removeLabel(id, labelId, ctx);
    return NextResponse.json({ labels });
  } catch (err) {
    const mapped = mapLabelError(err);
    if (mapped) return mapped;
    throw err;
  }
}
