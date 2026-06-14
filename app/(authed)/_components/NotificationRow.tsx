'use client';

import type { ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { AtSign, Bell, Check, GitPullRequest, MessageSquare, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { NotificationDTO } from '@/lib/dto/notifications';

// One notification row in the drawer feed (Subtask 5.7.5), per
// design/notifications/drawer.mock.html panels 0–1: the leading accent unread
// dot · the 30px initial-letter avatar carrying a small event-type glyph badge
// in the event's hue (finding #54 — the palette, not grey) · the one-line
// summary (actor + action + issue key, actor & key in --el-text-strong) with
// the relative time pushed right (absolute on hover/title) · the denormalized
// excerpt, single-line truncated. Read rows persist (greyed via --el-text-muted,
// no dot).
//
// ⚠️ No nested interactive elements (the portal-popover / nested-button
// lessons): the whole row is ONE clickable deep-link `<Link>`, and the per-row
// "mark read" toggle is a SIBLING `<button>` overlaid top-right — NOT a child of
// the link. Both call up to the drawer; clicking the row body also marks read.
//
// Mark-UNREAD is intentionally absent: the shipped 5.7.4 API exposes only
// markRead / markAllRead (no un-read mutation), so the toggle shows on unread
// rows only. The design's "mark as unread" affordance is surfaced as a finding
// (design vs shipped-API gap) rather than improvised against a missing endpoint.

/** event type → its glyph + the --el-* hue its avatar badge takes. */
const TYPE_META: Record<string, { Icon: ComponentType<{ className?: string }>; badge: string }> = {
  mentioned: { Icon: AtSign, badge: 'bg-(--el-accent)' },
  commented: { Icon: MessageSquare, badge: 'bg-(--el-type-task)' },
  assigned: { Icon: UserCheck, badge: 'bg-(--el-type-story)' },
  transitioned: { Icon: GitPullRequest, badge: 'bg-(--el-type-subtask)' },
};
const DEFAULT_META = { Icon: Bell, badge: 'bg-(--el-text-muted)' };

/** Pick the summary i18n key for a notification's type (+ whether it deep-links). */
function summaryKey(type: string, hasKey: boolean): string {
  if (!hasKey) return 'summary.genericNoKey';
  switch (type) {
    case 'mentioned':
      return 'summary.mentioned';
    case 'commented':
      return 'summary.commented';
    case 'assigned':
      return 'summary.assigned';
    case 'transitioned':
      return 'summary.transitioned';
    default:
      return 'summary.generic';
  }
}

export function NotificationRow({
  notification,
  onActivate,
  onMarkRead,
}: {
  notification: NotificationDTO;
  /** The row was opened (clicked) — deep-link + mark read. */
  onActivate: (n: NotificationDTO) => void;
  /** The hover toggle was pressed — mark read without navigating. */
  onMarkRead: (n: NotificationDTO) => void;
}) {
  const t = useTranslations('notifications');
  const format = useFormatter();

  const read = notification.readAt !== null;
  const meta = TYPE_META[notification.type] ?? DEFAULT_META;
  const { Icon } = meta;
  // `data` is a discriminated union (5.7.9) — narrow on `kind` for the
  // arm-specific nouns; `issueKey` / `title` are shared across arms.
  const data = notification.data;
  const issueKey = data.issueKey || null;
  const excerpt = data.kind === 'mentioned' ? data.excerpt : null;
  const toStatus = data.kind === 'transitioned' ? data.toStatus : '';
  const actorName = notification.actor?.name ?? t('actorFallback');
  const createdAt = new Date(notification.createdAt);

  // Rich summary: actor + key bolded via the <s> tag, greyed one tier on a
  // read row (the design's read treatment).
  const strong = (chunks: ReactNode) => (
    <strong
      className={cn(
        'font-semibold',
        read ? 'text-(--el-text-secondary)' : 'text-(--el-text-strong)',
      )}
    >
      {chunks}
    </strong>
  );
  const summary = t.rich(summaryKey(notification.type, issueKey !== null), {
    actor: actorName,
    key: issueKey ?? '',
    status: toStatus,
    s: strong,
  });

  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          'mt-[13px] h-2 w-2 shrink-0 rounded-full',
          read ? 'bg-transparent' : 'bg-(--el-accent)',
        )}
      />
      <span className="relative shrink-0">
        <span
          aria-hidden
          className={cn(
            'inline-flex h-[30px] w-[30px] items-center justify-center rounded-full text-xs font-semibold text-(--el-text-inverted)',
            read ? 'bg-(--el-text-faint)' : 'bg-(--el-text)',
          )}
        >
          {actorName.charAt(0).toUpperCase()}
        </span>
        <span
          aria-hidden
          className={cn(
            'absolute -right-0.5 -bottom-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-(--el-accent-text) ring-2 ring-(--el-page-bg)',
            meta.badge,
            read && 'opacity-60',
          )}
        >
          <Icon className="h-2.5 w-2.5" />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 text-[13px] leading-[1.4]',
              read ? 'text-(--el-text-muted)' : 'text-(--el-text)',
            )}
          >
            {summary}
          </span>
          <span
            className="shrink-0 text-[11px] whitespace-nowrap text-(--el-text-faint)"
            title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {format.relativeTime(createdAt)}
          </span>
        </span>
        {excerpt ? (
          <span
            className={cn(
              'truncate text-xs leading-[1.4]',
              read ? 'text-(--el-text-faint)' : 'text-(--el-text-muted)',
            )}
          >
            {excerpt}
          </span>
        ) : null}
      </span>
    </>
  );

  const rowClass = cn(
    'flex items-start gap-2.5 py-3 pr-10 pl-3 text-left transition-colors',
    read ? 'hover:bg-(--el-surface)' : 'bg-(--el-surface-soft) hover:bg-(--el-surface)',
  );

  return (
    <div className="relative border-b border-(--el-border-soft) last:border-b-0">
      {issueKey ? (
        <Link
          href={`/issues/${issueKey}`}
          onClick={() => onActivate(notification)}
          className={rowClass}
        >
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => onActivate(notification)}
          className={cn('w-full', rowClass)}
        >
          {body}
        </button>
      )}
      {!read ? (
        <button
          type="button"
          aria-label={t('markRead')}
          onClick={() => onMarkRead(notification)}
          className="absolute top-2.5 right-2 inline-flex h-6 w-6 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Check className="h-[15px] w-[15px]" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
