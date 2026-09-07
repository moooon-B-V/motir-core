'use client';

import { useCallback, useMemo, type MouseEvent } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { withPlanningOverlay, type PlanningLaunchContext } from '@/lib/planning/launcher';
import { shallowPush } from '@/lib/navigation/shallowUrl';

// THE ONE OPENER (MOTIR-4730, under story MOTIR-4725).
//
// The doors already shared ONE resolver — `WorkItemPlanEntrance`'s own header
// states it as a principle: *"exactly one entry path into the workspace and one
// place that decides the mode."* That property is kept. What changes is what a
// door WRITES: the workspace is an overlay now (MOTIR-4729), so a door adds four
// query parameters to the page it sits on instead of navigating to `/planning`.
//
// ⚠️ THE DOOR STAYS A REAL `<Link>`, AND THAT IS THE POINT OF RETURNING AN
// `href` AT ALL. A ⌘-click, a middle-click and *Open link in new tab* must keep
// working, and they now do something BETTER than before: the full address opens
// the same page with the workspace over it — the cold deep link — rather than a
// separate route with no context behind it. So `open` intercepts only the plain
// primary click and lets every modified one through to the browser.
//
// ⚠️ `shallowPush`, NEVER `router.push` (`motir-core/CLAUDE.md` § *URL state the
// CLIENT reads is written with `shallowPush`*). The overlay's body is already in
// the browser and the page underneath must not re-render — re-rendering it is
// what would throw away the filter and the scroll position this whole story
// exists to preserve. The visual half of that rule applies too: **no pending
// affordance on a shallow switch** — no spinner on the pill, no disabled state,
// nothing to wait for.

/** What a door needs: the address to carry, and the click that opens in place. */
export interface OpenPlanningWorkspace {
  /**
   * The CURRENT address plus the overlay's parameters — the door's real `href`.
   * Every host parameter is preserved, so `/roadmap?item=MOTIR-12` keeps its
   * drilled level and `/items?peek=MOTIR-12` keeps its quick view open behind
   * the workspace (the dialog-over-dialog case the design decided).
   */
  href: string;
  /** The click handler. Pass it straight to the `<Link>`'s `onClick`. */
  open: (event?: MouseEvent<HTMLElement>) => void;
}

/**
 * A modified click belongs to the BROWSER. Meta / ctrl / shift / alt, and any
 * button that is not the primary one, all mean "open this somewhere else" — so
 * the handler must not `preventDefault` them.
 */
function isPlainPrimaryClick(event: MouseEvent<HTMLElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

export function useOpenPlanningWorkspace(context: PlanningLaunchContext): OpenPlanningWorkspace {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // `context` is an object literal at nearly every call site, so its IDENTITY is
  // not a useful dependency — its VALUE is, and it is small and flat.
  const contextKey = contextValueKey(context);

  // Composed from the two hooks rather than read off `window.location`, so it is
  // stable across a render and safe wherever this component is rendered.
  const href = useMemo(() => {
    const qs = searchParams.toString();
    return withPlanningOverlay(`${pathname}${qs ? `?${qs}` : ''}`, context);
    // `contextKey` stands in for `context` here on purpose (see above); the
    // linter cannot see through that, and re-deriving the address on every
    // render of a top-nav pill is the cost this memo exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams, contextKey]);

  const open = useCallback(
    (event?: MouseEvent<HTMLElement>) => {
      if (event) {
        if (!isPlainPrimaryClick(event)) return;
        event.preventDefault();
      }
      shallowPush(href);
    },
    [href],
  );

  return { href, open };
}

/**
 * The whole context as a dependency-safe scalar. `hasPlan` is included because
 * it changes the MODE, which changes the address.
 */
function contextValueKey(context: PlanningLaunchContext): string {
  const target =
    context.kind === 'work-item'
      ? context.itemKey
      : context.kind === 'convention-refine'
        ? context.repoKey
        : '';
  const hasPlan = 'hasPlan' in context ? String(context.hasPlan) : '';
  return `${context.kind}|${target}|${hasPlan}`;
}
