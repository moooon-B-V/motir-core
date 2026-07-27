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

/** The `@` query the caret currently sits in. */
export interface MentionQueryRange {
  /** The text typed after the `@` (empty right after the trigger). */
  query: string;
  /** Index of the `@` itself. */
  start: number;
  /** Index just past the query (the caret). */
  end: number;
}

/**
 * Find the `@`-mention query the caret is inside, or null when there is none.
 *
 * The composer is a PLAIN TEXT INPUT (not the rich-text editor's Tiptap
 * suggestion plugin — the design is explicit that this is a standalone combobox),
 * so the trigger is derived from the text before the caret: an `@` at the start of
 * the value or after whitespace, followed by non-whitespace, non-`@` characters.
 * That makes an email-ish `foo@bar` NOT a trigger, and a second `@` closes the
 * first query rather than nesting.
 */
export function findMentionQuery(text: string, caret: number): MentionQueryRange | null {
  const upToCaret = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(?:^|\s)@([^\s@]*)$/.exec(upToCaret);
  if (!match) return null;
  const query = match[1] ?? '';
  return { query, start: upToCaret.length - query.length - 1, end: upToCaret.length };
}

/**
 * The composer text once a pick has consumed its `@` query. The chip lands in the
 * TRAY, not inline in the message (design panel 2), so the query token is removed
 * and the caret closes over the gap — the user keeps typing the same sentence.
 */
export function clearMentionQuery(
  text: string,
  range: MentionQueryRange,
): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  return { text: `${before}${after}`, caret: before.length };
}
