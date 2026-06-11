import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { mapSavedFilterError } from '@/lib/savedFilters/errorResponse';

// /api/projects/[key]/saved-filters/[filterId]/dependents (Story 6.2 ·
// Subtask 6.2.1) — the delete-impact enumeration behind the Cloud-style
// warning dialog ("N subscriptions will be removed"). Subscriptions land in
// 6.2.5; Story 6.3 widget usages join in by FK later — both additive to the
// DTO, so the 6.2.2-designed dialog wires against this read today.
//
// GET → 200 SavedFilterDependentsDto

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string; filterId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, filterId } = await params;
  try {
    const dependents = await savedFiltersService.getDependents(key, filterId, ctx);
    return NextResponse.json(dependents);
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}
