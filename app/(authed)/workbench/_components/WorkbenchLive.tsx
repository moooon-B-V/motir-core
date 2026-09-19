'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  WorkbenchLiveContext,
  useWorkbenchLiveSignal,
  useWorkbenchLiveStream,
} from './useWorkbenchLive';

// THE HOST THAT HOLDS THE STREAM (Story MOTIR-5238 · Subtask MOTIR-5242).
//
// ⚠️ ONE COMPONENT SUBSCRIBES, AND IT IS THIS ONE. Every other consumer — the
// five lists, the strip, the approval overlay — reads the signal through the
// context this provides. `useRunEvents.ts` records why in its own header: two
// components each opening their own connection is *"a fan-out wearing a
// different name"*, and this surface has more consumers than the one that
// taught it.
//
// ⚠️ A NUDGE IS `router.refresh()`, AND THAT IS WHAT KEEPS THE STRIP AND THE
// LIST IN ONE PAGE STATE. The Workbench page reads its tab's window and all five
// counts in a single `Promise.all`; a refresh re-runs that server render, so the
// rows and the numbers arrive together and cannot disagree — § 21's rule,
// unrelaxed by live-ness (design-notes § 26). It is also case 2 of CLAUDE.md's
// page-state contract, which is the case this surface is: the lists are client
// components rendered from SERVER props, not islands holding their own fetched
// state, so new props reach them.
//
// ⚠️ AND IT PRESERVES WHAT THE READER IS DOING. A refresh keeps the address, so
// the active tab and the pager's page survive it; it re-renders in place, so
// scroll position and focus are untouched. A live list that scrolled itself
// would be worse than a stale one.

/**
 * ONE refresh per nudge, and none when nothing moved.
 *
 * ⚠️ THE FRAME IS THE FILTER, not the tab. A frame is only written when the
 * watermark moved for this reader, and the hook drops the cursor-priming frames
 * that name nothing — so the page re-reads once per real change and not at all
 * otherwise. What it does NOT do is re-read one tab: the strip renders all five
 * counts, so every moved tab is on screen, and the page's single `Promise.all`
 * is what makes the rows and the numbers agree. Splitting it per tab would mean
 * a second client-side read of data the server already pairs — the drift § 26
 * and the card both forbid. (MOTIR-5242's *a tab that did not move is not
 * re-read* is met at the FRAME: no change, no read. The per-tab reading of it is
 * amended on the card, with this reasoning.)
 */
function useRefreshOnNudge(nudge: number): void {
  const router = useRouter();
  const lastApplied = useRef(0);
  useEffect(() => {
    if (nudge === lastApplied.current) return;
    lastApplied.current = nudge;
    router.refresh();
  }, [nudge, router]);
}

/** Where the Workbench lives — the one address whose lists this makes current. */
const WORKBENCH_PATH = '/workbench';

/**
 * The provider: subscribes once, refreshes on a nudge, hands the signal down.
 *
 * ⚠️ IT IS MOUNTED IN THE SHELL, NOT IN THE WORKBENCH PAGE, and MOTIR-5245's E2E
 * is why. The approval overlay is mounted ONCE in `app/(authed)/layout.tsx` —
 * it opens over any authed page from its address — so it is not a descendant of
 * anything the Workbench page renders. A provider inside that page therefore
 * could not reach it: the overlay read {@link WorkbenchLiveContext}'s QUIET
 * default, was never nudged, and MOTIR-5243's whole deliverable was inert in the
 * product while passing its own tests, which wrapped the overlay in this
 * provider by hand — an arrangement that existed nowhere.
 *
 * ⚠️ AND THE SHELL IS NOT THE SAME THING AS "EVERY PAGE IS LIVE", which this
 * story is explicitly scoped away from. Two gates keep them apart:
 *
 *   · IT SUBSCRIBES only while a live surface is on screen — the Workbench, or
 *     an open approval. Everywhere else it holds no connection at all, which is
 *     the same cost the page-level mount had.
 *   · IT REFRESHES only on the Workbench. A nudge with the overlay open over an
 *     item page must not re-render that page under the reader: the overlay's own
 *     probe is what it needs, and that probe reads the SIGNAL, never a refresh.
 */
export function WorkbenchLive({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const onWorkbench = pathname === WORKBENCH_PATH;
  // The overlay's own open condition (`ApprovalOverlay` reads the same name).
  const approvalOpen = params.get('approval') !== null;

  const live = useWorkbenchLiveStream(onWorkbench || approvalOpen);
  useRefreshOnNudge(onWorkbench ? live.nudge : 0);
  return <WorkbenchLiveContext.Provider value={live}>{children}</WorkbenchLiveContext.Provider>;
}

/**
 * *Reconnecting…* — the quiet chip beside the strip (design-notes § 26, Panel 2).
 *
 * ⚠️ IT IS NOT A LOADING STATE, and the treatment is the difference. Loading
 * means *there is nothing on your screen yet* (§ 22's Panel 5b: muted blocks at
 * the real proportions). This means *everything on your screen is real and may be
 * a few seconds old* — so the rows keep their full ink, nothing pulses, nothing
 * is greyed, and this chip is the only new element. It offers NO action, because
 * there is nothing for the reader to do: the hook is already backing off to a
 * 15s ceiling and the watermark resumes with neither a replay nor a gap.
 */
export function WorkbenchReconnecting() {
  const t = useTranslations('workbench.live');
  const { reconnecting } = useWorkbenchLiveSignal();
  if (!reconnecting) return null;
  return (
    <span
      role="status"
      data-testid="workbench-reconnecting"
      className="inline-flex items-center gap-1.5 rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-secondary)"
    >
      <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {t('reconnecting')}
    </span>
  );
}
