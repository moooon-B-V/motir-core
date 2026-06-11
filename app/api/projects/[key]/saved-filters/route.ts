import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { mapSavedFilterError } from '@/lib/savedFilters/errorResponse';
import type { SavedFilterListView } from '@/lib/repositories/savedFilterRepository';

// /api/projects/[key]/saved-filters (Story 6.2 · Subtask 6.2.1) — the
// collection routes. `[key]` is the project identifier ("PROD"), resolved
// within the actor's workspace — a cross-tenant key OR a non-browsable
// project reads as 404 (no existence leak), and every row is filtered by the
// visibility matrix (a private filter never appears in another user's
// reads).
//
// GET  ?view=all|mine|project|starred & q & cursor & limit
//      → 200 SavedFilterPageDto (bounded + server-searched + cursor-paged —
//        finding #57; built-in defaults ride `view=all`, q-filtered)
// POST { name, description?, visibility, filter } — `filter` is the
//      `?filter=v1:` param string the builder holds (one codec, two
//      carriers) → 201 { filter: SavedFilterSummaryDto }

const LIST_VIEWS: ReadonlyArray<SavedFilterListView> = ['all', 'mine', 'project', 'starred'];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  const search = new URL(req.url).searchParams;
  const viewRaw = search.get('view') ?? 'all';
  if (!LIST_VIEWS.includes(viewRaw as SavedFilterListView)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`view` must be one of all, mine, project, starred.' },
      { status: 400 },
    );
  }
  const limitRaw = search.get('limit')?.trim();
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`limit` must be a positive integer.' },
      { status: 400 },
    );
  }

  try {
    const page = await savedFiltersService.list(
      key,
      {
        view: viewRaw as SavedFilterListView,
        q: search.get('q') ?? undefined,
        cursor: search.get('cursor')?.trim() || undefined,
        limit,
      },
      ctx,
    );
    return NextResponse.json(page);
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { name, description, visibility, filter } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string' || typeof filter !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` and `filter` must be strings.' },
      { status: 400 },
    );
  }
  if (visibility !== 'private' && visibility !== 'project') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`visibility` must be `private` or `project`.' },
      { status: 400 },
    );
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`description` must be a string when present.' },
      { status: 400 },
    );
  }

  try {
    const created = await savedFiltersService.create(
      key,
      { name, description: description ?? null, visibility, filterParam: filter },
      ctx,
    );
    return NextResponse.json({ filter: created }, { status: 201 });
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}
