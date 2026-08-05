import { StationCard } from '@/components/onboarding/StationNode';
import { ORIGIN_ID } from '@/components/planning/workItemLevel';
import type { StationView } from '@/lib/onboarding/canvasModel';
import {
  DIRECTION_DOC_ORDER,
  TIER_META,
  type DirectionDocKind,
} from '@/lib/onboarding/directionDoc';
import { findTierDoc, producedTierKinds } from '@/lib/onboarding/preplanClient';
import { positionFor } from '@/lib/onboarding/stationLayout';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';

// The DRILLED PRE-PLAN STATION LEVEL (MOTIR-2205 / design
// `design/roadmap/planning-origin-drill.*` panel B) — the level the roadmap's
// planning phase card opens into. It is SYNTHETIC: no work item backs any of these
// nodes and no `fetchRoadmapLevel` call serves them; they are built straight from
// the project's pre-plan read, which is why the read only has to happen once the
// user asks to see them (the MOTIR-2069 streaming lesson — nothing here is owed
// before the roadmap's first paint).
//
// Nothing on this level is a new treatment. The cards are the SHIPPED `StationCard`
// (`components/onboarding/StationNode.tsx`) the onboarding canvas already draws —
// same tier tile + per-tier accent from `TIER_META`, same plain-language title,
// same captured-findings rows, same "Reviewed" pill — and `viewable` marks exactly
// the produced ones, so the canvas's own View button opens their doc, the same way
// `OnboardingCanvas` already routes it (`isDirectionDocKind(id) && openable`).
//
// FOUR of the six `STATION_ORDER` stations appear (design DECISION 1). `design` and
// `plan` are dropped, each for the same reason: neither holds a document, so neither
// could ever be openable, and a station you cannot open on a level whose whole
// purpose is opening things is noise. (`design` carries a CTA into the LIVE
// onboarding design step; `plan` previews the work-item tree — which is the level
// the user just drilled OUT of, one Back away.)

// The station card's authored size (`components/onboarding/StationNode.tsx`:
// `w-[300px]`), used only as the pre-measure fit-to-view hint so all four are
// framed rather than clipped.
const STATION_W = 300;
const STATION_H = 220;

/**
 * Build the drilled pre-plan station level from a pre-plan read.
 *
 * `state` is `null` when the read failed or the project has no pre-plan session at
 * all (motir-ai down / unauthenticated / no active project). That is NOT an error
 * state here: it renders the same four `upcoming` stations naming the journey's
 * shape, none of them openable — a drill into a journey that produced nothing still
 * lands somewhere worth being (design panel E), never on an error.
 */
export function buildPreplanStationLevel(state: PreplanStateDTO | null): {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
} {
  const produced = new Set<DirectionDocKind>(state ? producedTierKinds(state) : []);

  const nodes: ProjectCanvasNode[] = DIRECTION_DOC_ORDER.map((kind) => {
    const isProduced = produced.has(kind);
    // A produced tier is the full "done" card (findings + the mint Reviewed pill);
    // an unproduced one is the shipped `upcoming` face — softened card, no footer,
    // and the "can skip" tag on the optional tiers. Neither is a new state: this is
    // `StationView` exactly as `buildStations` shapes it, minus the live-journey
    // states (`active` / `working` / `deciding`), which cannot occur on a roadmap
    // whose plan has already been materialized.
    const station: StationView = {
      kind,
      state: isProduced ? 'done' : 'upcoming',
      optional: TIER_META[kind].optional,
      openable: isProduced,
    };
    return {
      id: kind,
      // The stations hang off the phase card, which is the level's parent.
      parentId: ORIGIN_ID,
      drillable: false,
      // The SAME rule the onboarding canvas applies: only a tier that produced a
      // document is viewable, so an unproduced station surfaces no View button at
      // all. `WorkItemRoadmap`'s `onView` routes these ids to the tier-doc modal.
      viewable: isProduced,
      searchText: `${TIER_META[kind].label} ${kind}`,
      crumbLabel: TIER_META[kind].label,
      content: (
        <StationCard
          station={station}
          doc={(state ? findTierDoc(state, kind) : null) ?? undefined}
          // The roadmap has no live `DiscoverySession`; the pre-plan read carries
          // one when the project has a session, and `StationCard` treats it as
          // optional (MOTIR-2205), so a project without one still renders.
          session={state?.session ?? undefined}
        />
      ),
      // The stations keep the onboarding canvas's own tier row, so the two surfaces
      // draw the same journey in the same shape.
      ...positionFor(kind, {}),
      // A station card is wider than the default work-item node box; hint its real
      // size so the once-only fit-to-view frames all four instead of clipping them.
      width: STATION_W,
      height: STATION_H,
    };
  });

  // The journey sequence, as `flow` edges: DRAWN, but deliberately not counted
  // toward the "Dependencies" legend (these are not blocked_by relationships).
  // Firm once both ends have produced, dashed while the chain is incomplete — the
  // same `variantOf` reading the onboarding station serpentine uses.
  const deps: ProjectCanvasDep[] = DIRECTION_DOC_ORDER.slice(0, -1).map((from, i) => {
    const to = DIRECTION_DOC_ORDER[i + 1]!;
    return {
      from,
      to,
      variant: produced.has(from) && produced.has(to) ? 'firm' : 'pending',
      kind: 'flow',
    };
  });

  return { nodes, deps };
}
