'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import type { TriageQueueItemDto } from '@/lib/dto/triage';
import { TriageRow } from './TriageRow';

// The left queue pane of the triage inbox (Subtask 6.11.6) — the head caption +
// a client-side search over the LOADED rows + the row list + a "Load older"
// foot that the parent uses to fetch + append the next cursor page (finding #57
// — cursor-forward infinite append, never load-all). The total-count pager the
// mock draws is intentionally NOT rendered: the shipped read is cursor-only with
// no total COUNT, so "Load older" is the honest paginated affordance (justified
// rung-2 deviation; still newest-first + paginated, which the AC requires).

export interface TriageQueueProps {
  items: TriageQueueItemDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export function TriageQueue({
  items,
  selectedId,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
}: TriageQueueProps) {
  const t = useTranslations('triage');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const haystack = `${item.identifier} ${item.title} ${item.descriptionSnippet ?? ''} ${
        item.submitter.name ?? ''
      }`.toLowerCase();
      return haystack.includes(q);
    });
  }, [items, query]);

  return (
    <div className="flex min-h-0 flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel label={t('queueLabel')} />
        <span className="text-xs tabular-nums text-(--el-text-faint)">{items.length}</span>
      </div>

      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchAria')}
        addonStart={<Search className="h-4 w-4 text-(--el-text-faint)" aria-hidden />}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-(--el-text-muted)">
            {t('noSearchResults')}
          </p>
        ) : (
          filtered.map((item) => (
            <TriageRow
              key={item.id}
              item={item}
              active={item.id === selectedId}
              onSelect={onSelect}
            />
          ))
        )}

        {hasMore && query.trim() === '' ? (
          <div className="px-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              loading={loadingMore}
              onClick={onLoadMore}
              className="w-full"
            >
              {loadingMore ? t('loadingMore') : t('loadOlder')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
