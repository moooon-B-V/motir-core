import 'server-only';

import type { IdeaCategory, IdeaKind } from '@/generated/prisma/client';
import type { PublicIdeaDto, PublicIdeaListDto, PublicIdeaTagDto } from '@/lib/dto/ideas';
import {
  IDEA_CATEGORIES,
  IDEA_CATEGORY_LABELS,
  isIdeaCategory,
  isIdeaKind,
} from '@/lib/ideas/categories';
import {
  IdeaListCapExceededError,
  IdeaNotFoundError,
  InvalidIdeaFilterError,
} from '@/lib/ideas/errors';
import type { PublicIdeaFilters } from '@/lib/ideas/types';
import { toPublicIdeaDto } from '@/lib/mappers/ideaMappers';
import {
  ideaPublicRepository,
  type PublicIdeaQuery,
} from '@/lib/repositories/ideaPublicRepository';

/**
 * The idea store's PUBLIC read service (Story MOTIR-7662 · MOTIR-7672) — what
 * `/api/public/ideas` serves anonymously and motir.co renders.
 *
 * UNPAGINATED BY DESIGN. The store is curated — 15 today, growing by 5–10 a
 * research run, with retirements — so a full read stays in the low hundreds,
 * and a page that renders categories as sections needs the whole filtered set.
 * The read is capped at `PUBLIC_IDEA_LIST_CAP` and the service THROWS when the
 * cap is reached, so the day pagination is owed it announces itself instead of
 * truncating silently.
 */
export const PUBLIC_IDEA_LIST_CAP = 500;

/** The longest free-text query honoured; longer input is cut, not refused. */
export const PUBLIC_IDEA_QUERY_MAX = 200;

function parseFilters(filters: PublicIdeaFilters): PublicIdeaQuery {
  let category: IdeaCategory | undefined;
  if (filters.category !== undefined && filters.category !== '') {
    if (!isIdeaCategory(filters.category)) throw new InvalidIdeaFilterError('category');
    category = filters.category;
  }
  let kind: IdeaKind | undefined;
  if (filters.kind !== undefined && filters.kind !== '') {
    if (!isIdeaKind(filters.kind)) throw new InvalidIdeaFilterError('kind');
    kind = filters.kind;
  }
  const tags = [...new Set((filters.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0))];
  const q = filters.q?.trim().slice(0, PUBLIC_IDEA_QUERY_MAX) || undefined;
  return { category, kind, tags, q };
}

export const ideasPublicService = {
  /**
   * Active ideas narrowed by any combination of category, tags (all must
   * match), text and kind — with per-category counts computed over every filter
   * EXCEPT the category, so the chips stay choosable.
   *
   * @throws InvalidIdeaFilterError for a category or kind outside the closed set.
   *   An unknown TAG is not an error: it simply matches nothing.
   * @throws IdeaListCapExceededError when the read reaches the cap.
   */
  async listActive(filters: PublicIdeaFilters = {}): Promise<PublicIdeaListDto> {
    const query = parseFilters(filters);
    const [rows, counts] = await Promise.all([
      ideaPublicRepository.listActive(query, PUBLIC_IDEA_LIST_CAP + 1),
      ideaPublicRepository.categoryCounts({ ...query, category: undefined }),
    ]);
    if (rows.length > PUBLIC_IDEA_LIST_CAP)
      throw new IdeaListCapExceededError(PUBLIC_IDEA_LIST_CAP);

    const byCategory = new Map(counts.map((c) => [c.category, c.count]));
    return {
      items: rows.map(toPublicIdeaDto),
      categories: IDEA_CATEGORIES.filter((c) => (byCategory.get(c) ?? 0) > 0).map((c) => ({
        slug: c,
        label: IDEA_CATEGORY_LABELS[c],
        count: byCategory.get(c)!,
      })),
      total: rows.length,
    };
  },

  /** Every tag in use on an active idea, with its active count. */
  async listTags(): Promise<PublicIdeaTagDto[]> {
    const rows = await ideaPublicRepository.tagCounts();
    return rows.map((r) => ({ slug: r.slug, label: r.label, count: r.count }));
  },

  /**
   * One active idea. An unknown slug and a retired one throw the SAME error, so
   * a public reader cannot tell a retired idea ever existed.
   */
  async getBySlug(slug: string): Promise<PublicIdeaDto> {
    const row = await ideaPublicRepository.findActiveBySlug(slug);
    if (!row) throw new IdeaNotFoundError(slug);
    return toPublicIdeaDto(row);
  },
};
