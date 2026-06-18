'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import type { ReadyItemDto } from '@/lib/dto/ready';
import { useRowWindow } from '@/components/ui/useRowWindow';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Avatar, PriorityValue } from '../../issues/_components/issueCellPrimitives';
import { usePeekOpen } from '../../issues/_components/IssueQuickView';
import { loadMoreReadyAction } from '../_actions';

// The /ready dispatch list (Subtask 7.0.6, design/ready panel 1). A NEW
// arrangement of shipped primitives — IssueTypeIcon (hued), the priority
// PriorityValue chip, the initial-letter Avatar (+ the dashed-circle unassigned
// placeholder, mirroring BoardCard), and a hover copy button with its Tooltip —
// NOT a new card vocabulary.
//
// Scale shape (finding #57): the page server-renders the FIRST cursor page; this
// virtualizes the loaded rows via the 2.5.15/3.2.5 `useRowWindow` primitive (only
// viewport rows mount; degrades to render-all under no measurable viewport, e.g.
// SSR/tests) AND streams subsequent cursor pages on demand via
// `loadMoreReadyAction` when a bottom sentinel nears the viewport — so neither
// the DOM nor the initial payload grows with the backlog. Same `(priority desc,
// key asc)` order as `POST /api/ready/next`, so the page and the agent agree.
//
// Row interaction (notes.html #7): the whole card opens the existing
// `IssueQuickView` peek (`?peek=<key>`), NOT a full-page navigation — the title
// is a stretched-`::after` button covering the card; the copy button is raised
// above it (`relative z-10`) so it doesn't trigger the peek.

const ROW_ESTIMATE_PX = 44;
const ROW_GAP_PX = 8;
// Prefetch the next cursor page this far before the list bottom enters view, so a
// fast scroll never stalls on an empty tail.
const LOAD_AHEAD_PX = 600;

export interface ReadyListProps {
  initialItems: ReadyItemDto[];
  initialCursor: string | null;
}

export function ReadyList({ initialItems, initialCursor }: ReadyListProps) {
  const t = useTranslations('ready');
  const [items, setItems] = useState<ReadyItemDto[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [isPending, startTransition] = useTransition();
  // Guards re-entrancy: the IntersectionObserver can fire repeatedly while the
  // sentinel sits in view; only one load is in flight at a time.
  const loadingRef = useRef(false);

  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: items.length,
    estimateRowHeight: ROW_ESTIMATE_PX,
    gap: ROW_GAP_PX,
  });

  const loadMore = useCallback(() => {
    if (loadingRef.current || cursor === null) return;
    loadingRef.current = true;
    startTransition(async () => {
      try {
        const next = await loadMoreReadyAction(cursor);
        setItems((prev) => [...prev, ...next.items]);
        setCursor(next.nextCursor);
      } finally {
        loadingRef.current = false;
      }
    });
  }, [cursor]);

  // Stream the next page as a bottom sentinel nears the viewport. Re-armed each
  // time the cursor advances; torn down at the tail (cursor === null).
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || cursor === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: `${LOAD_AHEAD_PX}px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  const indices: number[] = [];
  if (windowing) {
    for (let i = range.start; i < range.end; i++) indices.push(i);
  } else {
    for (let i = 0; i < items.length; i++) indices.push(i);
  }

  return (
    <div>
      <div
        ref={containerRef}
        role="list"
        aria-label={t('listAria')}
        className={windowing ? 'relative' : 'flex flex-col gap-2'}
        style={windowing ? { height: totalSize } : undefined}
      >
        {indices.map((index) => {
          const item = items[index]!;
          return (
            <div
              key={item.id}
              role="listitem"
              ref={measureElement(index)}
              style={
                windowing
                  ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                  : undefined
              }
            >
              <ReadyRow item={item} />
            </div>
          );
        })}
      </div>

      {/* Cursor sentinel — present only while more pages remain. */}
      {cursor !== null ? <div ref={sentinelRef} aria-hidden className="h-px w-full" /> : null}
      {isPending ? (
        <p className="mt-2 text-center text-xs text-(--el-text-muted)" role="status">
          {t('loadingMore')}
        </p>
      ) : null}
    </div>
  );
}

/** One dispatch card — a flat arrangement of the shipped issue primitives. */
function ReadyRow({ item }: { item: ReadyItemDto }) {
  const t = useTranslations('ready');
  const openPeek = usePeekOpen();
  const { toast } = useToast();
  // Container kinds (epic / story) are *planned/deepened*, not executed — they
  // only enter the ready set while childless (the `NOT EXISTS (children)` ready
  // predicate), and the action a user takes on one is `motir plan <key>`.
  // Executable leaves (task / subtask / bug) dispatch with `motir run <key>`.
  const verb = item.kind === 'epic' || item.kind === 'story' ? 'plan' : 'run';
  const command = `motir ${verb} ${item.key}`;

  const copy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(command);
      toast({
        variant: 'success',
        title: t('toast.title'),
        description: t('toast.body', { command }),
      });
    },
    [command, t, toast],
  );

  return (
    <div className="group relative flex min-h-(--height-control) items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong) hover:bg-(--el-surface-soft)">
      <IssueTypeIcon type={item.kind} className="h-[18px] w-[18px] shrink-0" />
      <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">{item.key}</span>
      {/* Stretched-`::after` button: the whole card opens the peek (notes.html #7). */}
      <button
        type="button"
        onClick={() => openPeek(item.key)}
        aria-label={`${item.key} ${item.title}`}
        className="min-w-0 flex-1 truncate rounded-(--radius-control) text-left text-sm text-(--el-text) after:absolute after:inset-0 after:content-[''] group-hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        {item.title}
      </button>
      <div className="flex shrink-0 items-center gap-3">
        <PriorityValue priority={item.priority} />
        <ReadyAssignee assignee={item.assignee} />
        {/* Raised above the stretched overlay so it doesn't open the peek. */}
        <span className="relative z-10">
          <Tooltip
            content={t.rich('copyTooltip', {
              command,
              cmd: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          >
            <button
              type="button"
              onClick={copy}
              aria-label={t('copyAria', { key: item.key })}
              className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) opacity-0 transition-[opacity,color,background-color] hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:text-(--el-text) focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) group-hover:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <Copy className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        </span>
      </div>
    </div>
  );
}

/** Assignee cell — initial-letter Avatar + name, or the dashed-circle
 *  unassigned placeholder (mirrors BoardCard's convention). */
function ReadyAssignee({ assignee }: { assignee: ReadyItemDto['assignee'] }) {
  const t = useTranslations('ready');
  if (!assignee) {
    return (
      <span
        aria-label={t('unassigned')}
        className="inline-flex h-[22px] w-[22px] shrink-0 rounded-full border border-dashed border-(--el-border-strong) bg-(--el-muted)"
      />
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={assignee.name} />
      <span className="hidden truncate text-sm text-(--el-text-secondary) sm:inline">
        {assignee.name}
      </span>
    </span>
  );
}
