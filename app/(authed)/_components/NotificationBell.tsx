'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bell } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import type { UnreadCountDTO } from '@/lib/dto/notifications';
import { NotificationDrawer } from './NotificationDrawer';

// The shell-header notification bell + unread badge (Subtask 5.7.5), per
// design/notifications/bell.mock.html. Mounts in TopNav's right cluster
// (between the theme toggle and the user menu) and hosts the NotificationDrawer
// as its Popover content. Owns the unread count + the open state for the whole
// surface.
//
// Two distinct numbers (the design's load-bearing seen-vs-read split):
//   * `unreadCount` — the server's per-row unread aggregate (readAt IS NULL),
//     polled cheaply (5.7.4 getUnreadCount). It drives the drawer's Direct-tab
//     count and the accessible name ("Notifications, 3 unread").
//   * the BADGE — "NEW since the drawer was last opened" (the Jira seen-count).
//     Opening the drawer marks the current unread set seen (`seenBaseline =
//     unreadCount`), so the badge clears; a later arrival re-shows it. The
//     baseline is CLAMPED down on every count change (`min(seenBaseline,
//     unreadCount)`) so reads dropping the unread count below the baseline can't
//     mask a genuinely new arrival. (The schema models unread + per-row readAt,
//     not a persisted "seen" marker, so the seen baseline is client session
//     state — it resets to 0 on a full reload, surfacing the full unread set.)
//
// No realtime substrate (the 5.1 live-comments decision): the count refreshes on
// a bounded poll while mounted + on every navigation. Mark-read / mark-all-read
// update from the mutation's OWN response (the inline-edit-no-tree-refresh
// memory) — never a router.refresh() fan-out.

/** Bell badge poll interval — bounded, no realtime push. */
const POLL_MS = 60_000;

function capCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

export function NotificationBell({ initialUnreadCount }: { initialUnreadCount: number }) {
  const t = useTranslations('notifications');
  const pathname = usePathname();

  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [seenBaseline, setSeenBaseline] = useState(0);
  const [open, setOpen] = useState(false);

  // Apply a fresh server count: store it AND clamp the seen baseline down, so a
  // read that drops the unread count below the baseline can't hide a new arrival.
  const applyServerCount = useCallback((next: number) => {
    setUnreadCount(next);
    setSeenBaseline((base) => Math.min(base, next));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications/unread-count');
      if (!res.ok) return;
      const data = (await res.json()) as UnreadCountDTO;
      applyServerCount(data.unreadCount);
    } catch {
      // A transient poll failure is non-fatal — the next tick retries.
    }
  }, [applyServerCount]);

  // Bounded poll while mounted (the bell lives in the persistent layout shell).
  useEffect(() => {
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Refresh the count on navigation (the no-realtime decision — poll +
  // navigation). Skip the very first render so we don't double-fetch the
  // server-threaded initial count. `refresh` sets state only after its await, so
  // this satisfies the set-state-in-effect rule. The drawer closes itself on a
  // row / settings deep-link (its onNavigate), and an outside-click on any other
  // nav dismisses the non-modal popover — so no setOpen is needed here.
  const firstNav = useRef(true);
  useEffect(() => {
    if (firstNav.current) {
      firstNav.current = false;
      return;
    }
    void refresh();
  }, [pathname, refresh]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Opening marks the current unread set "seen" → the badge clears.
    if (next) setSeenBaseline(unreadCount);
  }

  const badge = Math.max(0, unreadCount - seenBaseline);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t('bellAria', { count: unreadCount })}
          className={cn(
            'relative inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) transition-colors hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
            open && 'bg-(--el-surface) text-(--el-text)',
          )}
        >
          <Bell className="h-5 w-5" aria-hidden />
          {badge > 0 ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-(--radius-badge) bg-(--el-accent) px-1 text-[10px] leading-none font-bold text-(--el-accent-text) ring-2 ring-(--el-page-bg)"
            >
              {capCount(badge)}
            </span>
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        width={384}
        role="dialog"
        aria-label={t('title')}
        className="p-0"
      >
        <NotificationDrawer
          unreadCount={unreadCount}
          onCountChange={applyServerCount}
          onNavigate={() => setOpen(false)}
        />
      </Popover.Content>
    </Popover>
  );
}
