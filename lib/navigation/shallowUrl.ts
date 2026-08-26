// Shallow URL updates — change the address bar WITHOUT a server navigation
// (Subtask MOTIR-3434; the mechanism was decided in bug MOTIR-1086 and lived
// inside `app/(authed)/items/_components/IssueQuickView.tsx` until this card
// lifted it out).
//
// ── When to reach for this, and when NOT to ────────────────────────────────
// **A URL that only the CLIENT reads is written shallowly. `router.push` is for
// a URL change the SERVER must answer.**
//
// `router.push` re-runs the whole Server-Component page. That is correct when
// the destination body needs data the browser does not have — a different
// query, a different page of results, a different server-computed series. It is
// pure cost when the body is already in the browser and the URL is only there
// so a deep link, a reload and Back/forward agree. Three view toggles were
// paying that cost: the plan detail's Canvas/List, the item page's Children
// List/Graph, and the roadmap's scope. Each re-ran a page of server reads to
// render something already on screen — which is what this story was reported
// for.
//
// Next's App Router syncs `usePathname` / `useSearchParams` with native
// `history.pushState`, so a component deriving its state from
// `searchParams.get(...)` keeps working untouched: the state still lives in the
// URL, it is simply written without a round trip.
//
// ── PUSH, not REPLACE, unless you mean it ──────────────────────────────────
// `shallowPush` leaves a history entry, so Back undoes the change. That is a
// shipped requirement and not an accident: MOTIR-1549 was filed because the
// roadmap toggle once used a replace and Back stopped restoring the previous
// scope. `shallowReplace` exists for the genuinely transient case — a URL that
// should not become a place the reader can go back to.
//
// The visual half of this rule lives in `design/shell/design-notes.md`
// § *THE SWITCH RULE*: a switch that needs no server also shows no pending
// state — no spinner, no disabled segment, no skeleton. The two homes are
// deliberate, and each cites the other.

/**
 * Push `href` onto the history stack without a server navigation, so the host
 * page does not re-render or refetch.
 *
 * A history entry (not `replaceState`), so Back steps back through the changes
 * — the behaviour the peek's "Back closes it" and the roadmap toggle's restored
 * scope both depend on.
 */
export function shallowPush(href: string): void {
  window.history.pushState(null, '', href);
}

/**
 * Replace the current history entry with `href`, without a server navigation.
 *
 * For a URL change that should NOT become somewhere Back returns to. Prefer
 * {@link shallowPush} for anything a reader would expect to undo.
 */
export function shallowReplace(href: string): void {
  window.history.replaceState(null, '', href);
}
