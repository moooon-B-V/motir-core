'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
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
// never load-all). Each row LINKS to the public work-item DETAIL page (6.14.11);
// no edit affordances. The `id` anchor is kept so an older `#identifier` deep
// link still scrolls to the row.

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

function Row({ item, identifier }: { item: PublicWorkItemListItemDto; identifier: string }) {
  const t = useTranslations('publicProjects');
  const pri = PRIORITY_PILL[item.priority];
  // Links to the public work-item DETAIL page (6.14.11) — read-only, never the
  // authed /items/[key] surface. The `id` keeps an older `#identifier` deep
  // link scrolling to this row.
  return (
    <Link
      href={`/p/${encodeURIComponent(identifier)}/items/${encodeURIComponent(item.identifier)}`}
      id={item.identifier}
      className="flex scroll-mt-24 items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-3 shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong)"
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
    </Link>
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
            <Row item={item} identifier={identifier} />
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
