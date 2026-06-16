import { NextResponse } from 'next/server';
import { projectSquareService } from '@/lib/services/projectSquareService';
import {
  InvalidProjectSquareCursorError,
  InvalidProjectSquareRankError,
  InvalidProjectSquareWindowError,
} from '@/lib/projectSquare/errors';

// The PROJECT SQUARE directory endpoint (Story 6.13 · Subtasks 6.13.2 + 6.13.4)
// — the cross-org list of every `public` project that backs the fully-public
// `/explore` gallery, its ranked tabs (trending / popular / recent), and its
// "load more" pagination. NOT session-gated: a logged-out visitor / crawler
// reads it (the square is anonymous — model revision 2026-06-14), so there is
// deliberately no `getSession()` call. The `accessLevel = 'public'` filter + the
// card projection + the ranking all live in the service / repository, so this
// handler is pure transport. HTTP layer only: parse the `rank` / `window` /
// `cursor` params → one service call → map errors.

export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const cursor = params.get('cursor') ?? undefined;
  const rank = params.get('rank') ?? undefined;
  const window = params.get('window') ?? undefined;
  try {
    const page = await projectSquareService.listDirectory({ cursor, rank, window });
    return NextResponse.json(page);
  } catch (err) {
    if (
      err instanceof InvalidProjectSquareCursorError ||
      err instanceof InvalidProjectSquareRankError ||
      err instanceof InvalidProjectSquareWindowError
    ) {
      return NextResponse.json({ code: err.code }, { status: 400 });
    }
    throw err;
  }
}
