'use client';

import { useCallback } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { shallowReplace } from '@/lib/navigation/shallowUrl';
import { withoutApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { withPlanningOverlay } from '@/lib/planning/launcher';

// THE REFUSAL'S HAND-OFF TO THE SEEDED PLANNER (Story MOTIR-6068 · Subtask MOTIR-6211;
// ADR `approval-gates.md` §10f; design `design/ai-chat/design-notes.md` § *The SEEDED
// re-plan*, sheet 1, and `design/work-items/design-notes.md` § *The RE-PLAN WITH AI door*).
//
// ⚠️ THE ONE FUNCTION every refusal's ask and every Re-plan with AI door calls. The
// design and acceptance verdicts (MOTIR-6070 / MOTIR-6071) reuse it, so a second copy of
// "strip the approval address, write the planning one" never exists.
//
// ⚠️ ONE ADDRESS REPLACE, NEVER A PUSH — `usePlanGateForward`'s precedent. Yes answers the
// approval overlay's question, so the approval address is stripped (`approval` /
// `approvalKind`) and the planning address written in the SAME history entry: there is
// nothing for Back to return to, and the approval overlay is never left underneath the
// planner. On a page with no approval address the strip is a no-op, and the planner simply
// rises over the page (Close lands back on it, where the decided band carries the door).
//
// ⚠️ THE ADDRESS CARRIES THE GATE'S ID AND NOTHING ELSE (§10f) — no reason text and no
// title. The overlay reads the seed on open (MOTIR-6210 · MOTIR-6208).

export interface OpenRefusalReplan {
  /** The address the door carries as its real `href` (a ⌘-click opens it in a new tab). */
  hrefFor: (gateId: string) => string;
  /** Strip the approval address and open the seeded planner, in one replace. */
  open: (gateId: string) => void;
}

export function useOpenRefusalReplan(): OpenRefusalReplan {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hrefFor = useCallback(
    (gateId: string) => {
      const qs = searchParams.toString();
      const host = withoutApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`);
      return withPlanningOverlay(host, { kind: 'refused-gate', gateId });
    },
    [pathname, searchParams],
  );

  const open = useCallback((gateId: string) => shallowReplace(hrefFor(gateId)), [hrefFor]);

  return { hrefFor, open };
}
