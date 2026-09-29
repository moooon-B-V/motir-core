import { MAX_SCOPE_TARGETS } from '@/lib/planChange/scope';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// The planning chat's TARGET SET — the pure half of the `@`-mention target picker
// (Subtask MOTIR-1491; design `design/ai-chat/target-picker.mock.html`). Typing
// `@` in the planning composer searches the project's work items and picking one
// adds it to this set; the set is what the turn is ANCHORED at when it reaches
// the contextual planning session (7.12.3 · MOTIR-909).
//
// Kept framework-free (no React, no `server-only`) so the composer, the host and
// the tests all derive the same behaviour from one place — the `launcher.ts`
// precedent. The transport lives in `planChangeClient`; the UI in
// `PlanChangeComposer`.

/** One picked target — everything the chip renders plus both identities the
 *  contextual submit needs: the DB `id` (the route's path anchor) and the
 *  `identifier` (what `targetKeys[]` carries). */
export interface PlanningTarget {
  id: string;
  identifier: string;
  title: string;
  kind: WorkItemKindDto;
}

/**
 * How many targets one turn may carry. The bound is the SERVER's
 * (`MAX_SCOPE_TARGETS`, 7.12.3): the scope is pushed to motir-ai as the union of
 * every anchor's neighborhood, so an unbounded set blows the planner's context
 * window. Mirrored here so the picker stops ADDING at the same number the route
 * would reject at, rather than letting the user build a set that 400s on send.
 */
export const MAX_PLANNING_TARGETS = MAX_SCOPE_TARGETS;

/** Case-insensitive, because work-item identifiers are case-insensitive
 *  everywhere else in the API (and `buildScope` dedupes the same way). */
function sameItem(a: PlanningTarget, identifier: string): boolean {
  return a.identifier.toUpperCase() === identifier.toUpperCase();
}

/**
 * Add a target, preserving PICK ORDER — the first pick is the PRIMARY anchor (the
 * canvas highlights it and the contextual route takes it as the path item), so
 * the set is an ordered list rather than a `Set`. Re-picking an item already in
 * the set is a no-op (same array back), and the cap is enforced here so the
 * composer never has to.
 */
export function addPlanningTarget(
  targets: readonly PlanningTarget[],
  target: PlanningTarget,
): PlanningTarget[] {
  if (targets.some((t) => sameItem(t, target.identifier))) return [...targets];
  if (targets.length >= MAX_PLANNING_TARGETS) return [...targets];
  return [...targets, target];
}

/** Remove one target by identifier (the chip's ⨉). Removing the first PROMOTES
 *  the next pick to primary — which is what the user asked for by dropping it. */
export function removePlanningTarget(
  targets: readonly PlanningTarget[],
  identifier: string,
): PlanningTarget[] {
  return targets.filter((t) => !sameItem(t, identifier));
}

/** The PRIMARY anchor — the first pick (or the entrance's pre-filled item). */
export function primaryPlanningTarget(targets: readonly PlanningTarget[]): PlanningTarget | null {
  return targets[0] ?? null;
}

/** The ADDITIONAL anchors, as the identifiers `targetKeys[]` carries. The primary
 *  is excluded: it travels as the route's path item, and the service adds it to
 *  the scope itself — passing it twice would be the same anchor stated two ways. */
export function extraPlanningTargetKeys(targets: readonly PlanningTarget[]): string[] {
  return targets.slice(1).map((t) => t.identifier);
}

/**
 * Did this edit TYPE the target-search shortcut? (Story MOTIR-6894 · MOTIR-6897;
 * design `target-picker--search-and-canvas.mock.html` panel 4.)
 *
 * The composer's `@` no longer starts an INLINE query — that query ended at the
 * first space, so `@plan approval` searched `plan`. It is a SHORTCUT: an `@`
 * typed at the start of the message or after whitespace opens the target search
 * popover, whose own field takes the query, and the `@` is CONSUMED so no stray
 * `@` is left in the message. An `@` inside a word (`foo@bar`) is an ordinary
 * character.
 *
 * Derived from the edit itself rather than from a keydown, because a keydown's
 * `key` is not reliable across IMEs and on-screen keyboards, while every input
 * path ends in the same change: `next` is `previous` with ONE `@` inserted just
 * before `caret`. Anything else — a paste, a deletion, a replaced selection —
 * returns `null` and is ordinary typing.
 *
 * Returns the draft and caret to restore (the text as it was before the `@`).
 */
export function consumeTargetShortcut(
  previous: string,
  next: string,
  caret: number,
): { text: string; caret: number } | null {
  if (next.length !== previous.length + 1) return null;
  const at = caret - 1;
  if (at < 0 || next[at] !== '@') return null;
  if (next.slice(0, at) + next.slice(at + 1) !== previous) return null;
  const before = at === 0 ? '' : next[at - 1]!;
  if (before !== '' && !/\s/.test(before)) return null;
  return { text: previous, caret: at };
}
