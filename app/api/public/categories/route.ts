import { NextResponse } from 'next/server';
import { projectTagsService } from '@/lib/services/projectTagsService';

// GET /api/public/categories (Story 6.13 · Subtask 6.13.5) — the PROJECT SQUARE
// browse-by-topic facet: every category with at least one PUBLIC project, with
// its public-project count, sorted by count desc (the GitLab "topics sorted by
// number of associated projects" view). Backs the 6.13.3 category filter + the
// categories-browse panel.
//
// NOT session-gated: like the /explore directory (6.13.2), the square is fully
// public (a logged-out visitor / crawler reads it), so there is deliberately no
// `getSession()` call. The `accessLevel = 'public'` filter lives in the service /
// repository aggregate, so this handler is pure transport: one service call.

export async function GET(): Promise<NextResponse> {
  const categories = await projectTagsService.listCategories();
  return NextResponse.json({ categories });
}
