'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  CheckCheck,
  ChevronDown,
  Inbox,
  MoreHorizontal,
  Settings,
  TriangleAlert,
} from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Segmented } from '@/components/ui/Segmented';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import type { NotificationCategory } from '@prisma/client';
import type {
  MarkAllReadResultDTO,
  MarkReadResultDTO,
  NotificationDTO,
  NotificationsPageDTO,
  UnreadByCategoryDTO,
} from '@/lib/dto/notifications';
import { NotificationRow } from './NotificationRow';

// The notification drawer / feed (Subtask 5.7.5), per
// design/notifications/drawer.mock.html: a header-anchored panel rendered as the
// bell's Popover content. Header = the "Notifications" title + the overflow
// (three-dots) carrying "Mark all as read" + "Notification settings"; a
// Direct / Watching Segmented (both tabs LIVE since bug 8.8.1 — Story 5.4
// issue-watching shipped and 5.7.10 wired the `watching` fan-in, so the seam is
// open); each tab carries its OWN category-scoped unread count; the cursor-paged
// feed (newest 20 + "Show more", finding #57) over the 5.7.4 read/mark API;
// loading / empty / error states.
//
// Inline-edit contract (the inline-edit-no-whole-tree-refresh memory): mark-read
// and mark-all-read update the badge + rows from the mutation's OWN returned
// `unreadCount` (reported up via `onCountChange`) — never a router.refresh() /
// revalidatePath whole-tree fan-out. A `countSeq` guard drops a stale response
// that resolves after a newer one (the WatchControl `fetchSeq` pattern the
// CLAUDE.md E2E rule mandates).

const PAGE_TABS: NotificationCategory[] = ['direct', 'watching'];

function capCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

