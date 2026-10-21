'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { WorkItemRefChip } from '@/components/markdown/WorkItemRefChip';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { cn } from '@/lib/utils/cn';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemMentionCandidate } from '@/components/ui/markdownEditorMentions';
import type { PageWorkItemLinkRowDto } from '@/lib/dto/pageLinks';
import { fetchPageLinkedWorkItems } from '@/lib/pages/pageLinkedWorkItemsClient';
import { unlinkPageFromWorkItem, type PageLinkWriteResult } from '@/lib/workItems/pageLinksClient';
import { LinkWorkItemControl } from './LinkWorkItemControl';

// THE PAGE'S LINKED WORK ITEMS STRIP (Story MOTIR-7567 · MOTIR-9200), per
// `design/pages/page--linked-work-items.mock.html` (MOTIR-9196, panels 1–12): the
// work items linked to this page BY HAND, as the product's live chips, between the
// title row and the editor. A bare band — no card frame.
//
// One rule chooses among the shapes: paint iff (the read served rows OR this reader
// may link). A loading frame is drawn only for a reader who may link; any other
// reader gets nothing until rows arrive, and nothing at all when there are none.
// `canLink` is its OWN value (the route resolves `work_item:edit`), not the page's
// `canEdit`, and it is an affordance: the write re-checks the pair.
//
// A CLIENT ISLAND that owns its rows and defines no second transport: the read is
// `fetchPageLinkedWorkItems`, the writes are the pair-scoped callers the work item's
// Pages section also uses. It never writes the page body, and the read's order
// (newest link first) is never re-sorted.

export interface LinkedWorkItemsStripProps {
  pageId: string;
  /** The page's project; without it the strip draws no linking control. */
  projectId?: string;
  /** `work_item:edit` on the page's project, resolved by the route before first paint. */
  canLink: boolean;
}

type FirstRead = 'loading' | 'failed' | 'loaded';
type Refusal = 'alreadyLinked' | 'refused' | 'gone' | 'writeFailed';

function refusalFor(result: PageLinkWriteResult | 'network'): Refusal | null {
  if (result !== 'network' && result.ok) return null;
  if (result === 'network') return 'writeFailed';
  if (result.code === 'PAGE_LINK_ALREADY_LINKED') return 'alreadyLinked';
  if (result.status === 403) return 'refused';
  if (result.status === 404) return 'gone';
  return 'writeFailed';
}

/** The row's chip: three renderings of four data states (design D6). */
function RowChip({ row }: { row: PageWorkItemLinkRowDto }) {
  const t = useTranslations('pages.links');
  const summary = row.summary;
  if (summary === null || summary.accessible === false) {
    // Deleted and hidden are one drawing: a link row has no authored key and a reader
    // cannot be told which — so no key, no title and no status are in the DOM.
    return (
      <span className="wi-chip is-noaccess" title={t('unavailableTitle')}>
        <span className="wi-key">{t('unavailable')}</span>
      </span>
    );
  }
  return <WorkItemRefChip summary={summary} fallbackLabel={summary.identifier} />;
}

function PendingChip({ candidate }: { candidate: WorkItemMentionCandidate }) {
  // Drawn from the candidate, which has no status key and no archived flag: no
  // status dot and no archived treatment, so nothing here can be wrong for a frame.
  return (
    <span className="wi-chip max-w-full" aria-busy="true" data-testid="linked-pending-row">
      <IssueTypeIcon type={candidate.kind as IssueType} className="wi-type-icon shrink-0" />
      <span className="wi-key">{candidate.identifier}</span>
      <span className="wi-title min-w-0 truncate">{candidate.title}</span>
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
    </span>
  );
}

