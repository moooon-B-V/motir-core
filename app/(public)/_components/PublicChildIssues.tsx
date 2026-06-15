'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown, Loader2 } from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import type { PublicTreeLevelDto, PublicWorkItemTreeRowDto } from '@/lib/dto/publicProjects';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

// The public work-item DETAIL page's CHILD / sub-issue panel (Story 6.14 ·
// Subtask 6.14.11 · design `public-item-detail.mock.html` panels 1/3). A list of
// the focal item's public-safe DIRECT children, each an <a> to its OWN
// `/p/.../items/<key>` detail page — the same stripped row grammar as
// `PublicWorkItemList` / `PublicWorkItemTree` (kind icon + key + title + a status
// Pill; NO assignee / estimate / story points). Client island: the Server
// Component (the detail page) SSRs the FIRST page of children (crawlable); this
// wrapper lazily appends more via the public tree endpoint (`?parentId=<item>&
// offset=<n>` — the at-scale rule, never load every child) when an item has many.
// A private epic's children never reach here — the page renders the "not public"
// placeholder instead, so this island is only mounted with real child rows.

const STATUS_PILL: Record<
  StatusCategoryDto,
  { variant: 'planned' | 'in-progress' | 'done'; key: string }
> = {
  todo: { variant: 'planned', key: 'statusTodo' },
  in_progress: { variant: 'in-progress', key: 'statusInProgress' },
  done: { variant: 'done', key: 'statusDone' },
};

function ChildRow({ row, itemsBase }: { row: PublicWorkItemTreeRowDto; itemsBase: string }) {
  const t = useTranslations('publicProjects');
  const s = STATUS_PILL[row.statusCategory];
  return (
    <Link
      href={`${itemsBase}/${encodeURIComponent(row.identifier)}`}
      className="flex items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-3 shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong)"
    >
      <IssueTypeIcon type={row.kind} className="h-4 w-4 flex-none" />
      <span className="font-mono text-[11.5px] text-(--el-text-faint)">{row.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-(--el-text)">
        {row.title}
      </span>
      <Pill status={s.variant} className="flex-none">
        {t(s.key)}
      </Pill>
    </Link>
  );
}

export function PublicChildIssues({
  identifier,
  parentId,
  initialChildren,
  initialHasMore,
  total,
}: {
  identifier: string;
  /** The focal item's id — the `parentId` the public tree endpoint pages on. */
  parentId: string;
  initialChildren: PublicWorkItemTreeRowDto[];
  initialHasMore: boolean;
  total: number;
}) {
  const t = useTranslations('publicProjects');
  const itemsBase = `/p/${encodeURIComponent(identifier)}/items`;
  const [rows, setRows] = useState(initialChildren);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ parentId, offset: String(rows.length) });
      const url = `/api/public/p/${encodeURIComponent(identifier)}/tree?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const level = (await res.json()) as PublicTreeLevelDto;
      setRows((prev) => [...prev, ...level.rows]);
      setHasMore(level.hasMore);
    } finally {
      setLoading(false);
    }
  }, [hasMore, loading, parentId, rows.length, identifier]);

  return (
    <div>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <li key={row.id}>
            <ChildRow row={row} itemsBase={itemsBase} />
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          className="mt-3 inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-[12.5px] font-medium text-(--el-link) transition-colors hover:text-(--el-link-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          )}
          {loading ? t('treeLoadingChildren') : t('treeLoadMoreChildren')}
          <span className="text-(--el-text-faint)">
            {t('treeShowingCount', { loaded: rows.length, total })}
          </span>
        </button>
      ) : null}
    </div>
  );
}
