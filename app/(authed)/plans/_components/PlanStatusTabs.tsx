'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import {
  PLAN_STATUS_DTO_VALUES,
  type PlanStatusCountsDto,
  type PlanStatusDto,
} from '@/lib/dto/plans';

// The Plans list's STATUS TAB STRIP (MOTIR-3241, built to
// `design/ai-planning/design-notes.md` Part VII §4 and
// `plans-tabbed-list.mock.html` panel 1).
//
// The statuses are not categories invented for this page — they are the plan
// LIFECYCLE, and each asks the reader a different question: `Planned` is
// *decide this*, `Generating` is *wait*, `Approved` / `Declined` are *what
// happened*. A single reverse-chronological stream mixes all four, so the one
// plan waiting on a decision sits below however many spinners the week produced.
//
// THE URL IS THE SINGLE SOURCE OF TRUTH, exactly as `ChildPanel`'s `?children=`
// switcher is: the tab is derived from `searchParams` on every render, so a deep
// link, a reload and browser Back/forward all agree. `planned` is the default
// and writes a CLEAN url with no parameter, so every existing link to `/plans`
// stays byte-identical.
//
// The primitive is the shipped `Segmented` — a labelled `role="group"` of real
// `aria-pressed` buttons. Deliberately NOT an ARIA `tablist`: the rows below are
// not a tabpanel swapped client-side, they are a server-rendered list behind a
// URL-addressable FILTER, and `aria-pressed` describes a filter honestly where
// `aria-selected` would promise a relationship the DOM does not have. It is also
// the grammar the board group-by and the Children List/Graph switcher already
// use (Part VII §4).

/** The query parameter that carries the chosen status. */
export const PLAN_STATUS_PARAM = 'status';

/** The tab a URL selects. Unknown / absent / malformed → the default, never an
 *  error: the value comes from a URL a person can type. */
export function planStatusFromParam(raw: string | null | undefined): PlanStatusDto {
  return (PLAN_STATUS_DTO_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as PlanStatusDto)
    : 'planned';
}

export interface PlanStatusTabsProps {
  /** The tab currently in view, already resolved from the URL by the page. */
  value: PlanStatusDto;
  /** How many plans each status holds — total over the vocabulary, so a tab with
   *  no rows renders `0` rather than nothing (Part VII §4). */
  counts: PlanStatusCountsDto;
}

export function PlanStatusTabs({ value, counts }: PlanStatusTabsProps) {
  const t = useTranslations('aiPlanning');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const options: SegmentedOption<PlanStatusDto>[] = PLAN_STATUS_DTO_VALUES.map((status) => ({
    value: status,
    label: t(`status.${status}`),
    // The count rides the primitive's own `trailing` slot — the same one the
    // notification drawer's unread count uses. It is hidden below `sm`: Part VII
    // §4 MEASURED the strip at 310.3px with labels alone and 358.8px with
    // counts, against the 343px content box a 375px viewport leaves after the
    // shell's `px-4`. The labels fit; the counts overflow by 15.8px. Dropping
    // them costs a number the tab's own result set supplies the moment it is
    // pressed — a scroller would instead push `Declined` off-screen on the one
    // surface whose job is to show which statuses exist.
    trailing: <span className="hidden sm:inline">{counts[status]}</span>,
  }));

  return (
    <PlanStatusStrip
      options={options}
      value={value}
      onChange={(next) => {
        const params = new URLSearchParams(searchParams.toString());
        // The DEFAULT writes a clean URL. `?status=planned` and `/plans` must
        // not be two addresses for one view.
        if (next === 'planned') params.delete(PLAN_STATUS_PARAM);
        else params.set(PLAN_STATUS_PARAM, next);
        const query = params.toString();
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
      }}
      label={t('statusFilterAria')}
    />
  );
}

/** The strip itself, split out so the URL wiring above stays readable and a test
 *  can drive the control without a router. */
function PlanStatusStrip({
  options,
  value,
  onChange,
  label,
}: {
  options: SegmentedOption<PlanStatusDto>[];
  value: PlanStatusDto;
  onChange: (next: PlanStatusDto) => void;
  label: string;
}) {
  return (
    <Segmented<PlanStatusDto> options={options} value={value} onChange={onChange} label={label} />
  );
}
