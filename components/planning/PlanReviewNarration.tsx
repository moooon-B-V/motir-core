'use client';

import { useEffect, useRef, useState } from 'react';
import { PlanNarration } from '@/components/planning/PlanNarration';
import {
  groupNarration,
  liveNarrationSessions,
  mergeNarrationEntries,
  narrationEarlierCount,
} from '@/components/planning/planNarration';
import { fetchPlanNarrationPage } from '@/lib/planning/planReviewClient';
import type { PlanNarrationDto } from '@/lib/dto/plans';
import type { PlanReviewDto } from '@/lib/dto/planReview';

/**
 * THE PLANNER'S NARRATION on the PLAN PAGE (Story MOTIR-8060 · MOTIR-8064).
 *
 * The plan page (`/plans/[id]`, and a Visitor's `/p/<key>/plans/<id>`) hosts
 * `PlanReviewRail`, not the overlay's `PlanChangeRail`, so the narration the
 * overlay draws from its conversation hook has to be drawn here from the review
 * the page already polls. Same read, same grouping, same component: the groups
 * come from `review.narration` alone, and the earlier pages a reader asks for
 * are kept beside it — keyed by `seq`, dropped when the plan changes, and never
 * overwritten by the poll's window.
 */
export function PlanReviewNarration({ review }: { review: PlanReviewDto }) {
  const narration = review.narration ?? null;
  const [earlier, setEarlier] = useState<{ planId: string; entries: PlanNarrationDto[] }>({
    planId: review.id,
    entries: [],
  });
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const kept = earlier.planId === review.id ? earlier.entries : [];
  const entries = narration ? mergeNarrationEntries(kept, narration.entries) : [];
  const earlierCount = narrationEarlierCount(entries);

  const showEarlier = async () => {
    if (loading || entries.length === 0 || earlierCount === 0) return;
    const planId = review.id;
    setLoading(true);
    try {
      const page = await fetchPlanNarrationPage(planId, entries[0]!.seq);
      if (!mounted.current) return;
      setEarlier((prev) => ({
        planId,
        entries: mergeNarrationEntries(
          page.entries,
          prev.planId === planId ? prev.entries : [],
          entries,
        ),
      }));
    } catch {
      /* the affordance stays; a later press tries again */
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  if (!narration) return null;
  const groups = groupNarration(
    { sessions: narration.sessions, entries },
    liveNarrationSessions(review),
  );
  return (
    <section data-testid="plan-review-narration" className="flex flex-col gap-2">
      <PlanNarration
        groups={groups}
        total={narration.earlierCount + narration.entries.length}
        earlierCount={earlierCount}
        loadingEarlier={loading}
        onShowEarlier={() => void showEarlier()}
      />
    </section>
  );
}
