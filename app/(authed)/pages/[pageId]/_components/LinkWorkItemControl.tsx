'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { cn } from '@/lib/utils/cn';
import { useLinkCandidateSearch } from '@/hooks/useLinkCandidateSearch';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';
import type { WorkItemMentionCandidate } from '@/components/ui/markdownEditorMentions';
import type { IssueType } from '@/lib/issues/parentRules';
import { searchWorkItemMentions } from '@/lib/mentions/workItemMentionSearch';
import { linkPageToWorkItem, type PageLinkWriteResult } from '@/lib/workItems/pageLinksClient';

// THE LINK WORK ITEM CONTROL on the page's Linked work items strip (Story
// MOTIR-7567 · MOTIR-9200), per `design/pages/page--linked-work-items.mock.html`
// (panel 9, the picker in six boards): a trigger that opens a popover holding its
// own query field over the PROJECT-SCOPED work-item search, with the minimum
// length, the 250 ms settle and the eight-row window. The pick IS the write — no
// submit step — so a pick posts the pair and hands the strip both the pending
// candidate and the answer; the strip owns the rows and the refusal lines.
//
// ⚠️ Not `packages/pages`' `WorkItemPicker`: that is the `@` suggestion's listbox,
// takes its query as a prop and receives its keys from Tiptap, so it cannot live
// outside the editor (the design's obligation, D9). This listbox is the section
// form's own, on `useLinkCandidateSearch`.

/** The route's window (`MENTION_SEARCH_LIMIT`): exactly this many back means more may match. */
export const WORK_ITEM_SEARCH_WINDOW = 8;

export interface LinkWorkItemControlProps {
  pageId: string;
  /** The page's project — the one project the search covers. */
  projectId: string;
  /** A pick has been made and its write is in flight. */
  onPending: (candidate: WorkItemMentionCandidate) => void;
  /** The write answered; the strip reconciles. */
  onResult: (candidate: WorkItemMentionCandidate, result: PageLinkWriteResult | 'network') => void;
}

export function LinkWorkItemControl({
  pageId,
  projectId,
  onPending,
  onResult,
}: LinkWorkItemControlProps) {
  const t = useTranslations('pages.links');
  const tCommon = useTranslations('common');
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [retryKey, setRetryKey] = useState(0);

  const { query, setQuery, candidates, loading, error, tooShort, reset } =
    useLinkCandidateSearch<WorkItemMentionCandidate>({
      refetchKey: String(retryKey),
      fetcher: async (q) => {
        try {
          return {
            ok: true,
            candidates: await searchWorkItemMentions(q, { projectId, throwOnError: true }),
          };
        } catch {
          return { ok: false, error: 'search-failed' };
        }
      },
    });
  const activeIndex = Math.min(active, Math.max(candidates.length - 1, 0));

  function pick(candidate: WorkItemMentionCandidate) {
    setOpen(false);
    reset();
    onPending(candidate);
    linkPageToWorkItem(candidate.id, pageId).then(
      (result) => onResult(candidate, result),
      () => onResult(candidate, 'network'),
    );
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && candidates.length > 0) {
      e.preventDefault();
      setActive((activeIndex + 1) % candidates.length);
    } else if (e.key === 'ArrowUp' && candidates.length > 0) {
      e.preventDefault();
      setActive((activeIndex - 1 + candidates.length) % candidates.length);
    } else if (e.key === 'Enter' && candidates.length > 0 && !tooShort && !loading) {
      e.preventDefault();
      pick(candidates[activeIndex]!);
    }
    // Escape is the popover's own: it closes and returns focus to the trigger.
  }

  let state: string | null = null;
  if (tooShort) state = t('typeToSearch', { min: QUICK_SEARCH_MIN_QUERY_LENGTH });
  else if (loading) state = t('searching');
  else if (candidates.length === 0 && error === null) state = t('noResults');

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
        setActive(0);
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="secondary" size="sm" leftIcon={<Plus className="h-4 w-4" aria-hidden />}>
          {t('link')}
        </Button>
      </Popover.Trigger>
      <Popover.Content align="start" width="min(22rem, calc(100vw - 2rem))" collisionPadding={16}>
        <div className="flex flex-col gap-2 p-1">
          <input
            type="text"
            role="combobox"
            aria-label={t('pickerLabel')}
            aria-expanded={candidates.length > 0}
            aria-controls={listId}
            aria-activedescendant={candidates.length > 0 ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoFocus
            value={query}
            placeholder={t('pickerLabel')}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-(--height-input) w-full rounded-(--radius-input) border border-(--el-input-border) bg-(--el-card) px-(--spacing-input-x) text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          />
          {error !== null ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 text-[13px] text-(--el-text)"
            >
              <span>{t('searchFailed')}</span>
              <Button variant="secondary" size="sm" onClick={() => setRetryKey((k) => k + 1)}>
                {tCommon('retry')}
              </Button>
            </div>
          ) : state !== null ? (
            <p role="status" className="m-0 text-[13px] text-(--el-text-secondary)">
              {state}
            </p>
          ) : null}
          {candidates.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              aria-label={t('pickerLabel')}
              className="m-0 flex list-none flex-col p-0"
            >
              {candidates.map((candidate, index) => (
                <li
                  key={candidate.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(candidate)}
                  className={cn(
                    'flex min-w-0 cursor-pointer items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text)',
                    index === activeIndex && 'bg-(--el-surface)',
                  )}
                >
                  <IssueTypeIcon type={candidate.kind as IssueType} className="shrink-0" />
                  <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
                    {candidate.identifier}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {candidates.length >= WORK_ITEM_SEARCH_WINDOW && !loading && !tooShort ? (
            <p className="m-0 text-xs text-(--el-text-secondary)">{t('moreMatch')}</p>
          ) : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}
