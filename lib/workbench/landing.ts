import type { HomeTabCountsDto } from '@/lib/dto/home';
import { workbenchTabHref, type WorkbenchTab } from '@/lib/workbench/tab';

// THE LANDING CASCADE (Story MOTIR-5213 · MOTIR-5221) — what a bare `/workbench`
// resolves to, per `design/workbench/design-notes.md` § 21:
//
//   To approve  if anything awaits the reader's decision
//   else In progress  if anything of theirs is moving
//   else To do  — TERMINAL, landed on even when it is empty too
//
// PURE, and that is the point of the seam: counts in, tab out — no session, no
// request, no service, no I/O — so the whole rule is a truth table in a unit
// test rather than a browser walk. The page reads the counts and redirects; this
// module only decides.
//
// Three properties the design states and this implements literally:
//   · THREE TABS ONLY. Recently finished and Watching are never landed on, so
//     their counts are not even part of the input.
//   · TO DO IS UNCONDITIONAL. There is no input for which this returns nothing,
//     so the landing can never be a blank page.
//   · AN EXPLICIT `?tab=` ALWAYS WINS — which is why nothing here sees the
//     request: the page only asks when no known tab was named.

/** The three counts the cascade reads — the rungs, in order. */
export type LandingCounts = Pick<HomeTabCountsDto, 'approvals' | 'inProgress' | 'toDo'>;

/** The tab a request that named no known tab lands on. */
export function resolveWorkbenchLanding(counts: LandingCounts): WorkbenchTab {
  if (counts.approvals > 0) return 'approvals';
  if (counts.inProgress > 0) return 'in-progress';
  // ⚠️ `toDo` is deliberately NOT consulted: the last rung is taken whatever it
  // holds. A brand-new member lands here on the one empty state that carries a
  // way forward (a link to Ready).
  return 'todo';
}

/**
 * Where the resolver FORWARDS: the landed tab's canonical address, carrying every
 * other query parameter the request arrived with.
 *
 * ⚠️ WHY THE OTHER PARAMETERS TRAVEL. The Workbench is not the only reader of its
 * own query: `?peek=` opens the quick view over any list page, and overlays that
 * open "over the page you are on" ride beside the host's params (the approval
 * overlay's `?approval=`, the planning workspace's `plan*`). A pasted
 * `/workbench?peek=M-7` must still open M-7 over whichever tab the reader lands
 * on — forwarding to the bare tab address would silently drop what they asked to
 * see. The same reason `/home` → `/workbench` is a 308 WITH its query string.
 *
 * ⚠️ AND WHY TWO DO NOT. `tab` is what is being replaced — an unknown or
 * repeated value is exactly what fell into the cascade. `page` numbers a page OF
 * a tab, and a request that named no tab never said which tab it meant, so page
 * 3 of the landed tab would be a place nobody asked to go.
 */
export function workbenchLandingHref(
  tab: WorkbenchTab,
  query: Readonly<Record<string, string | string[] | undefined>>,
): string {
  const href = new URL(workbenchTabHref(tab), 'http://landing.invalid');
  for (const [key, value] of Object.entries(query)) {
    if (key === 'tab' || key === 'page' || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) href.searchParams.append(key, v);
  }
  return `${href.pathname}${href.search}`;
}
