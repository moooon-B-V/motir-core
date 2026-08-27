import Link from 'next/link';
import { BookOpen, Columns3, List, ListTree, Rocket, Route } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils/cn';
import { PublicSubmitRequest } from './PublicSubmitRequest';

// The public read-only sub-bar nav (Story 6.12 · Subtask 6.12.4 · design Panel 2
// `.seg`; extended by Story 8.9 · 8.9.4 with Changelog). Overview / Board / Work
// items / Tree / Roadmap / Changelog as REAL anchor tabs (link-
// based, not the client Segmented control, so the public nav is crawlable and
// each tab is a distinct indexable URL). Styled to match the shipped Segmented
// (`--el-surface` track, raised active option). Plus the "Submit a request"
// control. Server component; colour + shape via --el-* / element-semantic tokens.

export type PublicTab = 'overview' | 'board' | 'items' | 'tree' | 'roadmap' | 'changelog';

export async function PublicTabNav({
  identifier,
  active,
}: {
  identifier: string;
  active: PublicTab;
}) {
  const t = await getTranslations('publicProjects');
  const base = `/p/${encodeURIComponent(identifier)}`;
  const tabs: Array<{ key: PublicTab; href: string; label: string; icon: React.ReactNode }> = [
    {
      key: 'overview',
      href: base,
      label: t('tabOverview'),
      icon: <BookOpen className="h-3.5 w-3.5" />,
    },
    {
      key: 'board',
      href: `${base}/board`,
      label: t('tabBoard'),
      icon: <Columns3 className="h-3.5 w-3.5" />,
    },
    {
      key: 'items',
      href: `${base}/items`,
      label: t('tabWorkItems'),
      icon: <List className="h-3.5 w-3.5" />,
    },
    {
      key: 'tree',
      href: `${base}/tree`,
      label: t('tabTree'),
      icon: <ListTree className="h-3.5 w-3.5" />,
    },
    {
      key: 'roadmap',
      href: `${base}/roadmap`,
      label: t('tabRoadmap'),
      icon: <Route className="h-3.5 w-3.5" />,
    },
    // Changelog sits AFTER Roadmap (Story 8.9 · design Panel A, door 1): the two
    // answer adjacent questions — what is coming, and what shipped — so a reader
    // who has just scanned the roadmap finds the other half next to it.
    {
      key: 'changelog',
      href: `${base}/changelog`,
      label: t('tabChangelog'),
      icon: <Rocket className="h-3.5 w-3.5" />,
    },
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-(--el-border) px-(--spacing-card-padding) py-2.5">
      <nav
        aria-label={t('viewsLabel')}
        className="inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5"
      >
        {tabs.map((tab) => {
          const on = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-[12.5px] font-medium transition-colors',
                'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
                on
                  ? 'bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle)'
                  : 'text-(--el-text-secondary) hover:text-(--el-text)',
              )}
            >
              {/* The icon's ink moved off the tab's `[&_svg]:…` descendant
                  variant and onto the glyph's own wrapper (MOTIR-2475): the
                  variant made a faint ink read as if it painted the tab's
                  LABEL, when it only ever painted this `aria-hidden` glyph. */}
              <span
                className={cn(
                  'inline-flex shrink-0',
                  on ? 'text-(--el-tabnav-active)' : 'text-(--el-text-faint)',
                )}
                aria-hidden
              >
                {tab.icon}
              </span>
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <PublicSubmitRequest identifier={identifier} size="sm" />
    </div>
  );
}
