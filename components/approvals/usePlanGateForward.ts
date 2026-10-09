'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { shallowReplace } from '@/lib/navigation/shallowUrl';
import { withoutApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { planSessionLaunchContext } from '@/lib/planning/planDestination';
import { fetchPlanReview } from '@/lib/planning/planReviewClient';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// THE APPROVAL OVERLAY'S ONE PLAN ARM (Story MOTIR-6012 · MOTIR-6037; ADR
// `approval-gates.md` §11.5b; design `design/ai-planning/design-notes.md` Part XXII §22.2).
//
// A plan gate is decided on the PLANNING SURFACE and renders no port, so nothing writes
// `?approval=` for `plan_approval` — its To-approve row returns to the planning surface
// itself. An address that hands the overlay one anyway is a stale or hand-typed link,
// and the overlay must not answer it with an empty frame. So it FORWARDS: the `approval`
// value is read as the PLAN's id, and the reader lands on the planning surface at the
// plan's conversation (`planSession` + `planVia=approvals`, the row's own address). A
// Visitor, and a read that fails, land on the plan's own page. Every plan has a session
// (Story MOTIR-7883 · MOTIR-7885), so a review with none is an invariant breach and takes
// the failed read's path, silently.
//
// ⚠️ A FORWARD, NOT A CLOSE — which is why it lives here rather than in the overlay. The
// overlay has exactly one close seam (`requestClose`, guarded by
// `tests/integration/approvals/approval-overlay-story-gate.test.tsx`). This is a
// REPLACE: Back must not return to an address that only bounces again.

/** Forward a plan gate's overlay address; `planId` null means there is nothing to do. */
export function usePlanGateForward(planId: string | null): void {
  const routes = useReaderRoutes();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (planId === null) return;
    const controller = new AbortController();
    const planPage = routes.plan(planId);
    void (async () => {
      try {
        const review = await fetchPlanReview(planId, controller.signal);
        if (controller.signal.aborted) return;
        // A Visitor (MOTIR-6888) is not served the planning workspace: the page.
        if (routes.identifier !== null) {
          router.replace(planPage);
          return;
        }
        // ⚠️ THE SESSION, NOT ITS TURNS (Story MOTIR-6043 · MOTIR-6045): an empty
        // transcript is still a conversation to return to. A review with NO session
        // is the invariant breach (MOTIR-7885) and degrades exactly as a failed read.
        const conversation = review.conversation;
        if (!conversation) throw new Error('plan without a session');
        const host = withoutApprovalOverlay(`${pathname}?${searchParams.toString()}`);
        shallowReplace(
          withPlanningOverlay(
            host,
            planSessionLaunchContext(
              conversation.sessionId,
              conversation.targetKeys[0],
              'approvals',
            ),
          ),
        );
      } catch {
        if (controller.signal.aborted) return;
        router.replace(planPage);
      }
    })();
    return () => controller.abort();
  }, [planId, pathname, searchParams, router, routes]);
}
