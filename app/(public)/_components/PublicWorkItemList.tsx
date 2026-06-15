'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import type { PublicWorkItemListItemDto } from '@/lib/dto/publicProjects';

// The public Work items tab list (Story 6.12 · Subtask 6.12.4) — a read-only,
// cursor-paginated list of the public projection (same stripped card as the
// board). Client island: it renders the SSR'd first page (props) and lazily
// loads more via /api/public/p/[identifier]/items (the at-scale rule —
// never load-all). Each row is an <a> anchored by its identifier (so a board
// card's #identifier link lands on it); no edit affordances.

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

function Row({ item }: { item: PublicWorkItemListItemDto }) {
  const t = useTranslations('publicProjects');
  const pri = PRIORITY_PILL[item.priority];
  // Not a link: 6.12.4 has no public work-item DETAIL route (that's a later
  // card), and a public viewer must never be bounced into the authed
  // /issues/[key] surface. The `id` anchor lets a board card's `#identifier`
  // link scroll to this row.
  return (
    <article
      id={item.identifier}
      className="flex scroll-mt-24 items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-3 shadow-(--shadow-subtle)"
    >
      <IssueTypeIcon type={item.kind} className="h-4 w-4 flex-none" />
      <span className="font-mono text-[11.5px] text-(--el-text-faint)">{item.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-(--el-text)">
        {item.title}
      </span>
      <Pill
        tone="neutral"
        className={cn(
          'flex-none border-transparent text-(--el-text-strong)',
          pri.tone === 'high' && 'bg-(--el-tint-rose)',
          pri.tone === 'medium' && 'bg-(--el-tint-yellow)',
          pri.tone === 'low' && 'border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)',
        )}
      >
        {t(pri.key)}
      </Pill>
    </article>
  );
}

export function PublicWorkItemList({
  identifier,
  initialItems,
  initialCursor,
}: {
  identifier: string;
  initialItems: PublicWorkItemListItemDto[];
  initialCursor: string | null;
}) {
  const t = useTranslations('publicProjects');
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const url = `/api/public/p/${encodeURIComponent(identifier)}/items?cursor=${encodeURIComponent(cursor)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const page: { items: PublicWorkItemListItemDto[]; nextCursor: string | null } =
        await res.json();
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, identifier, loading]);

  return (
    <div>
      <ul className="flex flex-col gap-2.5">
        {items.map((item) => (
          <li key={item.id}>
            <Row item={item} />
          </li>
        ))}
      </ul>
      {cursor ? (
        <div className="mt-4">
          <Button variant="secondary" size="sm" loading={loading} onClick={loadMore}>
            {loading ? t('loadingMore') : t('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
