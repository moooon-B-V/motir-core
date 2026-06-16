import { projectSquareService } from '@/lib/services/projectSquareService';
import { projectTagsService } from '@/lib/services/projectTagsService';
import type { ProjectSquarePageDto } from '@/lib/dto/projectSquare';
import type { ProjectCategoryDto } from '@/lib/dto/projectTags';
import {
  InvalidProjectSquareCategoryError,
  InvalidProjectSquareCursorError,
} from '@/lib/projectSquare/errors';
import type { ExploreQuery } from '@/lib/projectSquare/exploreParams';

// loadSquare — the project-square page's read step (Story 6.13 · Subtask
// 6.13.6). Reads the cursored, ranked, filtered directory page (6.13.2 + 6.13.4
// + 6.13.3) AND the browse-by-topic facet (6.13.5) THROUGH the shipped services —
// 4-layer: no raw Prisma, no view-specific query here. Shared by the main
// `/explore` page and the `/explore/topic/<slug>` landing pages.
//
// Two recoverable read faults are handled so a crawler never 500s on a stale or
// junk URL:
//   • a STALE cursor (minted under a different ordering/filter) → retry the
//     first page (drop the cursor);
//   • an UNKNOWN `?category=` → on the main page, drop the filter and render the
//     full square; on a topic landing page (`strictCategory`), rethrow so the
//     route can `notFound()` (a 404 for a non-existent topic — correct SEO).
// Any OTHER error bubbles to the route's error boundary (the fetch-error state).

export interface SquareData {
  page: ProjectSquarePageDto;
  categories: ProjectCategoryDto[];
  /** The query actually used to read (category cleared if it was unknown). */
  effectiveQuery: ExploreQuery;
}

export async function loadSquare(
  query: ExploreQuery,
  opts: { strictCategory?: boolean } = {},
): Promise<SquareData> {
  const categories = await projectTagsService.listCategories();

  const read = (q: ExploreQuery, withCursor: boolean) =>
    projectSquareService.listDirectory({
      rank: q.rank,
      window: q.window,
      search: q.search,
      category: q.category,
      cursor: withCursor ? q.cursor : undefined,
    });

  let effectiveQuery = query;
  let page: ProjectSquarePageDto;
  try {
    page = await read(query, true);
  } catch (err) {
    if (err instanceof InvalidProjectSquareCursorError) {
      // Stale cursor → restart from the first page of this ordering/filter.
      page = await read(query, false);
    } else if (err instanceof InvalidProjectSquareCategoryError) {
      if (opts.strictCategory) throw err;
      // Unknown filter on the open square → drop it and show the full square.
      effectiveQuery = { ...query, category: undefined, cursor: undefined };
      page = await read(effectiveQuery, false);
    } else {
      throw err;
    }
  }

  return { page, categories, effectiveQuery };
}

/** The display label for a category slug from the facet, falling back to the
 * slug itself (a valid-vocab topic with no public projects isn't in the facet). */
export function categoryLabel(
  categories: ProjectCategoryDto[],
  slug: string | undefined,
): string | undefined {
  if (!slug) return undefined;
  return categories.find((c) => c.slug === slug)?.label ?? slug;
}
