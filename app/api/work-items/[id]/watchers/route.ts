import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { watchersService } from '@/lib/services/watchersService';
import { mapWatcherError } from '@/lib/watchers/errorResponse';

// GET/POST /api/work-items/[id]/watchers (Story 5.4 · Subtask 5.4.4) — the
// watchers LIST (the popover's paged roster) and the "Manage watchers" add.
// Thin HTTP layer over watchersService; no db / no transaction here
// (CLAUDE.md).
//
// GET  ?cursor=<id>    → 200 WatchersPageDto  (view-gated, paged — never a
//                        load-all, finding #57; `canManage` rides along for
//                        the popover's admin affordances)
// POST { userId }      → 200 { watcher: WatcherDto, watcherCount: number }
//                        (project admin / workspace owner-admin only; the
//                        target must be a member who can VIEW the issue —
//                        422 with the typed reason, never the Jira silent
//                        drop)
//
// Typed errors → status codes (see lib/watchers/errorResponse.ts): hidden /
// cross-workspace issue → 404; manage without the tier → 403; target without
// view access → 422.

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  const cursor = new URL(req.url).searchParams.get('cursor') ?? undefined;

  try {
    const page = await watchersService.listWatchers(id, { cursor }, ctx);
    return NextResponse.json(page);
  } catch (err) {
    const mapped = mapWatcherError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { userId } = (body ?? {}) as Record<string, unknown>;
  if (typeof userId !== 'string' || userId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`userId` must be a non-empty string.' },
      { status: 400 },
    );
  }

  try {
    const result = await watchersService.addWatcher(id, userId, ctx);
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapWatcherError(err);
    if (mapped) return mapped;
    throw err;
  }
}
