import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { watchersService } from '@/lib/services/watchersService';
import { mapWatcherError } from '@/lib/watchers/errorResponse';

// DELETE /api/work-items/[id]/watchers/[userId] (Story 5.4 · Subtask 5.4.4)
// — the "Manage watchers" remove: take ANOTHER user off the issue's watcher
// list (your OWN row comes off via DELETE /watch, no admin needed). Project
// admin / workspace owner-admin only; idempotent on a non-watching target.
// Thin HTTP layer; errors map per lib/watchers/errorResponse.ts.
//
// DELETE → 200 { watcherCount: number }

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id, userId } = await params;

  try {
    const result = await watchersService.removeWatcher(id, userId, ctx);
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapWatcherError(err);
    if (mapped) return mapped;
    throw err;
  }
}
