'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { shallowReplace } from '@/lib/navigation/shallowUrl';
import { withoutApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { fetchPlanReview } from '@/lib/planning/planReviewClient';

// THE APPROVAL OVERLAY'S ONE PLAN ARM (Story MOTIR-6012 · MOTIR-6037; ADR
// `approval-gates.md` §11.5b; design `design/ai-planning/design-notes.md` Part XX §20.2).
//
// A plan gate is decided on the PLANNING SURFACE and renders no port, so nothing writes
// `?approval=` for `plan_approval` — its To-approve row returns to the planning surface
// itself. An address that hands the overlay one anyway is a stale or hand-typed link,
// and the overlay must not answer it with an empty frame. So it FORWARDS: the `approval`
// value is read as the PLAN's id, and the reader lands on the planning surface at the
// plan's conversation (`planSession` + `planVia=approvals`, the row's own address) — or
// on the plan's own page when it has no SESSION to return to (Story MOTIR-6043's
// settlement: the session's existence, never its turn count), or the read fails.
//
// ⚠️ A FORWARD, NOT A CLOSE — which is why it lives here rather than in the overlay. The
// overlay has exactly one close seam (`requestClose`, guarded by
// `tests/integration/approvals/approval-overlay-story-gate.test.tsx`). This is a
// REPLACE: Back must not return to an address that only bounces again.

/** Forward a plan gate's overlay address; `planId` null means there is nothing to do. */
export function usePlanGateForward(planId: string | null): void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (planId === null) return;
    const controller = new AbortController();
    const planPage = `/plans/${encodeURIComponent(planId)}`;
    void (async () => {
      try {
        const review = await fetchPlanReview(planId, controller.signal);
        if (controller.signal.aborted) return;
        const conversation = review.conversation ?? null;
        // ⚠️ THE SESSION, NOT ITS TURNS (Story MOTIR-6043 · MOTIR-6045). This read
        // `!conversation?.hasTurns` until the settlement: an empty transcript is not
        // an absent conversation, so an agent's plan, a cadence plan and a backfilled
        // one all have somewhere to return to. Only a plan with NO session lands on
        // the page — the same predicate `planRowDestination` answers for both rows.
        if (!conversation) {
          router.replace(planPage);
          return;
        }
        const host = withoutApprovalOverlay(`${pathname}?${searchParams.toString()}`);
        const first = conversation.targetKeys[0];
        shallowReplace(
          withPlanningOverlay(
            host,
            first
              ? {
                  kind: 'work-item',
                  itemKey: first,
                  sessionId: conversation.sessionId,
                  via: 'approvals',
                }
              : { kind: 'project', sessionId: conversation.sessionId, via: 'approvals' },
          ),
        );
      } catch {
        if (controller.signal.aborted) return;
        router.replace(planPage);
      }
    })();
    return () => controller.abort();
  }, [planId, pathname, searchParams, router]);
}
