import type { PlanningGuideSeedDTO, PlanningSeedGuideDTO } from '@/lib/dto/planningSeed';
import type { PlanningLaunch } from '@/lib/planning/launcher';
import type { PlanningTarget } from '@/lib/planning/planningTargets';

// A GUIDE RE-PLAN OFFER AS THE OVERLAY LAUNCHES IT (Story MOTIR-8684 · MOTIR-8693).
//
// The pure half of the overlay's guide-offer start: what the seed read SETTLED on and
// the launch it resolves to. Framework-free so the overlay stays under its size and the
// resolution is unit-testable without a render. The shape mirrors the gate seed's
// (`SeedLoad` in `PlanningWorkspaceOverlay`), because a guide offer starts the way a
// picked option does: the same skeleton window, the same anchor read, the same host
// mount, the same silent fallback.

/**
 *  · `seeded`   — an undecided offer: a `contextual` launch on its target with the
 *                 guide's request SENT once as the first turn;
 *  · `resume`   — the offer already started a session: that conversation, reopened,
 *                 with nothing sent;
 *  · `fallback` — a null seed or a failed read: a plain project launch, SILENTLY, so
 *                 nothing says the offer exists to someone who may not read it.
 */
export type GuideSeedLoad =
  | {
      offerId: string;
      kind: 'seeded';
      anchorKey: string;
      firstTurn: string;
      guide: PlanningSeedGuideDTO;
      /** The guided card, when it is not the target: the session's scope holds both, so
       *  the plan's card hold parks the guided card at Planning as well. */
      extraTargets: PlanningTarget[];
    }
  | {
      offerId: string;
      kind: 'resume';
      anchorKey: string;
      sessionId: string;
      guide: PlanningSeedGuideDTO;
    }
  | { offerId: string; kind: 'fallback' };

/** The unseeded fall-back — exactly what *Plan with AI* on the project opens. */
export const PROJECT_FALLBACK_LAUNCH: PlanningLaunch = {
  mode: 'project',
  from: 'project',
  itemKey: null,
  repoKey: null,
};

/** The prefix of the page-level claim the one-time send is held under. */
export const GUIDE_AUTO_SEND_PREFIX = 'guide:';

/** Resolve a settled seed read (or its absence) into what the overlay holds. */
export function guideSeedLoad(
  offerId: string,
  seed: PlanningGuideSeedDTO | null,
  guidedTarget: PlanningTarget | null,
): GuideSeedLoad {
  if (seed === null) return { offerId, kind: 'fallback' };
  if (seed.seededSessionId) {
    return {
      offerId,
      kind: 'resume',
      anchorKey: seed.anchorKey,
      sessionId: seed.seededSessionId,
      guide: seed.guide,
    };
  }
  const guidedIsTarget = seed.guide.guidedKey.toUpperCase() === seed.anchorKey.toUpperCase();
  return {
    offerId,
    kind: 'seeded',
    anchorKey: seed.anchorKey,
    firstTurn: seed.firstTurn,
    guide: seed.guide,
    extraTargets: guidedIsTarget || guidedTarget === null ? [] : [guidedTarget],
  };
}

/**
 * The guided card as a target, from what the seed carries when its own read could not
 * place it (the id is the route's path anchor only for the PRIMARY target; an extra
 * rides as its identifier alone, so a card whose read failed still joins the scope).
 */
export function guidedTargetFallback(guide: PlanningSeedGuideDTO): PlanningTarget {
  return { id: '', identifier: guide.guidedKey, title: guide.guidedTitle, kind: 'task' };
}

/** The launch the WORKSPACE sees for a settled seed: the target as an ordinary item
 *  launch (a resume names its session), or the project when nothing can be placed. */
export function guideWorkspaceLaunch(seed: GuideSeedLoad | null): PlanningLaunch {
  if (seed === null || seed.kind === 'fallback') return PROJECT_FALLBACK_LAUNCH;
  return {
    mode: 'contextual',
    from: 'work-item',
    itemKey: seed.anchorKey,
    repoKey: null,
    ...(seed.kind === 'resume' ? { sessionId: seed.sessionId } : {}),
  };
}
