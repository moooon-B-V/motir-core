import { NextResponse } from 'next/server';
import type { SavedFilterSubscriptionSchedule } from '@prisma/client';
import { getWorkspaceContext } from '@/lib/workspaces';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { mapSavedFilterError } from '@/lib/savedFilters/errorResponse';

// /api/projects/[key]/saved-filters/[filterId]/subscription (Story 6.2 ·
// Subtask 6.2.5) — the CURRENT actor's email subscription to one filter.
// Subscribing is a personal read-layer action (the star precedent): anyone who
// can SEE the filter may subscribe; an invisible filter is a 404; a `builtin:`
// id is a 403 (no row to FK). Routes are HTTP-only (CLAUDE.md).
//
// GET    → 200 { subscription: SavedFilterSubscriptionDto | null }
// PUT    { schedule, weekday?, hour } → 200 { subscription } — subscribe or
//          re-schedule (upsert by (filter, user))
// DELETE → 204 — unsubscribe (idempotent)

type Params = { params: Promise<{ key: string; filterId: string }> };

const SCHEDULES: readonly SavedFilterSubscriptionSchedule[] = ['daily', 'weekdays', 'weekly'];

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, filterId } = await params;
  try {
    const subscription = await savedFilterSubscriptionsService.getMine(key, filterId, ctx);
    return NextResponse.json({ subscription });
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function PUT(req: Request, { params }: Params): Promise<Response> {
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
  const { schedule, weekday, hour, ...rest } = (body ?? {}) as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: `Unknown field: ${Object.keys(rest)[0]}.` },
      { status: 400 },
    );
  }
  if (
    typeof schedule !== 'string' ||
    !SCHEDULES.includes(schedule as SavedFilterSubscriptionSchedule)
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`schedule` must be `daily`, `weekdays`, or `weekly`.' },
      { status: 400 },
    );
  }
  if (typeof hour !== 'number') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`hour` must be a number (0–23, UTC).' },
      { status: 400 },
    );
  }
  if (weekday !== undefined && weekday !== null && typeof weekday !== 'number') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`weekday` must be a number (0–6) when present.' },
      { status: 400 },
    );
  }

  try {
    const subscription = await savedFilterSubscriptionsService.subscribe(
      key,
      filterId,
      {
        schedule: schedule as SavedFilterSubscriptionSchedule,
        hour,
        ...(weekday !== undefined ? { weekday: weekday as number | null } : {}),
      },
      ctx,
    );
    return NextResponse.json({ subscription });
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
    await savedFilterSubscriptionsService.unsubscribe(key, filterId, ctx);
    return new Response(null, { status: 204 });
  } catch (err) {
    const mapped = mapSavedFilterError(err);
    if (mapped) return mapped;
    throw err;
  }
}
