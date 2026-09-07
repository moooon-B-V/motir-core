import { redirect } from 'next/navigation';
import { parsePlanningLaunch, planningOverlaySearch } from '@/lib/planning/launcher';
import type { PlanningLaunch, PlanningLaunchContext } from '@/lib/planning/launcher';

// THE FORWARD — all that survives at `/planning` (MOTIR-4732, story MOTIR-4725).
//
// The workspace used to BE this path: `app/(planning)/layout.tsx` +
// `planning/page.tsx` + `loading.tsx`, a route group with its own session, 2FA
// and re-consent gates and its own loading boundary. It is an OVERLAY now
// (MOTIR-4729) — a layer on whatever authed page the reader is on — so the route
// has no callers, and a route with no callers is not harmless: it keeps three
// copies of gates somebody must maintain, an entry in the proxy's matcher, a
// line in a dozen comments, and it stands as an open invitation for the next
// feature to navigate to it because it is there.
//
// ⚠️ WHAT SURVIVES IS THE MIGRATION'S CLIENT FOR STRAGGLERS, and nothing else. A
// `/planning?…` link somebody bookmarked, pasted into a chat or left in a stale
// tab must still land them in the workspace rather than on a 404 — so this
// forwards to the HOST the old address implied, carrying the overlay's
// parameters, and the workspace opens over that page exactly as it would from a
// door.
//
// The destination mapping is `planningLaunchBackHref`'s, inlined: that function
// resolved where Close should RETURN to, and it is the same question — an old
// address named a context but no page, and the page it belonged to is where the
// reader should land.
//
// One file, no data read, no component. It lives in `(authed)` on purpose: that
// layout runs the session, 2FA and re-consent holds the deleted group had to
// re-implement, so the forward inherits all three for free. `proxy.ts`'s
// `'/planning/:path*'` matcher entry is KEPT — it is what bounces a cookie-less
// request to `/sign-in?next=/planning…` instead of letting the segment answer
// with its own gate.

/** Where an old address's context BELONGS — the mapping the route-era Close used. */
function hostPathFor(launch: PlanningLaunch): string {
  if (launch.from === 'work-item' && launch.itemKey) {
    return `/items/${encodeURIComponent(launch.itemKey)}`;
  }
  if (launch.from === 'convention-refine') return '/code-health';
  return '/roadmap';
}

/** The launch back as the CONTEXT the overlay's parameters are written from. */
function contextFor(launch: PlanningLaunch): PlanningLaunchContext {
  if (launch.from === 'work-item' && launch.itemKey) {
    return { kind: 'work-item', itemKey: launch.itemKey, hasPlan: launch.mode === 'replan' };
  }
  if (launch.from === 'convention-refine' && launch.repoKey) {
    return { kind: 'convention-refine', repoKey: launch.repoKey };
  }
  if (launch.from === 'roadmap') return { kind: 'roadmap' };
  return { kind: 'project', hasPlan: launch.mode === 'replan' ? true : undefined };
}

/** The address an old `/planning?…` link should have been. Exported for its test. */
export function planningForwardTarget(
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const launch = parsePlanningLaunch(searchParams);
  return `${hostPathFor(launch)}?${planningOverlaySearch(contextFor(launch)).toString()}`;
}

export default async function PlanningForwardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(planningForwardTarget(await searchParams));
}
