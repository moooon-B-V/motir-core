'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { NotebookText, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import { useLinkCandidateSearch } from '@/hooks/useLinkCandidateSearch';
import type { PageMentionCandidateDto } from '@/lib/dto/pages';
import { searchLinkablePages } from '@/lib/pages/pageLinkSearch';
import { linkPageToWorkItem } from '@/lib/workItems/pageLinksClient';
import { Place } from './PagePlace';

// THE LINK PAGE FORM (Story MOTIR-7567 · MOTIR-9199), per
// `design/work-items/item--pages-section--link.mock.html` (MOTIR-9195, panels
// P5–P15): an INLINE form at the top of the Pages card body — no overlay, no
// focus trap, the rows being changed stay visible underneath. One search field
// over the paged live-page title search; picking a candidate writes the hand link
// at once (there is no separate submit), and this form maps every refusal the
// write path can answer to its own sentence beside the field, query intact.
//
// The debounce, the cancellation of a superseded query and the two-character
// floor are `useLinkCandidateSearch`'s; this form adds the cursor (Show more) and
// the refusal table. It never saves the page and never re-reads the section: the
// parent mutates its rows locally on `onLinked`.

export interface LinkPageFormProps {
  projectId: string;
  workItemId: string;
  /** The page was linked; the parent pins it, closes the form and refocuses the door. */
  onLinked: (page: PageMentionCandidateDto) => void;
  /** Escape — close the form and return focus to the door. */
  onClose: () => void;
  /** The form's writing state, so the door's Cancel can be disabled while it is in flight. */
  onWritingChange?: (writing: boolean) => void;
}

type Refusal =
  | { kind: 'alreadyLinked'; title: string }
  | { kind: 'permission' }
  | { kind: 'gone' }
  | { kind: 'failed' };

/** The refusal table — keyed by the body's `code` FIRST (a 409 alone cannot decide: the
 *  archived and already-linked refusals share it), then the status family. */
function refusalFor(status: number, code: string | null, title: string): Refusal {
  if (code === 'PAGE_LINK_ALREADY_LINKED') return { kind: 'alreadyLinked', title };
  if (code === 'PAGE_ARCHIVED' || code === 'PAGE_NOT_FOUND') return { kind: 'gone' };
  if (status === 403) return { kind: 'permission' };
  if (status === 404) return { kind: 'gone' };
  return { kind: 'failed' };
}

interface Extra {
  query: string;
  items: PageMentionCandidateDto[];
  cursor: string | null;
  loading: boolean;
  failedCursor: string | null;
}

