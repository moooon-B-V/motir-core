import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import type { PublicWorkItemListItemDto } from '@/lib/dto/publicProjects';
import { cn } from '@/lib/utils/cn';

// The PUBLIC board/list card (Story 6.12 · Subtask 6.12.4 · design Panel 2
// `.bcard`) — the shipped board card MINUS the internal fields: it carries ONLY
// the IssueTypeIcon (kind hue), the work item key, the title, and the priority
// Pill. NO assignee avatar, NO estimate/story-point chip, NO drag grip. It's an
// <a> (navigable, not draggable). The omissions are a read-layer projection
// (the DTO has no assignee/estimate/storyPoints fields) — not DOM-hidden.
//
// Public card links land on the public work-item DETAIL page (6.14.11) via the
// `href` the caller builds — read-only, never the authed /issues/[key] surface.

const PRIORITY_PILL: Record<
  PublicWorkItemListItemDto['priority'],
  { tone: 'high' | 'medium' | 'low'; key: string }
> = {
  highest: { tone: 'high', key: 'priorityHighest' },
  high: { tone: 'high', key: 'priorityHigh' },
  medium: { tone: 'medium', key: 'priorityMedium' },
  low: { tone: 'low', key: 'priorityLow' },
  lowest: { tone: 'low', key: 'priorityLowest' },
};

export async function PublicWorkItemCard({
  item,
  href,
}: {
  item: PublicWorkItemListItemDto;
  href: string;
}) {
  const t = await getTranslations('publicProjects');
  const pri = PRIORITY_PILL[item.priority];
  return (
    <Link
      href={href}
      className="block rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-3 shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong)"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <IssueTypeIcon type={item.kind} className="h-4 w-4" />
        <span className="font-mono text-[11.5px] text-(--el-text-faint)">{item.identifier}</span>
      </div>
      <div className="text-[13.5px] font-semibold leading-snug text-(--el-text)">{item.title}</div>
      <div className="mt-2 flex items-center gap-2">
        <Pill
          tone="neutral"
          className={cn(
            'border-transparent text-(--el-text-strong)',
            pri.tone === 'high' && 'bg-(--el-tint-rose)',
            pri.tone === 'medium' && 'bg-(--el-tint-yellow)',
            pri.tone === 'low' &&
              'border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)',
          )}
        >
          {t(pri.key)}
        </Pill>
      </div>
    </Link>
  );
}