export function NotificationDrawer({
  unreadCount,
  onCountChange,
  onNavigate,
}: {
  /** The live unread count (owned by the bell) — shown on the Direct tab. */
  unreadCount: number;
  /** Report the server's fresh unread count up to the bell (list + mutations). */
  onCountChange: (next: number) => void;
  /** Close the drawer when a row / the settings link navigates away. */
  onNavigate: () => void;
}) {
  const t = useTranslations('notifications');
  const { toast } = useToast();

  const [category, setCategory] = useState<NotificationCategory>('direct');
  // Per-tab unread counts (bug 8.8.1) — each Segmented tab shows its OWN
  // category-scoped count. Seeded from the bell's global count on the Direct tab
  // (the no-flash initial, since the bell's count is direct-dominant until
  // watching rows exist) and corrected by the first feed fetch (fires on mount).
  // The bell still owns the GLOBAL total via onCountChange.
  const [unreadByCat, setUnreadByCat] = useState<UnreadByCategoryDTO>(() => ({
    direct: unreadCount,
    watching: 0,
  }));
  const [rows, setRows] = useState<NotificationDTO[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [listError, setListError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Drops a stale list/mutation response that resolves after a newer one — so an
  // older poll can't clobber a newer mark-all's count (the inline-edit reconcile
  // guard; mirrors WatchControl.fetchSeq).
  const countSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // PURE fetch of one window — NO setState (so an effect may call it without
  // tripping the set-state-in-effect rule; setters live in the .then/.catch the
  // caller supplies). `cursor` null = the newest window; a cursor pages older.
  const fetchPage = useCallback(
    async (cursor: string | null, cat: NotificationCategory): Promise<NotificationsPageDTO> => {
      const params = new URLSearchParams({ category: cat });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as NotificationsPageDTO;
    },
    [],
  );

  // The event-handler load (retry / show-more / mark-all recovery) — setState is
  // fine here (not an effect body). `cursor` appends; null replaces.
  const load = useCallback(
    async (cursor: string | null, cat: NotificationCategory) => {
      const seq = ++countSeq.current;
      try {
        const page = await fetchPage(cursor, cat);
        if (!mounted.current) return;
        setRows((cur) => (cursor && cur ? [...cur, ...page.notifications] : page.notifications));
        setNextCursor(page.nextCursor);
        setTotalCount(page.totalCount);
        setListError(false);
        if (seq === countSeq.current) {
          setUnreadByCat(page.unreadByCategory);
          onCountChange(page.unreadCount);
        }
      } catch {
        if (mounted.current && !cursor) setListError(true);
      } finally {
        if (mounted.current) setLoadingMore(false);
      }
    },
    [fetchPage, onCountChange],
  );

  // First window on mount (and on a tab change, once Watching ships). The fetch
  // is INLINED so every setState sits inside a .then/.catch callback — never a
  // setState-bearing call in the effect body (the useWidgetData precedent for the
  // React-19 set-state-in-effect rule). rows starts null → the skeleton shows
  // until the fetch resolves.
  useEffect(() => {
    let cancelled = false;
    const seq = ++countSeq.current;
    void fetchPage(null, category)
      .then((page) => {
        if (cancelled || !mounted.current) return;
        setRows(page.notifications);
        setNextCursor(page.nextCursor);
        setTotalCount(page.totalCount);
        setListError(false);
        if (seq === countSeq.current) {
          setUnreadByCat(page.unreadByCategory);
          onCountChange(page.unreadCount);
        }
      })
      .catch(() => {
        if (!cancelled && mounted.current) setListError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [category, fetchPage, onCountChange]);

  // Retry after a load error — sync reset to skeleton (event-handler context),
  // then re-fetch.
  const retry = useCallback(() => {
    setRows(null);
    setListError(false);
    void load(null, category);
  }, [load, category]);

  // Page the next older window — sync loading flip, then append.
  const showMore = useCallback(() => {
    if (!nextCursor) return;
    setLoadingMore(true);
    void load(nextCursor, category);
  }, [load, nextCursor, category]);

  // Optimistically mark ONE row read, reconcile the count from the response
  // (no tree refresh). On failure, roll the row back + toast.
  const markRead = useCallback(
    async (n: NotificationDTO) => {
      if (n.readAt !== null) return;
      const seq = ++countSeq.current;
      const stamp = new Date().toISOString();
      setRows((cur) => cur?.map((r) => (r.id === n.id ? { ...r, readAt: stamp } : r)) ?? cur);
      try {
        const res = await fetch(`/api/notifications/${encodeURIComponent(n.id)}/read`, {
          method: 'PATCH',
        });
        if (!res.ok) throw new Error(String(res.status));
        const result = (await res.json()) as MarkReadResultDTO;
        if (seq === countSeq.current) {
          setUnreadByCat(result.unreadByCategory);
          onCountChange(result.unreadCount);
        }
      } catch {
        if (!mounted.current) return;
        setRows((cur) => cur?.map((r) => (r.id === n.id ? { ...r, readAt: null } : r)) ?? cur);
        toast({ variant: 'error', title: t('error.title') });
      }
    },
    [onCountChange, toast, t],
  );

  // Open a row: mark it read AND let the deep-link navigate (the drawer closes
  // on navigation via onNavigate). markRead fires-and-reconciles in the
  // background; the bell stays mounted to receive the count.
  const activate = useCallback(
    (n: NotificationDTO) => {
      void markRead(n);
      onNavigate();
    },
    [markRead, onNavigate],
  );

  // Mark ALL read in ONE request (the overflow action) — a single server op,
  // not a per-row client loop (the JRACLOUD-85017 anti-pattern). Optimistic +
  // reconcile from the response.
  const markAll = useCallback(async () => {
    setOverflowOpen(false);
    const seq = ++countSeq.current;
    const stamp = new Date().toISOString();
    setRows((cur) => cur?.map((r) => (r.readAt ? r : { ...r, readAt: stamp })) ?? cur);
    try {
      const res = await fetch('/api/notifications/mark-all-read', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const result = (await res.json()) as MarkAllReadResultDTO;
      if (seq === countSeq.current) {
        setUnreadByCat(result.unreadByCategory);
        onCountChange(result.unreadCount);
      }
    } catch {
      if (!mounted.current) return;
      toast({ variant: 'error', title: t('error.title') });
      void load(null, category);
    }
  }, [onCountChange, toast, t, load, category]);

  const remaining = Math.max(0, totalCount - (rows?.length ?? 0));

  return (
    <div className="flex flex-col">
      {/* Header — title + overflow menu */}
      <div className="flex items-center gap-2 border-b border-(--el-border) py-3 pr-2.5 pl-4">
        <span className="text-[15px] font-semibold text-(--el-text)">{t('title')}</span>
        <div className="ml-auto">
          <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                aria-label={t('options')}
                aria-expanded={overflowOpen}
                className={cn(
                  'inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) transition-colors hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
                  overflowOpen && 'bg-(--el-surface) text-(--el-text)',
                )}
              >
                <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden />
              </button>
            </Popover.Trigger>
            <Popover.Content align="end" width={212} className="p-1">
              <button
                type="button"
                onClick={markAll}
                disabled={unreadCount === 0}
                className="flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13px] text-(--el-text) hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCheck
                  className="h-[15px] w-[15px] shrink-0 text-(--el-text-muted)"
                  aria-hidden
                />
                {t('markAllRead')}
              </button>
              <div className="my-1 h-px bg-(--el-border-soft)" aria-hidden />
              <Link
                href="/settings/account/notifications"
                onClick={() => {
                  setOverflowOpen(false);
                  onNavigate();
                }}
                className="flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13px] text-(--el-text) hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none"
              >
                <Settings
                  className="h-[15px] w-[15px] shrink-0 text-(--el-text-muted)"
                  aria-hidden
                />
                {t('settings')}
              </Link>
            </Popover.Content>
          </Popover>
        </div>
      </div>

      {/* Direct / Watching tabs — both live (bug 8.8.1); each carries its own
          category-scoped unread count. */}
      <div className="border-b border-(--el-border-soft) px-3.5 py-2.5">
        <Segmented<NotificationCategory>
          label={t('filterLabel')}
          value={category}
          onChange={setCategory}
          options={PAGE_TABS.map((tab) => ({
            value: tab,
            label: tab === 'direct' ? t('tabs.direct') : t('tabs.watching'),
            trailing: unreadByCat[tab] > 0 ? capCount(unreadByCat[tab]) : undefined,
          }))}
        />
      </div>

      {/* Feed */}
      {listError ? (
        <div role="alert" className="flex flex-col items-center gap-1.5 px-7 py-11 text-center">
          <TriangleAlert className="mb-1.5 h-10 w-10 text-(--el-danger)" aria-hidden />
          <h3 className="text-[15px] font-semibold text-(--el-text)">{t('error.title')}</h3>
          <p className="max-w-60 text-[13px] text-(--el-text-muted)">{t('error.body')}</p>
          <Button variant="secondary" size="sm" className="mt-2.5" onClick={retry}>
            {t('error.retry')}
          </Button>
        </div>
      ) : rows === null ? (
        <div aria-busy className="flex flex-col">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-start gap-2.5 border-b border-(--el-border-soft) p-3"
            >
              <span className="h-[30px] w-[30px] shrink-0 animate-pulse rounded-full bg-(--el-muted)" />
              <span className="flex flex-1 flex-col gap-[7px] pt-[3px]">
                <span className="h-[9px] w-3/4 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
                <span className="h-[9px] w-1/2 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
              </span>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-7 py-11 text-center">
          <Inbox className="mb-1.5 h-10 w-10 text-(--el-text-faint)" aria-hidden />
          <h3 className="text-[15px] font-semibold text-(--el-text)">{t('empty.title')}</h3>
          <p className="max-w-60 text-[13px] text-(--el-text-muted)">{t('empty.body')}</p>
        </div>
      ) : (
        <>
          <div className="flex max-h-[432px] flex-col overflow-y-auto">
            {rows.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onActivate={activate}
                onMarkRead={markRead}
              />
            ))}
          </div>
          {nextCursor ? (
            <button
              type="button"
              onClick={showMore}
              disabled={loadingMore}
              className="flex w-full items-center justify-center gap-1.5 border-t border-(--el-border-soft) p-2.5 text-xs font-medium text-(--el-text-secondary) transition-colors hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:outline-none disabled:opacity-60"
            >
              {remaining > 0 ? t('showMoreCount', { count: remaining }) : t('showMore')}
              <ChevronDown className="h-[13px] w-[13px]" aria-hidden />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
