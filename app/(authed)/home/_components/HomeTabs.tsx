import Link from 'next/link';
import { CircleDot, Star } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils/cn';
import type { HomeTab } from '@/lib/home/tab';
import type { HomeTabCountsDto } from '@/lib/dto/home';

// The Home tab strip (Story MOTIR-2649 · Subtask MOTIR-2653, per
// design/home/design-notes.md §"The tab strip") — My work · Watching.
//
// ⚠️ LINK-BASED, not the client `Segmented`, and that is the design's decision
// rather than a shortcut. The selection has to live in the URL: a tab held only
// in component state cannot be linked, cannot survive a reload, and cannot be
// asserted without driving a click. So each tab is a real `<a>` to `/home` or
// `/home?tab=watching`, carrying `aria-current="page"`.
//
// Styled to match the shipped `Segmented` exactly — the same
// `--el-tabnav-track` track at `--radius-btn` with a 2px inset, the same raised
// `--el-page-bg` + `--shadow-subtle` active option. This mirrors
// `app/(public)/_components/PublicTabNav.tsx`, which made the same choice for
// the same reason (a crawlable, linkable tab per URL). Server component; colour
// via `--el-*`, shape via element-semantic tokens.

const TAB_BASE = cn(
  'inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-[12.5px] font-medium transition-colors',
  'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
);

export async function HomeTabs({ active, counts }: { active: HomeTab; counts: HomeTabCountsDto }) {
  const t = await getTranslations('home');
  const tabs = [
    {
      key: 'work' as const,
      href: '/home',
      label: t('tabs.myWork'),
      icon: <CircleDot className="h-3.5 w-3.5" />,
      count: counts.myWork,
    },
    {
      key: 'watching' as const,
      href: '/home?tab=watching',
      label: t('tabs.watching'),
      icon: <Star className="h-3.5 w-3.5" />,
      count: counts.watching,
    },
  ];

  // Both counts are suppressed while BOTH are zero (the design's all-empty
  // panel): a "0" beside a tab is a number a brand-new user has to read and
  // then discard. A zero beside a NON-zero sibling still shows — that one is
  // information ("nothing over there either").
  const showCounts = counts.myWork > 0 || counts.watching > 0;

  return (
    <nav
      aria-label={t('tabs.label')}
      className="inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5"
    >
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={on ? 'page' : undefined}
            data-testid={`home-tab-${tab.key}`}
            className={cn(
              TAB_BASE,
              on
                ? 'bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle)'
                : 'text-(--el-text-secondary) hover:text-(--el-text)',
            )}
          >
            {/* The glyph's ink sits on its own wrapper rather than a `[&_svg]`
                descendant variant on the tab (MOTIR-2475): the variant reads as
                if it paints the tab's LABEL when it only ever paints this
                aria-hidden glyph. */}
            <span
              aria-hidden
              className={cn(
                'inline-flex shrink-0',
                on ? 'text-(--el-tabnav-active)' : 'text-(--el-text-faint)',
              )}
            >
              {tab.icon}
            </span>
            {tab.label}
            {showCounts ? (
              <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-(--radius-badge) bg-(--el-count-bg) px-(--spacing-chip-x) text-[11px] font-semibold text-(--el-count-text)">
                {tab.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
