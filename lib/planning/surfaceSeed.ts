// THE SURFACE SEED (Story MOTIR-7042 · MOTIR-7050; design
// `design/ai-chat/design-notes.md` § "⭐ Debug with Motir AI" and
// `design/triage/design-notes.md` § "The Debug with Motir AI offer") — what a
// door hands the ONE Motir AI surface besides its address.
//
// Two doors open the project conversation with words already in it, and neither
// may put those words in the URL: the address is shared, bookmarked and reloaded,
// and a reload must never re-send a turn or re-fill a composer the person already
// emptied (`approval-gates.md` §10f says the same for the refusal seed — no text
// rides the address). So the door writes the seed HERE, in page memory, right
// before it opens the overlay, and the workspace host takes it once when it
// mounts. A new tab (a ⌘-click) and a reload start with nothing, which is the
// honest outcome for both: the conversation they open is simply resumed.
//
//   · `draft` — the orb's "Debug with Motir AI" row. Motir's own template is put
//     in the composer UNSENT (the shipped `initialDraft` seam, MOTIR-6210's
//     "pre-fill and wait"). `caret` is where the field's caret lands.
//   · `send`  — the report widget's accept (ADR AMENDMENT 1, A1.3: the one seeded
//     send). The person's own title and description go out ONCE, through the ask
//     door, anchored on the triage bug they just filed (`anchorKey`). No intent
//     rides it: the server reads the turn.
//
// ⚠️ "ONCE" IS HELD AT THREE LAYERS, and this module is only the first:
//  1. THIS STORE — the host releases the seed the moment it mounts, so a second
//     host (a re-target, a close and reopen) finds nothing to take;
//  2. THE PAGE — the rail claims `debugAutoSendKey(anchorKey)` through the pick's
//     shipped claim set (`pickAutoSend.ts`) before it sends, so a remount that
//     somehow still held the seed cannot send it again while this page lives;
//  3. THE COMPONENT — the rail's own ref, which absorbs a StrictMode double effect.
//
// Framework-free on purpose (no React, no `next/*`): the report widget, the
// callout menu, the overlay and the tests all reach it the same way.

/** What a door hands the surface. */
export type SurfaceSeed =
  | { kind: 'draft'; text: string; caret: number }
  | { kind: 'send'; body: string; anchorKey: string };

let pending: SurfaceSeed | null = null;

/** A door is about to open the surface: remember what it opens with. A later
 *  hand replaces an earlier one — the surface opens once, with the last door's. */
export function handSurfaceSeed(seed: SurfaceSeed): void {
  pending = seed;
}

/** Read the seed WITHOUT taking it — safe in a render, which may run twice. */
export function peekSurfaceSeed(): SurfaceSeed | null {
  return pending;
}

/**
 * Forget the seed. With an argument, only when it is still THAT seed: a host
 * releasing what it took must not drop a newer one a second door handed since.
 */
export function releaseSurfaceSeed(seed?: SurfaceSeed | null): void {
  if (seed === undefined || seed === null || pending === seed) pending = null;
}

/**
 * The page-level claim a widget send is made under. Keyed on the TRIAGE BUG, not
 * on the text: a bug is filed once, so its one debug turn is claimed once, and a
 * second report (a new key) is a new claim.
 */
export function debugAutoSendKey(anchorKey: string): string {
  return `debug:${anchorKey.toUpperCase()}`;
}

/**
 * The seeded turn's BODY, word for word (A1.3 condition 1): the person's title, a
 * blank line, then their description. With no description it is the title alone.
 * Motir adds no preamble.
 */
export function debugSeedBody(title: string, description: string | null | undefined): string {
  const head = title.trim();
  const tail = (description ?? '').trim();
  return tail ? `${head}\n\n${tail}` : head;
}

/** The caret for a template draft: the end of its FIRST line (the design's
 *  "caret at the end of the first line"), or the end of a one-line draft. */
export function firstLineCaret(text: string): number {
  const nl = text.indexOf('\n');
  return nl === -1 ? text.length : nl;
}

/** Tests only: start each test on a fresh page. */
export function resetSurfaceSeedForTests(): void {
  pending = null;
}
