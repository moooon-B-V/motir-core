'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { PLATFORM_LESSON_MISTAKE_TYPES } from '@/lib/dto/platformLessons';
import { useLessonTypeLabel } from './LessonBits';
import { FILTER_KEYS, type FilterKey } from './filterKeys';

/**
 * The FILTER BAR — design Panels 1–2. Every filter lives in the URL, because the
 * server must answer a filter change (a different query to motir-ai), so each
 * change is a `router.push` and resets the pager to page 1. Each set filter also
 * becomes a removable chip under the bar.
 */

const ANY = '';

export interface LessonFiltersProps {
  organizations: { id: string; name: string }[];
  categories: string[];
}

export function LessonFilters({ organizations, categories }: LessonFiltersProps) {
  const t = useTranslations('platformAdmin.lessons.filter');
  const typeLabel = useLessonTypeLabel();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');

  function push(next: Partial<Record<FilterKey, string>>) {
    const url = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = key in next ? next[key] : params.get(key);
      if (value) url.set(key, value);
    }
    // A filter change starts the cursor walk over.
    const qs = url.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const scopeOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('scopeAll') },
    { value: 'global', label: t('scopeGlobal') },
    { value: 'tenant', label: t('scopeTenant') },
  ];
  const typeOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('typeAny') },
    ...PLATFORM_LESSON_MISTAKE_TYPES.map((type) => ({ value: type, label: typeLabel(type) })),
  ];
  const categoryOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('categoryAny') },
    ...categories.map((c) => ({ value: c, label: c })),
  ];
  const orgOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('orgAny') },
    ...organizations.map((o) => ({ value: o.id, label: o.name })),
  ];
  const stateOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('stateAll') },
    { value: 'on', label: t('stateOn') },
    { value: 'off', label: t('stateOff') },
  ];

  const chips: { key: FilterKey; label: string; value: string }[] = [];
  const pick = (options: ComboboxOption<string>[], value: string | null) =>
    options.find((o) => o.value === value)?.label ?? value ?? '';
  if (params.get('q')) chips.push({ key: 'q', label: t('search'), value: params.get('q')! });
  if (params.get('scope'))
    chips.push({ key: 'scope', label: t('scope'), value: pick(scopeOptions, params.get('scope')) });
  if (params.get('type'))
    chips.push({ key: 'type', label: t('type'), value: pick(typeOptions, params.get('type')) });
  if (params.get('category'))
    chips.push({ key: 'category', label: t('category'), value: params.get('category')! });
  if (params.get('org'))
    chips.push({ key: 'org', label: t('org'), value: pick(orgOptions, params.get('org')) });
  if (params.get('state'))
    chips.push({ key: 'state', label: t('state'), value: pick(stateOptions, params.get('state')) });

  return (
    <div className="flex flex-col gap-3">
      <div role="search" aria-label={t('label')} className="flex flex-wrap items-end gap-2">
        <form
          className="min-w-[14rem] flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            push({ q: query.trim() });
          }}
        >
          <Input
            label={t('search')}
            placeholder={t('searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            addonStart={<Search aria-hidden className="h-4 w-4" />}
            data-testid="lessons-filter-search"
          />
        </form>
        <Filter
          label={t('scope')}
          options={scopeOptions}
          value={params.get('scope')}
          onPick={(v) => push({ scope: v })}
        />
        <Filter
          label={t('type')}
          options={typeOptions}
          value={params.get('type')}
          onPick={(v) => push({ type: v })}
        />
        <Filter
          label={t('category')}
          options={categoryOptions}
          value={params.get('category')}
          onPick={(v) => push({ category: v })}
          searchable
        />
        <Filter
          label={t('org')}
          options={orgOptions}
          value={params.get('org')}
          onPick={(v) => push({ org: v })}
          searchable
        />
        <Filter
          label={t('state')}
          options={stateOptions}
          value={params.get('state')}
          onPick={(v) => push({ state: v })}
        />
      </div>
      {chips.length > 0 ? (
        <div
          data-testid="lessons-filter-chips"
          className="flex flex-wrap items-center gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs text-(--el-text-secondary)"
        >
          <span>{t('count', { n: chips.length })}</span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-(--radius-badge) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-(--el-text)"
            >
              {chip.label}: {chip.value}
              <button
                type="button"
                aria-label={t('remove', { filter: chip.label })}
                className="rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text)"
                onClick={() => {
                  if (chip.key === 'q') setQuery('');
                  push({ [chip.key]: '' });
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
              router.push(pathname);
            }}
          >
            {t('clearAll')}
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
  value: string | null;
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