export function LinkPageForm({
  projectId,
  workItemId,
  onLinked,
  onClose,
  onWritingChange,
}: LinkPageFormProps) {
  const t = useTranslations('issueViews');
  const tCommon = useTranslations('common');
  const tPages = useTranslations('pages');
  const inputId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // The first page's cursor, tagged with the query that produced it, so a stale
  // answer's cursor never decorates a newer query's candidates.
  const [first, setFirst] = useState<{ query: string; cursor: string | null } | null>(null);
  const latestQuery = useRef('');
  const [retryKey, setRetryKey] = useState(0);
  const [extra, setExtra] = useState<Extra | null>(null);
  const moreSeq = useRef(0);

  const { query, setQuery, candidates, loading, error, tooShort } =
    useLinkCandidateSearch<PageMentionCandidateDto>({
      refetchKey: String(retryKey),
      fetcher: async (q) => {
        latestQuery.current = q;
        try {
          const page = await searchLinkablePages(projectId, q, null);
          if (latestQuery.current === q) setFirst({ query: q, cursor: page.nextCursor });
          return { ok: true, candidates: page.items };
        } catch {
          return { ok: false, error: 'search-failed' };
        }
      },
    });
  const trimmed = query.trim();

  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<PageMentionCandidateDto | null>(null);
  const [writing, setWriting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function setWritingBoth(value: boolean) {
    setWriting(value);
    onWritingChange?.(value);
  }

  const moreForQuery = extra !== null && extra.query === trimmed ? extra : null;
  const shown: PageMentionCandidateDto[] = tooShort
    ? []
    : (() => {
        const seen = new Set(candidates.map((c) => c.id));
        return [...candidates, ...(moreForQuery?.items.filter((c) => !seen.has(c.id)) ?? [])];
      })();
  const cursor =
    moreForQuery !== null
      ? moreForQuery.cursor
      : first !== null && first.query === trimmed
        ? first.cursor
        : null;
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));

  function loadMore(from: string) {
    const mine = ++moreSeq.current;
    const q = trimmed;
    setExtra((cur) => ({
      query: q,
      items: cur !== null && cur.query === q ? cur.items : [],
      cursor: from,
      loading: true,
      failedCursor: null,
    }));
    searchLinkablePages(projectId, q, from)
      .then((page) => {
        if (mine !== moreSeq.current) return;
        setExtra((cur) => {
          const items = cur !== null && cur.query === q ? cur.items : [];
          const seen = new Set(items.map((c) => c.id));
          return {
            query: q,
            items: [...items, ...page.items.filter((c) => !seen.has(c.id))],
            cursor: page.nextCursor,
            loading: false,
            failedCursor: null,
          };
        });
      })
      .catch(() => {
        if (mine !== moreSeq.current) return;
        setExtra((cur) =>
          cur === null ? cur : { ...cur, cursor: from, loading: false, failedCursor: from },
        );
      });
  }

  function onQueryChange(value: string) {
    setQuery(value);
    setRefusal(null);
    setActive(0);
    moreSeq.current += 1;
    setExtra(null);
  }

  async function pick(candidate: PageMentionCandidateDto) {
    if (writing) return;
    setPicked(candidate);
    setRefusal(null);
    setWritingBoth(true);
    try {
      const result = await linkPageToWorkItem(workItemId, candidate.id);
      if (result.ok) {
        onLinked(candidate);
        return;
      }
      const next = refusalFor(result.status, result.code, candidate.title || tPages('untitled'));
      setRefusal(next);
      // Only a generic failure keeps the pick (its retry re-sends the same pair).
      if (next.kind !== 'failed') setPicked(null);
    } catch {
      setRefusal({ kind: 'failed' });
    } finally {
      setWritingBoth(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown' && shown.length > 0) {
      e.preventDefault();
      setActive((activeIndex + 1) % shown.length);
    } else if (e.key === 'ArrowUp' && shown.length > 0) {
      e.preventDefault();
      setActive((activeIndex - 1 + shown.length) % shown.length);
    } else if (e.key === 'Enter' && shown.length > 0 && !tooShort) {
      e.preventDefault();
      void pick(shown[activeIndex]!);
    }
  }

  const untitled = tPages('untitled');
  const refusalText =
    refusal === null
      ? null
      : refusal.kind === 'alreadyLinked'
        ? t('pagesLinkAlreadyLinked', { title: refusal.title })
        : refusal.kind === 'permission'
          ? t('pagesLinkRefusedPermission')
          : refusal.kind === 'gone'
            ? t('pagesLinkRefusedGone')
            : t('pagesLinkFailed');

  return (
    <div
      data-testid="link-page-form"
      className="mb-3 flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding-12)"
    >
      <label htmlFor={inputId} className="text-xs font-medium text-(--el-text-secondary)">
        {t('pagesLinkSearchLabel')}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-controls={listId}
        aria-activedescendant={shown.length > 0 ? `${listId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        value={query}
        placeholder={t('pagesLinkSearchLabel')}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="h-(--height-input) w-full rounded-(--radius-input) border border-(--el-input-border) bg-(--el-card) px-(--spacing-input-x) text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      />

      {picked !== null ? (
        <div
          data-testid="link-page-picked"
          className="flex min-w-0 items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x-8) py-(--spacing-control-y-4)"
        >
          <NotebookText className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-(--el-text)">{picked.title || untitled}</span>
            <Place place={picked.place} />
          </span>
          <button
            type="button"
            aria-label={t('pagesLinkClearPick')}
            disabled={writing}
            onClick={() => {
              setPicked(null);
              setRefusal(null);
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ) : null}

      <div role="status" className="flex flex-col gap-2">
        {refusalText !== null ? (
          <div
            className={cn(
              'flex flex-wrap items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x-8) py-(--spacing-control-y-4) text-[13px]',
              refusal?.kind === 'alreadyLinked'
                ? 'bg-(--el-tint-sky) text-(--el-text-strong)'
                : 'bg-(--el-danger-surface) text-(--el-danger-surface-text)',
            )}
          >
            <span>{refusalText}</span>
            {refusal?.kind === 'failed' && picked !== null ? (
              <Button
                variant="secondary"
                size="sm"
                loading={writing}
                onClick={() => void pick(picked)}
              >
                {tCommon('retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {tooShort ? (
          <p className="m-0 text-[13px] text-(--el-text-secondary)">{t('pagesLinkSearchHint')}</p>
        ) : loading ? (
          <p className="m-0 text-[13px] text-(--el-text-secondary)">{t('pagesLinkSearching')}</p>
        ) : error !== null ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] text-(--el-text-secondary)">
              {t('pagesLinkSearchFailed')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setRetryKey((k) => k + 1)}>
              {tCommon('retry')}
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <p className="m-0 text-[13px] text-(--el-text-secondary)">
            {t('pagesLinkNoMatches', { query: trimmed })}
          </p>
        ) : null}
      </div>

      {shown.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('pagesLinkCandidatesAria')}
          className="m-0 flex list-none flex-col p-0"
        >
          {shown.map((candidate, index) => (
            <li
              key={candidate.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActive(index)}
              onClick={() => void pick(candidate)}
              className={cn(
                'flex min-w-0 cursor-pointer items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)',
                index === activeIndex && 'bg-(--el-surface)',
              )}
            >
              <NotebookText
                className="mt-0.5 h-4 w-4 shrink-0 self-start text-(--el-icon-muted)"
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  className={cn(
                    'truncate text-sm',
                    candidate.title ? 'text-(--el-text)' : 'text-(--el-text-secondary) italic',
                  )}
                >
                  {candidate.title || untitled}
                </span>
                <Place place={candidate.place} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {shown.length > 0 && !tooShort ? (
        moreForQuery?.loading ? (
          <p className="m-0 text-[13px] text-(--el-text-secondary)" role="status">
            {t('pagesLinkSearching')}
          </p>
        ) : moreForQuery?.failedCursor ? (
          <div role="status" className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] text-(--el-text-secondary)">
              {t('pagesLoadMoreError')}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => loadMore(moreForQuery.failedCursor!)}
            >
              {tCommon('retry')}
            </Button>
          </div>
        ) : cursor ? (
          <button
            type="button"
            onClick={() => loadMore(cursor)}
            className="h-(--height-control) w-full rounded-(--radius-control) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) px-(--spacing-control-x) font-sans text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {t('pagesShowMore')}
          </button>
        ) : null
      ) : null}
    </div>
  );
}
