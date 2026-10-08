import Link from 'next/link';
import {
  Circle,
  CircleCheck,
  CircleDot,
  CirclePause,
  Inbox,
  PenLine,
  Star,
  Wrench,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import type { WorkbenchTab } from '@/lib/workbench/tab';
import type { HomeTabCountsDto } from '@/lib/dto/home';
import { workbenchTabHref } from '@/lib/workbench/tab';

// The Workbench tab strip (Story MOTIR-4777 · MOTIR-4782, per
// `design/workbench/design-notes.md` §"The tab strip") — Waiting on you · Planning ·
// To fix · To resume · In progress · To do · Recently finished · Watching (re-ordered by
// MOTIR-5217; To fix inserted second by § 30, MOTIR-6605; To resume third by § 35,
// MOTIR-7707; **Planning second by § 36.2, MOTIR-7831** — EIGHT tabs, and the strip order
// is no longer the landing cascade's order, which § 36.2 amends on the record: the rungs
// are tabs 1, 3, 4, 5 and 6, and Planning is never one). The first tab read **To approve**
// until
// MOTIR-7476 (design § 33.1): it now lists work a run handed the reader to DO as well
// as decisions to approve, so it is named for the reader, not the verb. Its slug
// `approvals` and its message key `tabs.toApprove` are unchanged identifiers.
//
// ⚠️ LINK-BASED, not the client `Segmented`, and that is the design's decision
// rather than a shortcut. The selection has to live in the URL: a tab held only
// in component state cannot be linked, cannot survive a reload, and cannot be
// asserted without driving a click. So each tab is a real `<a>` carrying
// `aria-current="page"`, and every tab — To do included — carries its own
// `?tab=` (MOTIR-5218; the bare `/workbench` names no tab).
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

  // Strip order is the design's (`design-notes.md` § 21, MOTIR-5216), and it is
  // the order a person's attention should run in when agents do the work: what
  // is waiting on YOUR decision first — an unmade decision holds up somebody
  // else's card — then what is being WRITTEN for you, then what is waiting to be
  // repaired or resumed, then what is moving, what to start, what just landed and
  // what you follow. ⚠️ The cascade's rungs are tabs 1, 3, 4, 5 and 6 (§ 36.2's
  // amendment): Planning is second and is NEVER a rung, so the strip explains where
  // a reader was landed when it is read with Planning skipped.
  const tabs: TabSpec[] = [
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
    {
      // PLANNING (§ 36.2) — SECOND, and never a landing rung: tab 1 is what is
      // waiting on you, tab 2 is what will arrive on tab 1 once it is written, so
      // the two sit together and the work tabs follow. The glyph is `PenLine`, the
      // same one Part XXV's *Drafting* cue wears on the canvas, so "being written"
      // is one picture on the strip and on the plan. Not `Sparkles`: on a strip a
      // sparkle reads as an AI badge, and many of these plans are written by an MCP
      // agent rather than by Motir AI — § 29 keeps `Sparkles` on the ROW.
      key: 'planning',
      label: t('tabs.planning'),
      icon: <PenLine className="h-3.5 w-3.5" />,
      count: counts.planning,
    },
    {
      // TO FIX (§ 30 Panel 1) — third: what is waiting on you to DECIDE, then what
      // is waiting on you to REPAIR. Also an action rather than a state, and the
      // landing cascade's second rung. Its count is the shipped chip, like every tab's.
      key: 'to-fix',
      label: t('tabs.toFix'),
      icon: <Wrench className="h-3.5 w-3.5" />,
      count: counts.toFix,
    },
    {
      // TO RESUME (§ 35.3) — fourth: a run that stopped at a gate waits on an approval,
      // which needs the reader less than a repair does and more than work that moves
      // without them. The landing cascade's third rung; its count is entries (runs).
      key: 'to-resume',
      label: t('tabs.toResume'),
      icon: <CirclePause className="h-3.5 w-3.5" />,
      count: counts.toResume,
    },
    {
      key: 'in-progress',
      label: t('tabs.inProgress'),
      icon: <CircleDot className="h-3.5 w-3.5" />,
      count: counts.inProgress,
    },
    {
      key: 'todo',
      label: t('tabs.toDo'),
      icon: <Circle className="h-3.5 w-3.5" />,
      count: counts.toDo,
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
  ];

  // Every count is suppressed while ALL are zero (the design's all-empty
  // panel): a row of eight "0"s is eight numbers a brand-new user has to read and
  // then discard. A zero beside a NON-zero sibling still shows — that one is
  // information ("nothing over there either"). The rule is the shipped one,
  // unchanged by § 36.2; it now counts EIGHT, Planning included.
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
