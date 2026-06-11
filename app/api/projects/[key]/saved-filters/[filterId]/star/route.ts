import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { mapSavedFilterError } from '@/lib/savedFilters/errorResponse';

// /api/projects/[key]/saved-filters/[filterId]/star (Story 6.2 · Subtask
// 6.2.1) — the per-user star toggle (the dropdown's starred-first group, the
// directory's popularity column). Any browser may star a filter they can
// see, viewers included; both directions are idempotent. Built-ins are not
// starrable (403 — no row to FK; a design decision to the contrary is a
// recorded extension).
//
// PUT    → 200 { filter } (starred)
// DELETE → 200 { filter } (unstarred)

type Params = { params: Promise<{ key: string; filterId: string }> };

export async function PUT(_req: Request, { params }: Params): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, filterId } = await params;
  try {
    const filter = await savedFiltersService.star(key, filterId, ctx);
    return NextResponse.json({ filter });
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, filterId } = await params;
  try {
    const filter = await savedFiltersService.unstar(key, filterId, ctx);
    return NextResponse.json({ filter });
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}
