'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { SectionLabel } from '@/components/ui/SectionLabel';
import type { ReferenceGroup } from '@/lib/apiDocs/reference';
import { MethodPill } from './MethodPill';

// The docs catalogue rail (Story 11.4 · Subtask 11.4.7 — MOTIR-2188; design
// Panels 1, 3–5).
//
// The three PAGES are the top group in the SAME nav as the operations, which is
// what makes the reference, the guide and the policy read as one surface rather
// than three that happen to look alike (design § "The shell").
//
// A client component because of ONE interaction: the find. Everything else on
// this surface is text and renders on the server. The operation list is small,
// static, already-serializable data, so passing it as props costs a few KB and
// buys an instant filter with no round trip.
//
// ⚠️ THE FILTER KEEPS ITS GROUP HEADINGS (design Panel 3). Matching operations
// stay under the resource they belong to, so a reader learns where an operation
// LIVES rather than only that it exists — and the count line is the honest
// signal at 28 operations and rising.

/** Which docs page is being read — the nav's `aria-current` target. */
export type DocsPage = 'reference' | 'gettingStarted' | 'stability';

export function CatalogueNav({
  current,
  groups,
}: {
  current: DocsPage;
  /** Empty when the spec could not be built — the rail still renders the pages. */
  groups: ReferenceGroup[];
}) {
  const t = useTranslations('apiDocs');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.operations.length, 0),
    [groups],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        // Match the summary, the path AND the verb: a reader looking for a write
        // types "post" as readily as they type the resource name.
        operations: group.operations.filter((operation) =>
          `${operation.method} ${operation.path} ${operation.summary}`
            .toLowerCase()
            .includes(needle),
        ),
      }))
      .filter((group) => group.operations.length > 0);
  }, [groups, query]);

  const shown = filtered.reduce((sum, group) => sum + group.operations.length, 0);

  const pages: { key: DocsPage; href: string; label: string }[] = [
    { key: 'reference', href: '/api-docs', label: t('navReference') },
    { key: 'gettingStarted', href: '/api-docs/getting-started', label: t('navGettingStarted') },
    { key: 'stability', href: '/api-docs/stability', label: t('navStability') },
  ];

  return (
    <nav
      aria-label={t('navLabel')}
      className="w-full flex-none border-(--el-border) bg-(--el-sidebar-bg) px-3 pt-4 pb-6 lg:w-[264px] lg:border-r"
    >
      {total > 0 && (
        <>
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
            }}
            aria-label={t('findLabel')}
            placeholder={t('findPlaceholder')}
          />
          <p className="mt-2 pl-(--spacing-control-x) text-[11.5px] text-(--el-text-faint)">
            {query.trim() ? t('findCount', { shown, total }) : t('operationCount', { total })}
          </p>
        </>
      )}

      <div className="mt-4">
        <SectionLabel>{t('navDocumentation')}</SectionLabel>
        <div className="mt-1.5 flex flex-col">
          {pages.map((page) => (
            <Link
              key={page.key}
              href={page.href}
              {...(page.key === current ? { 'aria-current': 'page' as const } : {})}
              className={
                page.key === current
                  ? 'flex h-(--height-control) items-center gap-2 rounded-(--radius-control) bg-(--el-sidebar-item-bg-active) px-(--spacing-control-x) text-[13px] font-semibold text-(--el-text) shadow-(--shadow-subtle)'
                  : 'flex h-(--height-control) items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-[13px] text-(--el-text-secondary) hover:bg-(--el-sidebar-item-bg-hover)'
              }
            >
              {page.label}
            </Link>
          ))}
        </div>
      </div>

      {filtered.map((group) => (
        <div key={group.key} className="mt-4" data-testid={`catalogue-group-${group.key}`}>
          <SectionLabel>{group.label}</SectionLabel>
          <div className="mt-1.5 flex flex-col">
            {group.operations.map((operation) => (
              <a
                key={operation.id}
                href={`#${operation.id}`}
                data-operation-id={operation.id}
                className="flex h-(--height-control) items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-[13px] text-(--el-text-secondary) hover:bg-(--el-sidebar-item-bg-hover)"
              >
                <MethodPill method={operation.method} />
                <span className="truncate">{operation.summary}</span>
              </a>
            ))}
          </div>
        </div>
      ))}

      {total > 0 && shown === 0 && (
        <p className="mt-4 px-(--spacing-control-x) text-[12.5px] text-(--el-text-muted)">
          {t('findEmpty', { query: query.trim() })}
        </p>
      )}
    </nav>
  );
}
