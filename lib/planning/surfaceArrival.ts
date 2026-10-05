import type { PlanningAnchor, PlanningAnchorAncestor } from '@/lib/planning/planningAnchorClient';
import { workItemCrumbLabel, type CanvasCrumb } from '@/lib/planning/projectCanvasModel';

// THE ARRIVAL RULE for the universal planning surface's canvas (MOTIR-6160,
// Story MOTIR-6154) — where the canvas OPENS, for every entrance.
//
// ── What it replaces ────────────────────────────────────────────────────────
// `PlanningWorkspaceOverlay` used to build the trail inline as the anchor's
// ANCESTORS ONLY, so the workspace opened BESIDE the item — on its parent's
// level, with the item among its siblings wearing the target ring. That was
// MOTIR-2070's deliberate choice, and its comment gave the reason: "Opening on
// the anchor's CHILDREN would hide the item the conversation is about."
//
// The requester has overturned it. A person who asks Motir to plan a story
// expects to look at that story's work while they talk about it, and once the
// planner has somewhere to put the plan, the canvas should stand where the plan
// is going — which is INSIDE the target, on the level its proposals land on.
//
// MOTIR-2070's objection is answered rather than ignored: the target stays
// NAMED, as the last crumb of the breadcrumb — the level you are standing in —
// carrying the design's target marker. See `design/ai-chat/design-notes.md`
// § "⭐ The canvas ARRIVES INSIDE the node being planned".
//
// ── Why this is a pure function in `lib/` ───────────────────────────────────
// Three entrances reach the overlay as a `work-item` launch carrying
// `planItem=` — "Plan with AI" on a card, a Plans row, and a To-approve row
// (MOTIR-6033 § 20.2 writes `planItem=` whenever the plan has a target). One
// rule therefore serves all three, and putting it here means it is decided in
// one place, tested once, and callable by the FOLLOW-MOVE card (MOTIR-6161)
// when a target becomes known after the surface is already open.
//
// ── This is the ROADMAP's rule, hoisted — not a second copy of it ───────────
// `app/(authed)/roadmap/page.tsx`'s `resolveArrivalTrail` already builds
// `[...ancestors, item]` from this same anchor read, and its comment names the
// surface it was deliberately one crumb deeper than: "the planning overlay's
// own `planItem=` anchor, which opens on the anchor's OWN level so the anchor
// is visible; the two surfaces want different things and keep the same param
// name." That sentence is what this card retires — the two surfaces now want
// the same thing.
//
// ⚠️ ONE LIMB OF THE ROADMAP'S VERSION IS NOT HERE, AND IT IS A PROPERTY OF THE
// READ RATHER THAN OF THE RULE. `resolveArrivalTrail` runs on the SERVER and
// prepends the item's placement-FOLDER chain, because a filed item sits behind
// its folder's door and a trail without those crumbs is a level a reader could
// not have reached by hand. This function runs on the CLIENT, from
// `GET /api/work-items/planning-anchor`, whose payload carries the anchor and
// its work-item ancestors and NO placement — so no folder crumb can be built
// here, whatever the rule says. The shipped ancestors-only trail had exactly
// the same gap, so nothing regresses; closing it means teaching the anchor read
// to carry placement, which is not this card's scope. Recorded in the design's
// own arrival section so the next reader meets it there too.

/** What the arrival rule needs: the resolved anchor, or `null` when the read
 *  answered `404` — the no-existence-leak answer for a stale, deleted, foreign
 *  or forbidden key alike (`fetchPlanningAnchor`) — and whether the anchor has
 *  any children to open onto. */
export interface SurfaceArrivalInput {
  anchor: Pick<PlanningAnchor['anchor'], 'id' | 'identifier' | 'title' | 'kind'> | null;
  ancestors: readonly PlanningAnchorAncestor[];
  hasChildren: boolean;
}

// ── INSIDE ⇔ THE ANCHOR HAS CHILDREN (MOTIR-7621) ──────────────────────────
// This used to be decided by KIND: every kind but `subtask` "has an inside",
// per the kind-parent matrix. That answers whether an item CAN have children,
// not whether it DOES — and a story, task or bug not yet broken down is common
// (a freshly filed bug, a small task). Opening inside one landed the canvas on
// an empty level with the target visible only as the last crumb, which looks
// like a failed load and is exactly MOTIR-2070's complaint. So the rule now
// reads the anchor read's `hasChildren`. A `subtask` stays a leaf by
// construction: nothing may be parented to it, so it never has children.

/**
 * The breadcrumb trail the surface canvas OPENS on, root-ancestor first.
 *
 * `ProjectRoadmapCanvas` reads its `initialTrail` once at mount and loads the
 * level named by the LAST crumb, with the whole array becoming the breadcrumb —
 * so changing what this returns changes the arrival without touching the canvas
 * engine at all.
 *
 * - an anchor WITH children → `ancestors ++ [anchor]`, so the canvas opens on
 *   the anchor's CHILDREN and the breadcrumb ends at the anchor;
 * - a CHILDLESS anchor (any kind) → `ancestors`, the own-level arrival, where
 *   the target is marked by the shipped node ring rather than by a crumb;
 * - no anchor (`null`) → `[]`, the project root, silently. This is the
 *   degradation the overlay already applies for an unresolvable `?planItem=`,
 *   and it is deliberately indistinguishable from "no target was named".
 */
export function surfaceArrivalTrail({
  anchor,
  ancestors,
  hasChildren,
}: SurfaceArrivalInput): CanvasCrumb[] {
  const trail: CanvasCrumb[] = ancestors.map((a) => ({
    id: a.id,
    crumbKey: a.identifier,
    label: workItemCrumbLabel(a.identifier, a.title),
  }));

  if (anchor === null) return [];
  if (!arrivesInsideAnchor({ anchor, hasChildren })) return trail;

  trail.push({
    id: anchor.id,
    crumbKey: anchor.identifier,
    label: workItemCrumbLabel(anchor.identifier, anchor.title),
  });
  return trail;
}

/**
 * Does the canvas stand INSIDE this anchor (rather than beside it)?
 *
 * The overlay needs the same predicate to decide whether the last crumb is the
 * TARGET crumb — the design's answer to MOTIR-2070 — and deriving it a second
 * time from `trail.length` would be a second encoding of the rule above.
 */
export function arrivesInsideAnchor({
  anchor,
  hasChildren,
}: Pick<SurfaceArrivalInput, 'anchor' | 'hasChildren'>): boolean {
  return anchor !== null && hasChildren;
}
