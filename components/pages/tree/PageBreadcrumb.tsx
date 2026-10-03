'use client';

import { Fragment, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight, Ellipsis, Folder, NotebookText } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import type { PageTrailDto } from '@/lib/dto/pages';

// THE PAGE'S BREADCRUMB (Story MOTIR-5753 · MOTIR-7375) —
// `design/pages/page--tree-sidebar.mock.html` panels 1, 2 and 4, `design-notes.md`
// § The page tree, "The page — sidebar and breadcrumb". It replaces the base's
// "← Pages" link, so it ALWAYS starts with **Pages** — a root page keeps its way
// back.
//
// Root-first: Pages › folders › ancestor pages › this page, from
// `pagesService.getPageTrail` (MOTIR-7370). Every segment but the last is a link
// in `--el-text-secondary`: a FOLDER has no page of its own, so it links to
// `/pages?folder=<id>` — the tree opened to it (panel 4) — and carries the Folder
// glyph with an sr-only "Folder:"; a PAGE links to that page. The last segment
// is this page: `--el-text`, 500, `aria-current="page"`, not a link.
//
// MIDDLE TRUNCATION (panel 2): over five segments (Pages and the page counted),
// keep Pages, the first segment, the parent and the page, and fold everything
// between into one "…" button that opens a menu of the hidden segments,
// root-first, each a link. Truncation is by COUNT, not kind — folders and pages
// together can reach any depth. Each segment truncates at 180px (the page at
// 220px) with its full text in `title`.

/** Over this many segments, the middle folds into "…". */
export const BREADCRUMB_MAX_SEGMENTS = 5;

/** One step of the trail. */
export interface BreadcrumbSegment {
  kind: 'root' | 'folder' | 'page';
  /** The folder's or page's id; empty for the root. */
  id: string;
  label: string;
  href: string;
}

/**
 * The trail's segments, root-first, ending at the parent — the page itself is
 * drawn separately. An untitled ancestor reads `untitled`.
 */
export function breadcrumbSegments(
  trail: PageTrailDto | null,
  rootLabel: string,
  untitled: string,
): BreadcrumbSegment[] {
  return [
    { kind: 'root', id: '', label: rootLabel, href: '/pages' },
    ...(trail?.folders ?? []).map(
      (f): BreadcrumbSegment => ({
        kind: 'folder',
        id: f.id,
        label: f.name,
        href: `/pages?folder=${encodeURIComponent(f.id)}`,
      }),
    ),
    ...(trail?.pages ?? []).map(
      (p): BreadcrumbSegment => ({
        kind: 'page',
        id: p.id,
        label: p.title || untitled,
        href: `/pages/${encodeURIComponent(p.id)}`,
      }),
    ),
  ];
}

/**
 * Which of `segments` (the page excluded) are shown and which fold into "…".
 * With the page counted, a chain of more than five keeps Pages, the first
 * segment and the parent.
 */
export function foldSegments(segments: BreadcrumbSegment[]): {
  head: BreadcrumbSegment[];
  hidden: BreadcrumbSegment[];
  tail: BreadcrumbSegment[];
} {
  if (segments.length + 1 <= BREADCRUMB_MAX_SEGMENTS) {
    return { head: segments, hidden: [], tail: [] };
  }
  return {
    head: segments.slice(0, 2),
    hidden: segments.slice(2, -1),
    tail: segments.slice(-1),
  };
}

export interface PageBreadcrumbProps {
  /** The page's trail, root-first; `null` when it could not be read (Pages › page). */
  trail: PageTrailDto | null;
  /** The page being read. */
  page: { id: string; title: string };
}

const SEGMENT_LINK =
  'inline-flex max-w-[180px] min-w-0 items-center gap-1 rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function PageBreadcrumb({ trail, page }: PageBreadcrumbProps) {
  const t = useTranslations('pages');
  const segments = breadcrumbSegments(trail, t('index.title'), t('untitled'));
  const { head, hidden, tail } = foldSegments(segments);
  const title = page.title || t('untitled');

  const separator = (
    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
  );
  const segment = (s: BreadcrumbSegment) => (
    <Fragment key={`${s.kind}:${s.id}`}>
      <li className="flex min-w-0 items-center">
        <Link href={s.href} title={s.label} className={SEGMENT_LINK}>
          {s.kind === 'folder' ? (
            <>
              <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="sr-only">{t('tree.breadcrumb.folder')}</span>
            </>
          ) : null}
          <span className="truncate">{s.label}</span>
        </Link>
      </li>
      <li aria-hidden className="flex items-center">
        {separator}
      </li>
    </Fragment>
  );

  return (
    <nav aria-label={t('tree.breadcrumb.label')} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
        {head.map(segment)}
        {hidden.length > 0 ? (
          <>
            <li className="flex items-center">
              <HiddenSegments segments={hidden} />
            </li>
            <li aria-hidden className="flex items-center">
              {separator}
            </li>
          </>
        ) : null}
        {tail.map(segment)}
        <li className="flex min-w-0 items-center">
          <span
            aria-current="page"
            title={title}
            className={cn(
              'max-w-[220px] truncate font-medium',
              page.title ? 'text-(--el-text)' : 'text-(--el-text-secondary) italic',
            )}
          >
            {title}
          </span>
        </li>
      </ol>
    </nav>
  );
}

/** The "…" button and its menu of the folded segments, root-first. */
function HiddenSegments({ segments }: { segments: BreadcrumbSegment[] }) {
  const t = useTranslations('pages.tree.breadcrumb');
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = t('more', { count: segments.length });

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLAnchorElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % all.length;
    else if (e.key === 'ArrowUp') next = at <= 0 ? all.length - 1 : at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next >= 0) {
      e.preventDefault();
      all[next]?.focus();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={label}
        title={label}
        className={cn(
          'inline-flex h-6 items-center justify-center rounded-(--radius-control) px-(--spacing-icon-btn) text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
          open && 'bg-(--el-border-soft) text-(--el-text)',
        )}
      >
        <Ellipsis className="h-4 w-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Content
        width={240}
        className="p-1"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          items()[0]?.focus();
        }}
      >
        <div ref={menuRef} role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {segments.map((s) => {
            const Icon = s.kind === 'folder' ? Folder : NotebookText;
            return (
              <Link
                key={`${s.kind}:${s.id}`}
                href={s.href}
                role="menuitem"
                title={s.label}
                onClick={() => setOpen(false)}
                className="flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-[13px] text-(--el-text) hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none"
              >
                <Icon className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
                <span className="flex-1 truncate">{s.label}</span>
              </Link>
            );
          })}
        </div>
      </Popover.Content>
    </Popover>
  );
}
