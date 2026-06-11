import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { mapSavedFilterError } from '@/lib/savedFilters/errorResponse';

// /api/projects/[key]/saved-filters/[filterId] (Story 6.2 · Subtask 6.2.1) —
// the single-filter routes. `filterId` is a row id OR a `builtin:<slug>` id
// (built-ins resolve through the same read; every write on one is 403).
//
// GET    → 200 ResolvedSavedFilterDto — THE data-source read (decoded +
//          registry-validated AST, typed degraded state, capabilities)
// PATCH  { name? | description? | visibility? | filter? } → 200 — update by
//          owner/admin (`filter` is the `?filter=v1:` param string: the
//          owner's overwrite-Save); OR { ownerId } ALONE → change-owner
//          (admin tier). The two are distinct service gates, so a mixed body
//          is a 400.
// DELETE → 204 — owner/admin; stars (and, from 6.2.5, subscriptions)
//          cascade. The UI warns first via the /dependents read.

type Params = { params: Promise<{ key: string; filterId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, filterId } = await params;
  try {
    const resolved = await savedFiltersService.resolve(key, filterId, ctx);
    return NextResponse.json(resolved);
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, filterId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { name, description, visibility, filter, ownerId, ...rest } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (Object.keys(rest).length > 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: `Unknown field: ${Object.keys(rest)[0]}.` },
      { status: 400 },
    );
  }

  // Change-owner is its own gate (admin tier) — `ownerId` rides alone.
  if (ownerId !== undefined) {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`ownerId` must be a non-empty string.' },
        { status: 400 },
      );
    }
    if (
      name !== undefined ||
      description !== undefined ||
      visibility !== undefined ||
      filter !== undefined
    ) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`ownerId` cannot be combined with other fields.' },
        { status: 400 },
      );
    }
    try {
      const updated = await savedFiltersService.changeOwner(key, filterId, ownerId, ctx);
      return NextResponse.json({ filter: updated });
    } catch (err) {
      const mapped = mapSavedFilterError(err);
      if (mapped) return mapped;
      throw err;
    }
  }

  if (name !== undefined && typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` must be a string when present.' },
      { status: 400 },
    );
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`description` must be a string when present.' },
      { status: 400 },
    );
  }
  if (visibility !== undefined && visibility !== 'private' && visibility !== 'project') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`visibility` must be `private` or `project`.' },
      { status: 400 },
    );
  }
  if (filter !== undefined && typeof filter !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`filter` must be a string when present.' },
      { status: 400 },
    );
  }
  if (
    name === undefined &&
    description === undefined &&
    visibility === undefined &&
    filter === undefined
  ) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Nothing to update.' }, { status: 400 });
  }

  try {
    const updated = await savedFiltersService.update(
      key,
      filterId,
      {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(visibility !== undefined ? { visibility } : {}),
        ...(filter !== undefined ? { filterParam: filter } : {}),
      },
      ctx,
    );
    return NextResponse.json({ filter: updated });
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
    await savedFiltersService.delete(key, filterId, ctx);
    return new Response(null, { status: 204 });
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}
