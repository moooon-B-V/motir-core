'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import {
  PLAN_SESSION_STATE_VALUES,
  type PlanSessionStateCountsDto,
  type PlanSessionStateDto,
} from '@/lib/dto/planSessions';
import { PLAN_SESSION_LANDING_PARAM, PLAN_STATE_PARAM } from '@/lib/planning/planSessionFilter';

// The Plans list's PLAN-STATE FILTER (MOTIR-6025, built to
// `design/ai-planning/design-notes.md` Part XIX §19.1 and
// `plans-sessions--list.mock.html`). It was the plan-STATUS tab strip
// (MOTIR-3241); the list now holds CONVERSATIONS, and a conversation is filtered
// by the state of its latest plan — or by having none.
//
// **All** is the DEFAULT and writes a clean URL (§19.1): the story's first
// promise is that a conversation that never proposed anything is findable, and
// the only default that shows it without a click is All.
//
// THE URL IS THE SINGLE SOURCE OF TRUTH: the page derives the filter from
// `searchParams` on every render, so a deep link, a reload and Back/forward all
// agree. The primitive is the shipped `Segmented` — a labelled group of real
// `aria-pressed` buttons, the honest description of a URL-addressable FILTER
// over a server-rendered list (never an ARIA tablist; Part VII §4).
//
// ⚠️ `router.push`, NOT `shallowPush`: each filter is its own paged SERVER read,
// so the server must answer the new address (`motir-core/CLAUDE.md` § *URL state
// the CLIENT reads is written with `shallowPush`*). The parameter's name and
// parser live in the PURE `lib/planning/planSessionFilter.ts` (MOTIR-3243).

type FilterValue = PlanSessionStateDto | 'all';

export interface PlanStatusTabsProps {
  /** The filter in view, already resolved from the URL — null = All. */
  value: PlanSessionStateDto | null;
  /** How many sessions each state holds — total over the vocabulary. */
  counts: PlanSessionStateCountsDto;
}

export function PlanStatusTabs({ value, counts }: PlanStatusTabsProps) {
  const t = useTranslations('aiPlanning.sessions');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const total = PLAN_SESSION_STATE_VALUES.reduce((sum, state) => sum + counts[state], 0);
  // The count rides the primitive's `trailing` slot, hidden below `sm`
  // (Part VII §4, unchanged by §19.1).
  const trailing = (n: number) => <span className="hidden sm:inline">{n}</span>;
  const options: SegmentedOption<FilterValue>[] = [
    { value: 'all', label: t('filter.all'), trailing: trailing(total) },
    ...PLAN_SESSION_STATE_VALUES.map((state) => ({
      value: state,
      label: t(`planState.${state}`),
      trailing: trailing(counts[state]),
    })),
  ];

  return (
    <PlanStateStrip
      options={options}
      value={value ?? 'all'}
      onChange={(next) => {
        const params = new URLSearchParams(searchParams.toString());
        if (next === 'all') params.delete(PLAN_STATE_PARAM);
        else params.set(PLAN_STATE_PARAM, next);
        // A landing is an arrival, not a filter — it does not survive a switch.
        params.delete(PLAN_SESSION_LANDING_PARAM);
        const query = params.toString();
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
      }}
      label={t('filterAria')}
    />
  );
}

/**
 * The strip itself. It SCROLLS below `sm` (MOTIR-3578, Part XI) — seven options
 * never fit a phone — and its scroller carries `whitespace-nowrap` (§19.1):
 * two labels are now two and three words, and without it the buttons WRAP inside
 * the scroller instead of scrolling. The class is on this `div`, never on the
 * `Segmented` primitive.
 *
 * The selected segment is scrolled into view on mount, so a deep link to
 * `?planState=declined` opens on its own option rather than on the left edge.
 */
function PlanStateStrip({
  options,
  value,
  onChange,
  label,
}: {
  options: SegmentedOption<FilterValue>[];
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  label: string;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scroller.current?.querySelector('[aria-pressed="true"]');
    // `nearest` on both axes: the strip must never scroll the PAGE to reach an
    // option, and one already in frame must not be nudged.
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  return (
    <div ref={scroller} className="overflow-x-auto whitespace-nowrap">
      <Segmented<FilterValue> options={options} value={value} onChange={onChange} label={label} />
    </div>
  );
}
