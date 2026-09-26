'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import { ROOM_VIEW_PARAM, ROOM_VIEWS, type RoomView } from '@/lib/rooms/roomView';

// THE MINE / PROJECT SWITCH (Story MOTIR-6179 · design MOTIR-6327,
// `design/approvals/design-notes.md` § *The SWITCH — one grammar, three rooms*),
// shared by Plans, Approval records and Runs so the three rooms say the same two
// words in the same place.
//
//   * The shipped `Segmented` — a labelled group of `aria-pressed` buttons, never
//     an ARIA tablist: the view is a URL-addressable filter over a server list.
//   * Always Mine, then Project; no counts.
//   * Rendered by a room ONLY when the reader has both views — this component
//     does not decide that, and never draws a one-option or disabled switch.
//   * Pressing a segment ALWAYS writes an explicit `?view=` (the default is
//     data-dependent, so a clean URL would not say which view it is), drops the
//     room's `drop` parameters (e.g. Approvals' `page`), keeps everything else.
//   * A REAL navigation — each view is its own server read — so `router.push`,
//     not `shallowPush` (`CLAUDE.md` § URL state), inside `startTransition` so the
//     group reports `aria-busy` while the next view is on its way.

export interface RoomViewSwitchProps {
  /** The view the page SERVED. */
  value: RoomView;
  /** The group's accessible name — each room names its own rows. */
  label: string;
  /** Parameters a view switch drops (a page number, a landing). */
  drop?: readonly string[];
}

export function RoomViewSwitch({ value, label, drop = [] }: RoomViewSwitchProps) {
  const t = useTranslations('roomView');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const options: SegmentedOption<RoomView>[] = ROOM_VIEWS.map((view) => ({
    value: view,
    label: t(view),
  }));

  return (
    <div aria-busy={pending || undefined} className="shrink-0">
      <Segmented<RoomView>
        options={options}
        value={value}
        label={label}
        onChange={(next) => {
          if (next === value) return;
          const params = new URLSearchParams(searchParams.toString());
          params.set(ROOM_VIEW_PARAM, next);
          for (const key of drop) params.delete(key);
          startTransition(() => {
            router.push(`${pathname}?${params.toString()}`, { scroll: false });
          });
        }}
      />
    </div>
  );
}
