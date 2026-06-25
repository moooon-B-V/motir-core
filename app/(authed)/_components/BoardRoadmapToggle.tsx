'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Columns2, Map } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// The Board ↔ Roadmap view toggle (Subtask 7.20.5 / MOTIR-1011) — the ACCESS PATH
// from the roadmap design (`design/roadmap`, sheet 1): a segmented control that
// switches the project's work between the Kanban board (`/boards`) and the roadmap
// canvas (`/roadmap`). It adds NO primary-nav entry — the roadmap is reached via
// this toggle on the board, and back. Mounted in BOTH page headers so the active
// view is always one tap from the other.
//
// Rendered as real <Link>s (NOT onClick buttons) so each view is keyboard-reachable
// and middle/⌘-clickable (mistake #1306 — a navigating control must be an anchor),
// with the active segment carrying `aria-current="page"`. Styled to MATCH the
// shipped `Segmented` track (`components/ui/Segmented.tsx`) so it reads as one
// control — colour via `--el-*`, shape via element-semantic tokens — but it
// NAVIGATES rather than toggling local state.

export type BoardRoadmapView = 'board' | 'roadmap';

const SEGMENTS: {
  view: BoardRoadmapView;
  href: string;
  icon: typeof Columns2;
  labelKey: 'toggleBoard' | 'toggleRoadmap';
}[] = [
  { view: 'board', href: '/boards', icon: Columns2, labelKey: 'toggleBoard' },
  { view: 'roadmap', href: '/roadmap', icon: Map, labelKey: 'toggleRoadmap' },
];

export function BoardRoadmapToggle({ current }: { current: BoardRoadmapView }) {
  const t = useTranslations('roadmap');
  return (
    <div
      role="group"
      aria-label={t('toggleAria')}
      className="inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5"
    >
      {SEGMENTS.map(({ view, href, icon: Icon, labelKey }) => {
        const active = view === current;
        return (
          <Link
            key={view}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // The segment radius nests inside the track's 2px (`p-0.5`) inset —
              // `--radius-btn - 2px` — so it fits the shell at any style (the same
              // nesting Segmented uses).
              'inline-flex h-(--height-control) items-center gap-1.5 rounded-[calc(var(--radius-btn)-2px)] px-(--spacing-control-x) text-[13px] font-medium transition-colors',
              'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
              active
                ? 'bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle)'
                : 'text-(--el-text-secondary) hover:text-(--el-text)',
            )}
          >
            <Icon
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                active ? 'text-(--el-tabnav-active)' : 'text-(--el-text-faint)',
              )}
              aria-hidden
            />
            {t(labelKey)}
          </Link>
        );
      })}
    </div>
  );
}
