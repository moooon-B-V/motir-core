import Link from 'next/link';
import { Circle, CircleCheck, CircleDot, Inbox, Star } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import type { WorkbenchTab } from '@/lib/workbench/tab';
import type { HomeTabCountsDto } from '@/lib/dto/home';
import { workbenchTabHref } from '@/lib/workbench/tab';

// The Workbench tab strip (Story MOTIR-4777 · MOTIR-4782, per
// `design/workbench/design-notes.md` §"The tab strip") — To do · In progress ·
// Recently finished · Watching · To approve.
//
// ⚠️ LINK-BASED, not the client `Segmented`, and that is the design's decision
// rather than a shortcut. The selection has to live in the URL: a tab held only
// in component state cannot be linked, cannot survive a reload, and cannot be
// asserted without driving a click. So each tab is a real `<a>` carrying
// `aria-current="page"`, and To do is spelled as the ABSENCE of `?tab=`.
//
// Styled to match the shipped `Segmented` exactly — the same
// `--el-tabnav-track` track at `--radius-btn` with a 2px inset, the same raised
// `--el-page-bg` + `--shadow-subtle` active option. This mirrors
// `app/(public)/_components/PublicTabNav.tsx`, which made the same choice for
// the same reason (a crawlable, linkable tab per URL). Server component; colour
// via `--el-*`, shape via element-semantic tokens.
//
// ⚠️ IT SCROLLS AT `< md` RATHER THAN SHRINKING OR WRAPPING, and the number is
// why. Measured on the design asset: five tabs are **662px** of track and the
// `< md` content box is **386px** — where the two-tab strip this replaces was
// 249px and fitted, so the split is what changes the narrow band's answer.
// Shrinking would truncate the labels that make a tab worth switching to;
// wrapping would put a second control row above rows that are already two lines
// each at that width. `overflow-x-auto` keeps every tab reachable at full
// label — the mobile convention — and the browser scrolls the active one into
// view on load. `shrink-0` per tab is what stops flex compressing them instead.

const TAB_BASE = cn(
  'inline-flex h-(--height-control) shrink-0 items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-[12.5px] font-medium transition-colors',
  'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
);

interface TabSpec {
  key: WorkbenchTab;
  label: string;
  icon: ReactNode;
  count: number;
}

export async function WorkbenchTabs({
  active,
  counts,
}: {
  active: WorkbenchTab;
  counts: HomeTabCountsDto;
}) {
  const t = await getTranslations('workbench');

  // Strip order is the design's, and it is also the reading order of a working
  // day: what to start, what is moving, what just landed, what you follow, what
  // wants you.
  const tabs: TabSpec[] = [
    {
      key: 'todo',
      label: t('tabs.toDo'),
      icon: <Circle className="h-3.5 w-3.5" />,
      count: counts.toDo,
    },
    {
      key: 'in-progress',
      label: t('tabs.inProgress'),
      icon: <CircleDot className="h-3.5 w-3.5" />,
      count: counts.inProgress,
    },
    {
      key: 'finished',
      label: t('tabs.recentlyFinished'),
      icon: <CircleCheck className="h-3.5 w-3.5" />,
      count: counts.recentlyFinished,
    },
    {
      key: 'watching',
      label: t('tabs.watching'),
      icon: <Star className="h-3.5 w-3.5" />,
      count: counts.watching,
    },
    {
      // ⚠️ The LABEL is an action and the SLUG is a set. The other four name a
      // state a work item is IN; this one names something the reader must DO,
      // which is the whole reason it sits apart from them. Its href stays
      // `?tab=approvals` — `lib/workbench/tab.ts` carries the rule.
      key: 'approvals',
      label: t('tabs.toApprove'),
      icon: <Inbox className="h-3.5 w-3.5" />,
      count: counts.approvals,
    },
  ];

  // Every count is suppressed while ALL are zero (the design's all-empty
  // panel): a row of five "0"s is five numbers a brand-new user has to read and
  // then discard. A zero beside a NON-zero sibling still shows — that one is
  // information ("nothing over there either"). The rule is the shipped one; it
  // now suppresses five instead of two.
  const showCounts = tabs.some((tab) => tab.count > 0);

  return (
    <nav
      aria-label={t('tabs.label')}
      className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5"
    >
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={workbenchTabHref(tab.key)}
            aria-current={on ? 'page' : undefined}
            data-testid={`workbench-tab-${tab.key}`}
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