export function LinkedWorkItemsStrip({ pageId, projectId, canLink }: LinkedWorkItemsStripProps) {
  const t = useTranslations('pages.links');
  const tCommon = useTranslations('common');

  const [rows, setRows] = useState<PageWorkItemLinkRowDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [firstRead, setFirstRead] = useState<FirstRead>('loading');
  const [retrying, setRetrying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [pending, setPending] = useState<WorkItemMentionCandidate[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [unlinkFailed, setUnlinkFailed] = useState<{ workItemId: string } | null>(null);
  // Sequence guard: an answer that is no longer the latest request's never
  // clobbers newer state (CLAUDE.md § the app side).
  const seq = useRef(0);

  const readFirst = useCallback(() => {
    const mine = ++seq.current;
    return fetchPageLinkedWorkItems(pageId, null)
      .then((page) => {
        if (mine !== seq.current) return;
        setRows(page.rows);
        setNextCursor(page.nextCursor);
        setFailedCursor(null);
        setFirstRead('loaded');
      })
      .catch(() => {
        if (mine === seq.current) setFirstRead('failed');
      });
  }, [pageId]);

  useEffect(() => {
    void readFirst();
  }, [readFirst]);

  function retryFirstRead() {
    setRetrying(true);
    void readFirst().finally(() => setRetrying(false));
  }

  function loadMore(cursor: string) {
    const mine = ++seq.current;
    setLoadingMore(true);
    setFailedCursor(null);
    void fetchPageLinkedWorkItems(pageId, cursor)
      .then((page) => {
        if (mine !== seq.current) return;
        setRows((current) => {
          const seen = new Set(current.map((r) => r.workItemId));
          return [...current, ...page.rows.filter((r) => !seen.has(r.workItemId))];
        });
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (mine === seq.current) setFailedCursor(cursor);
      })
      .finally(() => {
        if (mine === seq.current) setLoadingMore(false);
      });
  }

  function onPending(candidate: WorkItemMentionCandidate) {
    setRefusal(null);
    setPending((current) =>
      current.some((c) => c.id === candidate.id) ? current : [candidate, ...current],
    );
  }

  function onResult(candidate: WorkItemMentionCandidate, result: PageLinkWriteResult | 'network') {
    const refused = refusalFor(result);
    setPending((current) => current.filter((c) => c.id !== candidate.id));
    if (refused !== null) {
      // Withdrawn; every other row is exactly as it was.
      setRefusal(refused);
      return;
    }
    // The served row replaces the pending one — re-read the FIRST page.
    void readFirst();
  }

  function unlink(workItemId: string) {
    const index = rows.findIndex((r) => r.workItemId === workItemId);
    const removed = rows[index];
    if (!removed) return;
    setUnlinkFailed(null);
    setRows((current) => current.filter((r) => r.workItemId !== workItemId));
    const restore = () => {
      setRows((current) => {
        if (current.some((r) => r.workItemId === workItemId)) return current;
        const next = [...current];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
      setUnlinkFailed({ workItemId });
    };
    unlinkPageFromWorkItem(workItemId, pageId).then((result) => {
      // Another writer already removed it: the requested end state holds.
      if (result.ok || (!result.ok && result.code === 'PAGE_LINK_NOT_FOUND')) return;
      restore();
    }, restore);
  }

  const controls = canLink && projectId !== undefined;
  const hasRows = rows.length > 0 || pending.length > 0;
  // Nothing for a reader with nothing to see and nothing to do: no flash of an empty
  // frame while their first read is out, and no failure line for a strip they never asked for.
  if (!canLink && !hasRows) return null;

  const failedRow = unlinkFailed?.workItemId;
  const refusalText = refusal === null ? null : t(refusal);

  return (
    <section
      aria-label={t('title')}
      className="mt-3 flex flex-col gap-2"
      data-testid="linked-strip"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-[12.5px] font-semibold text-(--el-text-secondary)">{t('title')}</h2>
        {controls && firstRead === 'loaded' ? (
          <LinkWorkItemControl
            pageId={pageId}
            projectId={projectId}
            onPending={onPending}
            onResult={onResult}
          />
        ) : null}
      </div>

      {firstRead === 'loading' ? (
        <div aria-busy="true" data-testid="linked-strip-loading" className="flex gap-2">
          <span className="sr-only">{t('loading')}</span>
          <span aria-hidden className="block h-6 w-40 rounded-(--radius-badge) bg-(--el-muted)" />
          <span aria-hidden className="block h-6 w-28 rounded-(--radius-badge) bg-(--el-muted)" />
        </div>
      ) : firstRead === 'failed' ? (
        <div role="status" className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-(--el-text)">{t('readFailed')}</span>
          <Button variant="secondary" size="sm" loading={retrying} onClick={retryFirstRead}>
            {tCommon('retry')}
          </Button>
        </div>
      ) : !hasRows ? (
        <p className="m-0 text-sm text-(--el-text-secondary) italic">{t('empty')}</p>
      ) : (
        <>
          <ul
            aria-label={t('listAria')}
            className="wi-chip-host m-0 flex list-none flex-col gap-1.5 p-0"
          >
            {pending.map((candidate) => (
              <li key={`pending:${candidate.id}`} className="flex items-center gap-2">
                <PendingChip candidate={candidate} />
              </li>
            ))}
            {rows
              .filter((row) => !pending.some((c) => c.id === row.workItemId))
              .map((row) => {
                const key =
                  row.summary !== null && row.summary.accessible
                    ? row.summary.identifier
                    : t('unavailable');
                return (
                  <li key={row.workItemId} className="flex min-w-0 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <RowChip row={row} />
                      {canLink ? (
                        <button
                          type="button"
                          aria-label={t('unlinkAria', { key })}
                          onClick={() => unlink(row.workItemId)}
                          className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-danger-on-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                    </span>
                    {failedRow === row.workItemId ? (
                      <span
                        role="status"
                        className="flex flex-wrap items-center gap-3 text-[13px] text-(--el-text)"
                      >
                        {t('unlinkFailed')}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => unlink(row.workItemId)}
                        >
                          {tCommon('retry')}
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
          </ul>
          {loadingMore ? (
            <div aria-busy="true" className="flex animate-pulse gap-2">
              <span
                aria-hidden
                className="block h-6 w-36 rounded-(--radius-badge) bg-(--el-muted)"
              />
              <span
                aria-hidden
                className="block h-6 w-24 rounded-(--radius-badge) bg-(--el-muted)"
              />
            </div>
          ) : null}
          {failedCursor !== null ? (
            <div role="status" className="flex flex-wrap items-center gap-3">
              <span className="text-[13px] text-(--el-text)">{t('loadMoreFailed')}</span>
              <Button variant="secondary" size="sm" onClick={() => loadMore(failedCursor)}>
                {tCommon('retry')}
              </Button>
            </div>
          ) : nextCursor ? (
            <button
              type="button"
              onClick={() => loadMore(nextCursor)}
              disabled={loadingMore}
              className={cn(
                'h-(--height-control) self-start rounded-(--radius-control) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) px-(--spacing-control-x) font-sans text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {t('showMore')}
            </button>
          ) : null}
        </>
      )}

      {refusalText !== null ? (
        <p
          role="status"
          className={cn(
            'm-0 rounded-(--radius-control) px-(--spacing-control-x-8) py-(--spacing-control-y-4) text-[13px]',
            refusal === 'alreadyLinked'
              ? 'bg-(--el-tint-sky) text-(--el-text-strong)'
              : 'bg-(--el-danger-surface) text-(--el-danger-surface-text)',
          )}
        >
          {refusalText}
        </p>
      ) : null}
    </section>
  );
}
