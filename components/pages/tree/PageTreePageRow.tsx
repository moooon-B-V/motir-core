'use client';

import type { ReactNode, Ref } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight, NotebookText } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
  CHEVRON_CLASS,
  TREE_ROW_SELECTED_CLASS,
  treeRowClass,
  type PageTreeDensity,
  type PageTreePageRowDto,
  type TreeItemProps,
} from './pageTreeRow';

// A PAGE ROW of the `/pages` tree (Story MOTIR-5753 · MOTIR-7373) —
// `design/pages/pages--tree.mock.html` panels 1–2, `design-notes.md` § The page
// tree, "Page row". The rail's `NotebookText` glyph, then the title as a LINK to
// `/pages/<id>` — the writer's own words, never translated; an untitled page
// reads _Untitled_ in italic secondary ink, so it is still a findable row. No
// "Edited…" line: the tree is in position order, not recency.
//
// A page with sub-pages has a chevron that expands them; a page with none has
// only the reserved 16px slot, so titles stay aligned. The chevron and the link
// are out of the tab order — the treeitem is the one tab stop, and its keys
// (Enter opens, arrows expand) operate both (`PageTree`).
//
// The menu is `PageRowMenu`, built by the tree: New sub-page (MOTIR-7373), then
// Move to… | Move up · Move down (MOTIR-7374), anchoring the Move to… picker. A
// reader without `page:edit` gets no menu (panel 8).
//
// SELECTED (MOTIR-7375, `page--tree-sidebar.mock.html` panel 1): the page being
// read, in the page route's sidebar — `aria-selected`, the rail's active-row
// treatment, its glyph in `--el-icon-active`, and the link `aria-current="page"`.

export interface PageTreePageRowProps {
  row: PageTreePageRowDto;
  item: TreeItemProps;
  /** The treeitem element — the tree measures it and moves focus to it. */
  itemRef: Ref<HTMLDivElement>;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  /** The title link — the tree's Enter key clicks it. */
  linkRef: Ref<HTMLAnchorElement>;
  /** The row menu, as the tree built it; `null` draws none (a reader without `page:edit`). */
  menu: ReactNode | null;
  /** Whether this is the page being read (the sidebar's selected row). */
  selected?: boolean;
  /** Row metrics and chrome: `/pages`' rows, or the sidebar's compact ones. */
  density?: PageTreeDensity;
}

export function PageTreePageRow({
  row,
  item,
  itemRef,
  expanded,
  busy,
  onToggle,
  linkRef,
  menu,
  selected = false,
  density = 'default',
}: PageTreePageRowProps) {
  const t = useTranslations('pages');
  const title = row.title || t('untitled');
  return (
    <div
      ref={itemRef}
      role="treeitem"
      aria-level={item.depth}
      aria-selected={selected}
      aria-expanded={row.hasChildren ? expanded : undefined}
      aria-busy={busy || undefined}
      aria-label={title}
      tabIndex={item.tabIndex}
      onKeyDown={item.onKeyDown}
      onFocus={item.onFocus}
      data-testid="page-tree-page"
      className={cn(treeRowClass(density), selected && TREE_ROW_SELECTED_CLASS)}
      style={item.style}
    >
      {row.hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={
            expanded ? t('tree.collapseAria', { title }) : t('tree.expandAria', { title })
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className={CHEVRON_CLASS}
        >
          <ChevronRight
            className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')}
            aria-hidden
          />
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden />
      )}
      <NotebookText
        className={cn(
          'h-4 w-4 shrink-0',
          selected ? 'text-(--el-icon-active)' : 'text-(--el-icon-muted)',
        )}
        aria-hidden
      />
      <Link
        ref={linkRef}
        href={`/pages/${encodeURIComponent(row.id)}`}
        tabIndex={-1}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'min-w-0 truncate hover:underline focus-visible:outline-none',
          row.title ? 'text-(--el-text)' : 'text-(--el-text-secondary) italic',
        )}
      >
        {title}
      </Link>
      {menu}
    </div>
  );
}
