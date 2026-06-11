import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { componentsService } from '@/lib/services/componentsService';
import { mapComponentError } from '@/lib/components/errorResponse';

// DELETE /api/work-items/[id]/components/[componentId] (Story 5.4 · Subtask
// 5.4.3) — detach one component chip from the issue. Removing a component
// the issue doesn't carry is an idempotent no-op (the labels-route twin).
// Thin HTTP layer; errors map per lib/components/errorResponse.ts.
//
// DELETE → 200 { components: ComponentDto[] } (the resulting set)

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; componentId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id, componentId } = await params;

  try {
    const components = await componentsService.removeComponent(id, componentId, ctx);
    return NextResponse.json({ components });
  } catch (err) {
    const mapped = mapComponentError(err);
    if (mapped) return mapped;
    throw err;
  }
}
