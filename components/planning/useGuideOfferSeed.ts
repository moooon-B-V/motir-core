'use client';

import { useEffect, useState } from 'react';
import { fetchGuidePlanningSeed } from '@/lib/planning/planningSeedClient';
import { fetchPlanningAnchor } from '@/lib/planning/planningAnchorClient';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import {
  guidedTargetFallback,
  guideSeedLoad,
  type GuideSeedLoad,
} from '@/lib/planning/guideOfferLaunch';
import type { PlanningGuideSeedDTO } from '@/lib/dto/planningSeed';

/** The guided card read as a target, or its fall-back when the read cannot place it. */
async function readGuidedTarget(
  seed: PlanningGuideSeedDTO,
  signal: AbortSignal,
): Promise<PlanningTarget> {
  try {
    const found = await fetchPlanningAnchor(seed.guide.guidedKey, signal);
    if (found) {
      const { id, identifier, title, kind } = found.anchor;
      return { id, identifier, title, kind };
    }
  } catch {
    /* the card still joins the scope by its key */
  }
  return guidedTargetFallback(seed.guide);
}

/**
 * READ A GUIDE OFFER'S SEED while the overlay's skeleton shows (Story MOTIR-8684 ·
 * MOTIR-8693) — the gate seed's read, addressed by the offer's turn id.
 *
 * `null` while pending; the settled load once the read (and, for a fresh offer whose
 * guided card is not its target, the guided card's own read) has answered. Pending is
 * DERIVED (`offerId` mismatch), never written in the effect. A null seed and a failed
 * read are the same SILENT fall-back: an outage is not a finding about the offer, and
 * saying so would confirm to someone who cannot read it that it exists.
 */
export function useGuideOfferSeed(open: boolean, offerId: string | null): GuideSeedLoad | null {
  const [load, setLoad] = useState<GuideSeedLoad | null>(null);
  // A close forgets the seed, so the next open of the same offer reads it again — a
  // send in between started a session the door must now return to.
  if (!open && load !== null) setLoad(null);
  useEffect(() => {
    if (!open || offerId === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const seed = await fetchGuidePlanningSeed(offerId, controller.signal);
        if (controller.signal.aborted) return;
        const needsGuided =
          seed !== null &&
          !seed.seededSessionId &&
          seed.guide.guidedKey.toUpperCase() !== seed.anchorKey.toUpperCase();
        const guided =
          seed !== null && needsGuided ? await readGuidedTarget(seed, controller.signal) : null;
        if (controller.signal.aborted) return;
        setLoad(guideSeedLoad(offerId, seed, guided));
      } catch {
        if (controller.signal.aborted) return;
        setLoad({ offerId, kind: 'fallback' });
      }
    })();
    return () => controller.abort();
  }, [open, offerId]);
  return load !== null && load.offerId === offerId ? load : null;
}
