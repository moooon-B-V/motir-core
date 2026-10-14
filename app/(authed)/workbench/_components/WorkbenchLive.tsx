'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  WorkbenchLiveContext,
  useWorkbenchLiveSignal,
  useWorkbenchLiveStream,
} from './useWorkbenchLive';
// ⚠️ IMPORTED, NEVER RE-TYPED (MOTIR-5726). `/workbench` has ONE home in this
// repo — `lib/navigation/landing.ts` — and `lib/workbench/tab.ts` names the
// Workbench's own address from it. A literal here reds `landing-owner-guard`,
// and the guard is right: it is the shape six separate repairs came from.
import { WORKBENCH_PATH } from '@/lib/workbench/tab';
import { LiveSignalProvider, routeLiveSources } from '@/lib/live/liveSignal';
import { createWorkbenchStreamSource } from '@/lib/live/sources/workbenchStreamSource';
import { planPollSource } from '@/lib/live/sources/planPollSource';

// THE HOST THAT HOLDS THE STREAM (Story MOTIR-5238 · Subtask MOTIR-5242).
//
// ⚠️ ONE COMPONENT SUBSCRIBES, AND IT IS THIS ONE. Every other consumer — the
// five lists, the strip, the approval overlay — reads the signal through the
// context this provides. `useRunEvents.ts` records why in its own header: two
// components each opening their own connection is *"a fan-out wearing a
// different name"*, and this surface has more consumers than the one that
// taught it.
//
// ⚠️ A NUDGE NO LONGER REFRESHES THE ROUTE (Story MOTIR-8539 · MOTIR-8574,
// AMENDING MOTIR-5242's decision on the record). The host used to refresh the
// route on every nudge so the strip and the list re-read through the page's one
// `Promise.all`. That re-ran the whole page under the reader — under an open
// approval too, which MOTIR-8571 measured: over `/workbench?approval=…` every
// nudge re-fetched the page. The pairing now comes from ONE endpoint instead:
// `GET /api/workbench/window` answers the tab's window and every strip count
// from `workbenchWindowService.read`, the same call the page's first paint
// makes, and `useWorkbenchWindow` sets both in one state update. So § 21's
// rule — the strip and the list never disagree — holds, and the Workbench is
// now case 3 of CLAUDE.md's page-state contract: a client island holding its
// own fetched state.
//
// ⚠️ SO THIS HOST REFRESHES NOTHING. It subscribes through the seam, hands the
// signal down, and every surface that needs fresh data reads it itself — the
// Workbench through its window read, the approval overlay through its probe.
// Scroll, focus and the active tab survive because nothing re-renders the page.

/**
 * The provider: subscribes once and hands the signal down.
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
 *   · IT REFRESHES NOTHING, anywhere (MOTIR-8574). A nudge with the overlay
 *     open must not re-render the page under the reader, on the Workbench or
 *     off it: the overlay's own probe reads the SIGNAL, and the Workbench
 *     re-reads its own window.
 */
export function WorkbenchLive({ children }: { children: ReactNode }) {
  // ⚠️ ONE SOURCE FOR THE SHELL'S LIFETIME (Story MOTIR-8539 · MOTIR-8572): it
  // holds the one connection, opened while a subscriber is present. The plan
  // topic routes to the poll's cadence, so a plan surface under the shell reads
  // the same seam as one outside it.
  const [stream] = useState(createWorkbenchStreamSource);
  useEffect(() => () => stream.dispose(), [stream]);
  const source = useMemo(
    () => routeLiveSources({ workbench: stream, plan: planPollSource }),
    [stream],
  );
  return (
    <LiveSignalProvider source={source}>
      <WorkbenchLiveHost>{children}</WorkbenchLiveHost>
    </LiveSignalProvider>
  );
}

/** The host's half under the provider: subscribes and hands the signal down. */
function WorkbenchLiveHost({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const onWorkbench = pathname === WORKBENCH_PATH;
  // The overlay's own open condition (`ApprovalOverlay` reads the same name).
  const approvalOpen = params.get('approval') !== null;

  const live = useWorkbenchLiveStream(onWorkbench || approvalOpen);
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
