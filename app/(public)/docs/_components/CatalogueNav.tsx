'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { SectionLabel } from '@/components/ui/SectionLabel';
import type { ReferenceGroup } from '@/lib/apiDocs/reference';
import { MethodPill } from './MethodPill';

// The docs catalogue rail (Story 11.4 · Subtask 11.4.7 — MOTIR-2188; regrouped
// by MOTIR-2312 under MOTIR-2307; design `design/api-docs/` Panels 10–12).
//
// ── TWO TIERS, and the ROUTE PREFIX is what decides ─────────────────────────
// ADR `public-api-conventions.md` Amendment 11 Q1 makes `/docs` a set of
// SUB-AREAS, one per surface Motir documents. So the rail is:
//
//   1. `Documentation` — one row per SURFACE (API reference, Agent sandbox, and
//      later the CLI and the MCP). Renders on every page in the area.
//   2. the surface's own name — that surface's other pages. Renders only INSIDE
//      that surface.
//   3. the resource groups — the operation rows. Only inside the API.
//
// ⚠️ Tiers 2 and 3 are gated on `ROUTE_BY_PAGE[current]` starting with
// `/docs/api` — the PREFIX, never a per-page prop (Amendment 11 Q2). One fact
// decides both which sub-area a page belongs to and what its rail shows, so the
// two cannot drift apart, and a page added anywhere else cannot acquire the
// operation index by accident. That accident is exactly what this replaced: the
// flat four-row group rendered all ~28 operations on the agent sandbox guide,
// which is about running a container and not about the API at all (MOTIR-2307).
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
export type DocsPage = 'reference' | 'gettingStarted' | 'stability' | 'sandbox';

/**
 * Every docs page's route. This is the SINGLE fact the rail reads: which tier a
 * page sits in, and whether it shows the operation index, are both derived from
 * the prefix below rather than passed in alongside it.
 */
const ROUTE_BY_PAGE: Record<DocsPage, string> = {
  reference: '/docs/api',
  gettingStarted: '/docs/api/getting-started',
  stability: '/docs/api/stability',
  sandbox: '/docs/sandbox',
};

/** The API sub-area's prefix — Amendment 11 Q1's route table. */
const API_AREA = '/docs/api';

/** True when `page` is the API sub-area's index or one of its pages. */
export function isInApiArea(page: DocsPage): boolean {
  return ROUTE_BY_PAGE[page].startsWith(API_AREA);
}

export function CatalogueNav({
  current,
  groups = [],
}: {
  current: DocsPage;
  /**
   * The operation groups, for pages inside the API sub-area. Empty when the spec
   * could not be built — the rail still renders its page rows. Omitted entirely
   * by pages outside the API, which have no operation index; the prefix gate
   * below means passing them anyway still renders nothing.
   */
  groups?: ReferenceGroup[];
}) {
  const t = useTranslations('apiDocs');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // THE gate. Everything the API sub-area owns hangs off this one expression.
  const inApiArea = isInApiArea(current);
  // Memoized so the two `useMemo`s below keep a stable dependency: the `[]` arm
  // is a fresh array each render, which would invalidate them every time.
  const operationGroups = useMemo(() => (inApiArea ? groups : []), [inApiArea, groups]);

  const total = useMemo(
    () => operationGroups.reduce((sum, group) => sum + group.operations.length, 0),
    [operationGroups],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return operationGroups;
    return operationGroups
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
  }, [operationGroups, query]);

  const shown = filtered.reduce((sum, group) => sum + group.operations.length, 0);

  type NavRow = { key: DocsPage; href: string; label: string };

  // TIER 1 — the SURFACES. One row each, pointing at that surface's index page.
  // A surface with one page is one row and gets no second tier, which is why the
  // sandbox guide adds nothing below.
  const surfaces: NavRow[] = [
    { key: 'reference', href: ROUTE_BY_PAGE.reference, label: t('navReference') },
    // Story MOTIR-2268's setup guide. This row is the page's ONLY entrance —
    // nothing else in the product routes to it — and since MOTIR-2312 it is also
    // the way BACK to the API for a reader standing on it (design Panel 10, ①).
    { key: 'sandbox', href: ROUTE_BY_PAGE.sandbox, label: t('navSandbox') },
  ];

  // TIER 2 — the current sub-area's own pages, minus its index (which is tier 1's
  // row, so listing it twice would be two rows to the same place).
  const apiPages: NavRow[] = [
    {
      key: 'gettingStarted',
      href: ROUTE_BY_PAGE.gettingStarted,
      label: t('navGettingStarted'),
    },
    { key: 'stability', href: ROUTE_BY_PAGE.stability, label: t('navStability') },
  ];

  const rowClass = (isCurrent: boolean) =>
    isCurrent
      ? 'flex h-(--height-control) items-center gap-2 rounded-(--radius-control) bg-(--el-sidebar-item-bg-active) px-(--spacing-control-x) text-[13px] font-semibold text-(--el-text) shadow-(--shadow-subtle)'
      : 'flex h-(--height-control) items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-[13px] text-(--el-text-secondary) hover:bg-(--el-sidebar-item-bg-hover)';

  // Only the page the reader is ON is `aria-current` — unchanged from before the
  // regrouping. Tier 2's PRESENCE, and its heading naming the surface, are the
  // "you are here" signal for the sub-area, so no new state was needed (design
  // § "Three details, resolved here rather than left to the implementer").
  const renderRow = (row: NavRow) => (
    <Link
      key={row.key}
      href={row.href}
      {...(row.key === current ? { 'aria-current': 'page' as const } : {})}
      className={rowClass(row.key === current)}
    >
      {row.label}
    </Link>
  );

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

      {/* TIER 1 — the surfaces. Always rendered: it is how a reader on any page
          in the area learns what else the area holds, and on a guide page it is
          the whole rail. */}
      <div className="mt-4" data-testid="catalogue-surfaces">
        <SectionLabel>{t('navDocumentation')}</SectionLabel>
        <div className="mt-1.5 flex flex-col">{surfaces.map(renderRow)}</div>
      </div>

      {/* TIER 2 — this sub-area's own pages. Gated on the route prefix, so a
          surface that is not the API renders nothing here and a future sub-area
          gets its own tier by adding a route, not a prop. */}
      {inApiArea && (
        <div className="mt-4" data-testid="catalogue-subarea-api">
          <SectionLabel>{t('navReference')}</SectionLabel>
          <div className="mt-1.5 flex flex-col">{apiPages.map(renderRow)}</div>
        </div>
      )}

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
