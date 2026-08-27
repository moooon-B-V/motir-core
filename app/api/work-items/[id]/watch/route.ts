import { NextResponse } from 'next/server';
import { watchersService } from '@/lib/services/watchersService';
import { mapWatcherError } from '@/lib/watchers/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// PUT/DELETE /api/work-items/[id]/watch (Story 5.4 · Subtask 5.4.4) — the
// SELF half of watching: the header eye control (and its `W` shortcut)
// toggling the caller's own watch. Needs only view access — a read-only
// `viewer` may watch (watching is not editing, the verified split). Thin
// HTTP layer over watchersService; no db / no transaction here (CLAUDE.md).
//
// PUT    → 200 WatchStateDto  (watch — idempotent re-watch is a no-op)
// DELETE → 200 WatchStateDto  (unwatch — idempotent when not watching)
//
// Typed errors → status codes (see lib/watchers/errorResponse.ts): a hidden /
// cross-workspace issue reads as 404 (finding #44).

export async function PUT(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;

  try {
    const state = await watchersService.watch(id, ctx);
    return NextResponse.json(state);
  } catch (err) {
    const mapped = mapWatcherError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;

  try {
    const state = await watchersService.unwatch(id, ctx);
    return NextResponse.json(state);
  } catch (err) {
    const mapped = mapWatcherError(err);
    if (mapped) return mapped;
    throw err;
  }
}
