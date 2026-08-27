'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { SectionLabel } from '@/components/ui/SectionLabel';

// The rail's eyebrow ink. `SectionLabel`'s default is `--el-text-eyebrow`,
// which maps to the SAME Tier-0 base as `--el-text-muted`
// (`tests/theme/iconTextSurfaceTokens.test.ts` pins that deliberately) — so it
// inherits muted's ceiling: AA on the white page/card only, failing on any
// tint. This rail is `--el-sidebar-bg` (= `--color-surface`), where muted
// measures 4.17:1, and the widened /docs sweep measured all nine of these
// labels failing (MOTIR-2482). `components/ui/Sidebar.tsx` already overrides
// the same way for the same reason; the token itself is not retargeted here
// because that mapping is a pinned, deliberate decision of its own.
const RAIL_EYEBROW = 'text-(--el-text-secondary)';
import type { ReferenceGroup } from '@/lib/apiDocs/reference';
import { DOC_SURFACES, DOC_SURFACE_ROUTES, type DocsSurfaceKey } from '@/lib/apiDocs/surfaces';
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

/**
 * Which docs page is being read — the nav's `aria-current` target.
 *
 * The four SURFACE keys come from `lib/apiDocs/surfaces.ts`, which both this
 * rail and the `/docs` index read (Amendment 19 Q3); the three below them are
 * pages INSIDE a surface, which only navigation cares about.
 */
export type DocsPage = DocsSurfaceKey | 'gettingStarted' | 'stability' | 'mcpTools';

/**
 * Every docs page's route. This is the SINGLE fact the rail reads: which tier a
 * page sits in, and whether it shows the operation index, are both derived from
 * the prefix below rather than passed in alongside it.
 *
 * The surface routes are SPREAD from the shared list rather than re-typed, so a
 * surface's address is stated exactly once in the repository.
 */
const ROUTE_BY_PAGE: Record<DocsPage, string> = {
  ...DOC_SURFACE_ROUTES,
  gettingStarted: '/docs/api/getting-started',
  stability: '/docs/api/stability',
  mcpTools: '/docs/mcp/tools',
};

/** The API sub-area's prefix — Amendment 11 Q1's route table. */
const API_AREA = '/docs/api';

/** True when `page` is the API sub-area's index or one of its pages. */
export function isInApiArea(page: DocsPage): boolean {
  return ROUTE_BY_PAGE[page].startsWith(API_AREA);
}

/**
 * A sub-area — a surface with MORE THAN ONE page, so it earns a second tier
 * (Amendment 11 Q1's tier table, Q4's placement rule).
 *
 * ⚠️ This list was `apiPages`, a bare array, when the API was the only sub-area
 * there was. **Amendment 13 Q1 made the MCP the second**, and generalising was
 * the honest fix rather than a second hard-coded array: the tier is now "the
 * CURRENT sub-area's pages" for whatever sub-area the route falls in, which is
 * what Amendment 11 Q1 described all along. A third sub-area is a row here.
 *
 * `pages` deliberately EXCLUDES the sub-area's index — that page is its row in
 * tier 1, and listing it twice would be two rows to the same place.
 */
const SUB_AREAS: readonly {
  prefix: string;
  /** The `apiDocs` key for the tier's heading — the SURFACE's name. */
  headingKey: string;
  pages: readonly { key: DocsPage; labelKey: string }[];
}[] = [
  {
    prefix: API_AREA,
    headingKey: 'navReference',
    pages: [
      { key: 'gettingStarted', labelKey: 'navGettingStarted' },
      { key: 'stability', labelKey: 'navStability' },
    ],
  },
  {
    prefix: '/docs/mcp',
    headingKey: 'navMcp',
    pages: [{ key: 'mcpTools', labelKey: 'navMcpTools' }],
  },
];

/**
 * The sub-area a page belongs to, decided by its ROUTE PREFIX and nothing else
 * (Amendment 11 Q2) — never a per-page prop four call sites can disagree about.
 * A single-page surface matches nothing here and gets no second tier, which is
 * why the sandbox guide still adds nothing below.
 */
export function subAreaFor(page: DocsPage): (typeof SUB_AREAS)[number] | undefined {
  const route = ROUTE_BY_PAGE[page];
  return SUB_AREAS.find((area) => route.startsWith(area.prefix));
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
  //
  // ⚠️ This list was four literals here until MOTIR-2522. It is now DERIVED from
  // `lib/apiDocs/surfaces.ts`, because the `/docs` index renders the same four
  // surfaces and two hand-maintained lists of one fact drift silently (Amendment
  // 19 Q3). The rendered rows, their order and their labels are unchanged —
  // `tests/api-docs/docs-rail-tiers.test.tsx` is the proof, and it did not move.
  //
  // What each row still is, for the reader of this file: the API reference; Story
  // MOTIR-2268's sandbox guide, whose only entrance this is and whose way BACK to
  // the API it also is (design Panel 10, ①); Story MOTIR-2308's CLI guide, ONE
  // page so no second tier (Amendment 12 Q1); and Story MOTIR-2309's MCP
  // documentation, the second sub-area, so both a row here and a tier below
  // (`design/mcp-server/` Panel 6). Adding a surface is one entry in that module.
  const surfaces: NavRow[] = DOC_SURFACES.map((surface) => ({
    key: surface.key,
    href: surface.route,
    label: t(surface.labelKey),
  }));

  // TIER 2 — the current sub-area's own pages, minus its index (which is tier 1's
  // row, so listing it twice would be two rows to the same place). Derived from
  // the route prefix, so a sub-area added to SUB_AREAS gets its tier with no
  // change here and a single-page surface gets none.
  const subArea = subAreaFor(current);
  const subAreaPages: NavRow[] =
    subArea?.pages.map((page) => ({
      key: page.key,
      href: ROUTE_BY_PAGE[page.key],
      label: t(page.labelKey),
    })) ?? [];

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
          <p className="mt-2 pl-(--spacing-control-x) text-[11.5px] text-(--el-text-secondary)">
            {query.trim() ? t('findCount', { shown, total }) : t('operationCount', { total })}
          </p>
        </>
      )}

      {/* TIER 1 — the surfaces. Always rendered: it is how a reader on any page
          in the area learns what else the area holds, and on a guide page it is
          the whole rail. */}
      <div className="mt-4" data-testid="catalogue-surfaces">
        <SectionLabel className={RAIL_EYEBROW}>{t('navDocumentation')}</SectionLabel>
        <div className="mt-1.5 flex flex-col">{surfaces.map(renderRow)}</div>
      </div>

      {/* TIER 2 — this sub-area's own pages. Gated on the route prefix, so a
          single-page surface renders nothing here and a future sub-area gets its
          own tier by adding a SUB_AREAS row, not a prop. */}
      {subArea && (
        <div
          className="mt-4"
          data-testid={`catalogue-subarea-${subArea.prefix.replace('/docs/', '')}`}
        >
          <SectionLabel className={RAIL_EYEBROW}>{t(subArea.headingKey)}</SectionLabel>
          <div className="mt-1.5 flex flex-col">{subAreaPages.map(renderRow)}</div>
        </div>
      )}

      {filtered.map((group) => (
        <div key={group.key} className="mt-4" data-testid={`catalogue-group-${group.key}`}>
          <SectionLabel className={RAIL_EYEBROW}>{group.label}</SectionLabel>
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
        <p className="mt-4 px-(--spacing-control-x) text-[12.5px] text-(--el-text-secondary)">
          {t('findEmpty', { query: query.trim() })}
        </p>
      )}
    </nav>
  );
}
