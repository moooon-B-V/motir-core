'use client';

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { PageMoveResultDto, PageParentDto } from '@/lib/dto/pages';
import { parentKey, type LevelKey } from './pageTreeRow';

// MOVING A PAGE (Story MOTIR-5753 · MOTIR-7374) — `design/pages/design-notes.md`
// § The page tree, "Row menus" and "Move to…". The ONE place a page's placement
// is written from the tree: Move to… (`PagePlacementPicker`), Move up / Move
// down, and — next — drag (MOTIR-7376), which reuses this hook unchanged.
//
// ── WHAT IT DOES ───────────────────────────────────────────────────────────
// `move` PATCHes `/api/pages/<id>/placement` (MOTIR-7372) and, on success, asks
// the tree to re-read the SOURCE level and the TARGET level (the tree also
// re-reads the levels holding those parents, so their chevrons follow). Nothing
// is changed before the server answers, so a refusal leaves the tree exactly as
// it was — the design's "It stayed where it was" is literally true.
//
// ── REFUSALS → THE DESIGN'S SENTENCES ──────────────────────────────────────
//   422 PAGE_CYCLE                → pages.tree.refusal.cycle
//   422 PAGE_DEPTH_EXCEEDED       → pages.tree.refusal.depth ({limit} from the 422)
//   422 CROSS_PROJECT_PAGE_PARENT → pages.tree.refusal.crossProject
//   404 (folder or page gone)     → pages.tree.refusal.gone
// A stale neighbour (422 PAGE_NEIGHBOUR_INVALID — a sibling moved meanwhile)
// is the same story from the reader's side — the place they aimed at is no longer
// there — so it reads `gone` and the source level is re-read. Anything else (a
// lost connection, a 5xx) is `failed`, worded by the shipped transport sentence
// every tree write uses (`issueViews.actionTransportError`).
//
// ── SEQUENCE ───────────────────────────────────────────────────────────────
// Each move of a page is stamped; an answer that is no longer the newest move of
// that page is DROPPED (`null`), so two quick Move downs can never apply their
// refreshes or refusals out of order.

export type PageMoveRefusal = 'cycle' | 'depth' | 'crossProject' | 'gone' | 'failed';

export type PageMoveOutcome =
  | { ok: true; result: PageMoveResultDto }
  | { ok: false; refusal: PageMoveRefusal; message: string };

export interface PageMoveRequest {
  pageId: string;
  /** The level the page sits in now — re-read after the move. */
  from: LevelKey;
  parent: PageParentDto;
  /** The page it lands right AFTER (MOTIR-7372's neighbour shape). */
  beforeId?: string | null;
  /** The page it lands right BEFORE. */
  afterId?: string | null;
}

export interface PageMoveOptions {
  /** Re-read these loaded levels — the tree's own reader, with its per-level stamps. */
  refresh: (levels: LevelKey[]) => void;
}

export interface PageMoveController {
  /** Move a page; `null` when a newer move of the same page superseded this one. */
  move: (request: PageMoveRequest) => Promise<PageMoveOutcome | null>;
}

/**
 * The neighbours Move up / Move down sends, among the loaded SIBLING PAGES of a
 * level in order (folders always lead a level, so a page never passes one).
 * `null` at the edge: there is nothing to pass, and the menu draws no entry.
 */
export function reorderNeighbours(
  siblingPageIds: readonly string[],
  pageId: string,
  direction: 'up' | 'down',
): { beforeId: string | null; afterId: string | null } | null {
  const k = siblingPageIds.indexOf(pageId);
  if (k < 0) return null;
  if (direction === 'up') {
    if (k === 0) return null;
    return { beforeId: siblingPageIds[k - 2] ?? null, afterId: siblingPageIds[k - 1]! };
  }
  if (k === siblingPageIds.length - 1) return null;
  return { beforeId: siblingPageIds[k + 1]!, afterId: siblingPageIds[k + 2] ?? null };
}

const REFUSAL_BY_CODE: Record<string, Exclude<PageMoveRefusal, 'failed'>> = {
  PAGE_CYCLE: 'cycle',
  PAGE_DEPTH_EXCEEDED: 'depth',
  CROSS_PROJECT_PAGE_PARENT: 'crossProject',
  PAGE_NOT_FOUND: 'gone',
  FOLDER_NOT_FOUND: 'gone',
  PAGE_NEIGHBOUR_INVALID: 'gone',
};

/** The depth limit the design's sentence names when a 422 omits it (`PAGE_DEPTH_LIMIT`). */
const DEFAULT_DEPTH_LIMIT = 10;

export function usePageMove({ refresh }: PageMoveOptions): PageMoveController {
  const t = useTranslations('pages.tree.refusal');
  const tv = useTranslations('issueViews');
  const seq = useRef<Record<string, number>>({});

  const move = useCallback(
    async (request: PageMoveRequest): Promise<PageMoveOutcome | null> => {
      const stamp = (seq.current[request.pageId] ?? 0) + 1;
      seq.current[request.pageId] = stamp;
      const latest = () => seq.current[request.pageId] === stamp;

      let res: Response | null = null;
      let body: Record<string, unknown> = {};
      try {
        res = await fetch(`/api/pages/${encodeURIComponent(request.pageId)}/placement`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent: request.parent,
            beforeId: request.beforeId ?? null,
            afterId: request.afterId ?? null,
          }),
        });
        body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      } catch {
        res = null;
      }
      if (!latest()) return null;

      if (res?.ok) {
        const result = body as unknown as PageMoveResultDto;
        refresh([request.from, parentKey(result.parent)]);
        return { ok: true, result };
      }

      const code = typeof body.code === 'string' ? body.code : '';
      const refusal: PageMoveRefusal = res
        ? (REFUSAL_BY_CODE[code] ?? (res.status === 404 ? 'gone' : 'failed'))
        : 'failed';
      // The place it aimed at changed under it: show the source level as it now is.
      if (code === 'PAGE_NEIGHBOUR_INVALID') refresh([request.from]);
      const limit = typeof body.limit === 'number' ? body.limit : DEFAULT_DEPTH_LIMIT;
      const message =
        refusal === 'failed'
          ? tv('actionTransportError')
          : refusal === 'depth'
            ? t('depth', { limit })
            : t(refusal);
      return { ok: false, refusal, message };
    },
    [refresh, t, tv],
  );

  return { move };
}
