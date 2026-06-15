import { NextResponse } from 'next/server';
import { projectSquareService } from '@/lib/services/projectSquareService';
import { InvalidProjectSquareCursorError } from '@/lib/projectSquare/errors';

// The PROJECT SQUARE directory endpoint (Story 6.13 · Subtask 6.13.2) — the
// cross-org list of every `public` project that backs the fully-public
// `/explore` gallery + its "load more" pagination. NOT session-gated: a
// logged-out visitor / crawler reads it (the square is anonymous — model
// revision 2026-06-14), so there is deliberately no `getSession()` call. The
// `accessLevel = 'public'` filter + the card projection live in the service /
// repository, so this handler is pure transport. HTTP layer only: parse the
// cursor → one service call → map errors.

export async function GET(req: Request): Promise<NextResponse> {
  const cursor = new URL(req.url).searchParams.get('cursor') ?? undefined;
  try {
    const page = await projectSquareService.listDirectory({ cursor });
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof InvalidProjectSquareCursorError) {
      return NextResponse.json({ code: err.code }, { status: 400 });
    }
    throw err;
  }
}
