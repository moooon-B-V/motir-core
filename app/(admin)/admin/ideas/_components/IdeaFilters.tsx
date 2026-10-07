'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import type { IdeaCategory, IdeaKind } from '@/generated/prisma/client';
import { IDEA_CATEGORIES, IDEA_CATEGORY_LABELS, IDEA_KINDS } from '@/lib/ideas/categories';
import {
  ideaListHref,
  withIdeaFilter,
  type IdeaFilterKey,
  type IdeaListView,
  type IdeaStatusView,
} from './ideaListQuery';

/**
 * The FILTER BAR — design § Ideas Panels 1–2. Every filter lives in the URL,
 * because the server must answer a filter change (a different query to the
 * store), so each change is a `router.push` and starts the pager over. Status is
 * a `Segmented` (Active · Retired · All, default Active); kind, category and tag
 * are `Combobox` triggers; text is submitted from the search box. Every filter
 * in force beyond the default is repeated as a chip that removes only it, and
 * Clear all returns to the default view.
 */

const ANY = '';

export interface IdeaFiltersProps {
  view: IdeaListView;
  tags: { slug: string; label: string }[];
}

export function IdeaFilters({ view, tags }: IdeaFiltersProps) {
  const t = useTranslations('platformAdmin.ideas');
  const router = useRouter();
  const [query, setQuery] = useState(view.q ?? '');

  function go<K extends IdeaFilterKey>(key: K, value: IdeaListView[K] | undefined) {
    router.push(ideaListHref(withIdeaFilter(view, key, value)));
  }

  const kindOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('filter.anyKind') },
    ...IDEA_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) })),
  ];
  const categoryOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('filter.anyCategory') },
    ...IDEA_CATEGORIES.map((c) => ({ value: c, label: IDEA_CATEGORY_LABELS[c] })),
  ];
  const tagOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('filter.anyTag') },
    ...tags.map((tag) => ({ value: tag.slug, label: tag.label })),
  ];
  const pick = (options: ComboboxOption<string>[], value: string | undefined) =>
    options.find((o) => o.value === value)?.label ?? value ?? '';

  const chips: { key: IdeaFilterKey; label: string; value: string }[] = [];
  if (view.q) chips.push({ key: 'q', label: t('search.label'), value: view.q });
  if (view.status !== 'active') {
    chips.push({
      key: 'status',
      label: t('filter.status'),
      value: view.status === 'all' ? t('filter.all') : t('status.retired'),
    });
  }
  if (view.kind) {
    chips.push({ key: 'kind', label: t('filter.kind'), value: pick(kindOptions, view.kind) });
  }
  if (view.category) {
    chips.push({
      key: 'category',
      label: t('filter.category'),
      value: pick(categoryOptions, view.category),
    });
  }
  if (view.tag)
    chips.push({ key: 'tag', label: t('filter.tag'), value: pick(tagOptions, view.tag) });

  return (
    <div className="flex flex-col gap-3">
      <div role="search" aria-label={t('filter.label')} className="flex flex-wrap items-end gap-2">
        <form
          className="min-w-[14rem] flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            go('q', query.trim() || undefined);
          }}
        >
          <Input
            label={t('search.label')}
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            addonStart={<Search aria-hidden className="h-4 w-4" />}
            data-testid="ideas-filter-search"
          />
        </form>
        <div className="flex flex-col gap-1">
          <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
            {t('filter.status')}
          </span>
          <Segmented<IdeaStatusView>
            label={t('filter.status')}
            value={view.status}
            onChange={(value) => go('status', value)}
            options={[
              { value: 'active', label: t('status.active') },
              { value: 'retired', label: t('status.retired') },
              { value: 'all', label: t('filter.all') },
            ]}
          />
        </div>
        <Filter
          label={t('filter.kind')}
          options={kindOptions}
          value={view.kind}
          onPick={(v) => go('kind', (v || undefined) as IdeaKind | undefined)}
        />
        <Filter
          label={t('filter.category')}
          options={categoryOptions}
          value={view.category}
          onPick={(v) => go('category', (v || undefined) as IdeaCategory | undefined)}
          searchable
        />
        <Filter
          label={t('filter.tag')}
          options={tagOptions}
          value={view.tag}
          onPick={(v) => go('tag', v || undefined)}
          searchable
        />
      </div>
      {chips.length > 0 ? (
        <div
          data-testid="ideas-filter-chips"
          className="flex flex-wrap items-center gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs text-(--el-text-secondary)"
        >
          <span>{t('filter.filtered')}</span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-(--radius-badge) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-(--el-text)"
            >
              {chip.label}: {chip.value}
              <button
                type="button"
                aria-label={t('filter.remove', { filter: chip.label })}
                className="rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text)"
                onClick={() => {
                  if (chip.key === 'q') setQuery('');
                  go(chip.key, undefined);
                }}
              >
                <X aria-hidden className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery('');
              router.push(ideaListHref({}));
            }}
          >
            {t('filter.clearAll')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Filter({
  label,
  options,
  value,
  onPick,
  searchable,
}: {
  label: string;
  options: ComboboxOption<string>[];
  value: string | undefined;
  onPick: (value: string) => void;
  searchable?: boolean;
}) {
  return (
    <div className="flex w-44 flex-col gap-1">
      <span className="font-sans text-xs font-medium text-(--el-text-secondary)">{label}</span>
      <Combobox
        label={label}
        options={options}
        value={value ?? ANY}
        onChange={onPick}
        searchable={searchable ?? false}
      />
    </div>
  );
}
