// The onboarding CANVAS model (Subtask 7.3.11 / MOTIR-840) — the pure state
// machine behind the canvas roadmap (design `design/ai-chat`, screen C). It turns
// the discovery loop's state into the ordered list of roadmap STATIONS and their
// visual state, and extracts each produced tier's short "captured findings" from
// its read-only body. Kept PURE (no React, no fetch) so it is fully unit-testable;
// the `RoadmapCanvas` component maps these descriptors to the design system.
//
// The roadmap is the pre-plan pipeline: Idea → the four direction tiers → Design →
// Plan (screen C). The Design + Plan stations are SLOTS the downstream cards fill
// (the design step is 7.3.27 / MOTIR-1040; the post-plan epic roadmap is a separate
// Epic-7 story) — here they render as "upcoming" markers so the journey is visible
// end to end.

import {
  type DirectionDocKind,
  DIRECTION_DOC_ORDER,
  TIER_META,
  stripLeadingTitle,
} from './directionDoc';
import type { DiscoveryState } from './discoveryLoop';

// Every station on the vertical roadmap below the idea node, in journey order:
// the four direction tiers, then the `design` + `plan` forward slots. (The seed
// idea renders as its own node above these, not as a station.)
export type StationKind = DirectionDocKind | 'design' | 'plan';

// done = reviewed/captured; active = the current frontier under work; deciding =
// the validation frontier parked on the blocking validate-early ask; upcoming =
// not reached yet.
export type StationState = 'done' | 'active' | 'deciding' | 'upcoming';

export interface StationView {
  kind: StationKind;
  state: StationState;
  /** Optional tiers (feasibility, validation) + the design step carry a "can skip" tag. */
  optional: boolean;
  /** A produced tier whose read-only review the user can re-open by clicking it. */
  openable: boolean;
}

/** The station order below the idea node: the four tiers → design → plan. */
export const STATION_ORDER: readonly StationKind[] = [...DIRECTION_DOC_ORDER, 'design', 'plan'];

/**
 * Build the ordered station list + each station's visual state from the loop
 * state. The frontier (the active/deciding station) is the validation tier when
 * the blocking validate-early ask is parked, else the tier under review, else the
 * latest produced tier — and, before any tier exists, the first not-done station
 * (discovery) so there is always a "you are here". Earlier produced tiers read
 * "done"; unreached ones "upcoming". Idea is "done" once any tier exists (it has
 * been captured into the discovery write-up), "active" while the very first draft
 * is still forming.
 */
export function buildStations(state: DiscoveryState): StationView[] {
  const produced = new Set<DirectionDocKind>(state.producedKinds);
  const deciding = state.pendingAsk !== null;
  const tiersComplete = state.session.status === 'tiers_complete';
  // The tier the conductor is mid-draft on (grounding/drafting). It reads as the
  // live frontier so a tier being formed shows "you are here", not "upcoming".
  const workingTier = state.working?.tier ?? null;
  // The frontier (the active/deciding station). Once any tier exists we anchor on
  // the deciding tier, the tier under review, the tier mid-draft, or the latest
  // produced one — as before. But when NOTHING has been produced yet and the
  // session is still going, anchor on the FIRST not-done station (the next step
  // the user is at — discovery) so the canvas always shows a current position.
  // (MOTIR-1258: an empty `producedKinds` previously left the frontier `null` and
  // every station "upcoming", so the whole skeleton ghosted with no "you are
  // here" — the state every never-onboarded project hydrates to.) Stays `null`
  // only once the tiers are complete, where the design slot takes over.
  const frontier: DirectionDocKind | null = deciding
    ? 'validation'
    : (state.activeKind ??
      workingTier ??
      (state.producedKinds.length
        ? state.producedKinds[state.producedKinds.length - 1]!
        : tiersComplete
          ? null
          : firstNotDoneTier(produced)));

  return STATION_ORDER.map((kind): StationView => {
    if (kind === 'design' || kind === 'plan') {
      // Forward slots — "upcoming" until their downstream card drives them; the
      // design step becomes the frontier once the tiers are all reviewed.
      const active = kind === 'design' && tiersComplete;
      return {
        kind,
        state: active ? 'active' : 'upcoming',
        optional: kind === 'design',
        openable: false,
      };
    }
    // A direction tier.
    if (!produced.has(kind)) {
      // A not-yet-produced tier is "upcoming" UNLESS it is the frontier — the
      // first step the user is at, or the one the conductor is mid-draft on —
      // which renders "active" ("you are here") / "deciding" so the canvas is
      // never an all-ghosted skeleton. `openable` stays false: no saved doc yet.
      const stationState: StationState =
        kind === frontier
          ? deciding && kind === 'validation'
            ? 'deciding'
            : 'active'
          : 'upcoming';
      return { kind, state: stationState, optional: TIER_META[kind].optional, openable: false };
    }
    let stationState: StationState = 'done';
    if (kind === frontier) {
      stationState = deciding && kind === 'validation' ? 'deciding' : 'active';
    }
    return { kind, state: stationState, optional: TIER_META[kind].optional, openable: true };
  });
}

/** The first tier not yet produced, in journey order (discovery when none are). */
function firstNotDoneTier(produced: Set<DirectionDocKind>): DirectionDocKind | null {
  return DIRECTION_DOC_ORDER.find((kind) => !produced.has(kind)) ?? null;
}

/**
 * Extract a tier's short "captured findings" for its canvas station — the first
 * couple of meaningful (non-heading, non-empty) lines of its read-only body,
 * stripped of Markdown emphasis and clamped. Honest by construction: it shows what
 * the tier actually captured, never an invented summary. Returns `[]` for an empty
 * body (the station then shows just its title + state).
 */
export function captureLines(contentMd: string | undefined, max = 2): string[] {
  const body = stripLeadingTitle(contentMd ?? '');
  const lines: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue; // skip headings/quotes
    const text = line
      .replace(/^[-*+]\s+/, '') // list marker
      .replace(/^\d+\.\s+/, '') // ordered list marker
      .replace(/\*\*(.+?)\*\*/g, '$1') // bold
      .replace(/\*(.+?)\*/g, '$1') // italic
      .replace(/`(.+?)`/g, '$1') // inline code
      .replace(/\[(.+?)\]\([^)]*\)/g, '$1') // links → label
      .trim();
    if (!text) continue;
    lines.push(text.length > 100 ? `${text.slice(0, 99)}…` : text);
    if (lines.length >= max) break;
  }
  return lines;
}
