'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import {
  PLAN_STATUS_DTO_VALUES,
  type PlanStatusCountsDto,
  type PlanStatusDto,
} from '@/lib/dto/plans';
import { PLAN_STATUS_PARAM } from '@/lib/planning/planStatusFilter';

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

// ⚠️ `PLAN_STATUS_PARAM` AND `planStatusFromParam` LIVE IN
// `lib/planning/planStatusFilter.ts`, and they are NOT re-exported from here
// (MOTIR-3243). They used to be declared in this file, which is a `'use client'`
// module — so the page, a Server Component, imported a CLIENT REFERENCE and
// `/plans` 500'd on every request with *"Attempted to call
// planStatusFromParam() from the server"*. A re-export would restore exactly
// that: the boundary is a property of the module an export is REACHED THROUGH,
// not of where the code was written. Import from the pure module on both sides.
// `lib/planning/planView.ts` is the same shape for the plan detail's `?view=`.

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
 *  can drive the control without a router.
 *
 * ⚠️ IT SCROLLS BELOW `sm`, AND THAT REVERSES PART VII §4 — on a measurement,
 * not a preference (MOTIR-3578, `design/ai-planning/design-notes.md` Part XI,
 * `plans-tabbed-list.mock.html` panel 4, RE-MEASURED for five tabs).
 *
 * Part VII §4 measured the FOUR-tab strip at 310.3px with labels and 358.8px
 * with counts against the 343px content box a 375px viewport leaves after the
 * shell's `px-4`, and concluded: labels at every width, counts from `sm` up. The
 * second half stands — five tabs with counts are 422.6px, still inside the
 * 592px `sm` box. The FIRST half does not: five labels are **361.9px**, so
 * `310.3 < 343 < 361.9` and the rule's premise — that the strip fits — is what
 * the fifth member falsified.
 *
 * §4 also REJECTED a scroller, arguing it would push `Declined` off-screen on
 * the one surface whose job is to show which statuses exist. The re-measurement
 * retires that premise rather than overruling the taste: the overflow is
 * **18.9px**, so `Declined` is not off-screen, it is clipped by a fifth of its
 * width — and a half-drawn word is a stronger *there is more here* cue than any
 * chevron this surface would have to invent. The two alternatives were drawn and
 * rejected in the mock: `flex-wrap` is 343x80px and strands `Declined` alone on
 * a second row, breaking the one-of-N reading a segmented track exists to carry;
 * shortening `Generating` fits at 337.8px and makes the tab and the row's own
 * pill say different words for one status.
 *
 * ⚠️ AND IT REPAIRS A CASE THAT WAS ALREADY BROKEN. At 320px the box is 288px
 * and the FOUR-tab strip is already 310.3px — so `/plans` has overflowed its
 * gutter on the smallest phone since MOTIR-3241, silently. This is why the
 * scroller is the right instrument rather than the cheapest one.
 *
 * The selected segment is scrolled into view on mount, so a deep link to
 * `?status=declined` opens on its own tab rather than on the strip's left edge.
 * `overflow-x-auto` alone would leave it out of frame. */
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
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scroller.current?.querySelector('[aria-pressed="true"]');
    // `nearest` on both axes: the strip must never scroll the PAGE to reach a
    // tab, and a segment already in frame must not be nudged.
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  return (
    <div ref={scroller} className="overflow-x-auto">
      <Segmented<PlanStatusDto> options={options} value={value} onChange={onChange} label={label} />
    </div>
  );
}
