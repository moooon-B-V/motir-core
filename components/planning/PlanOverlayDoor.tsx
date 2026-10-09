'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useOpenPlanOverlay, type KnownPlanFacts } from '@/lib/hooks/useOpenPlanOverlay';

// THE PLAN-OVERLAY DOOR as a link (Story MOTIR-7883 · MOTIR-7884).
//
// A real `next/link` whose `href` and click come from `useOpenPlanOverlay`, so a
// SERVER component — `PendingPlanNotice` has no `'use client'` — can place a door
// to a plan without becoming a client component itself. The landing is the
// destination rule's (`lib/planning/planDestination.ts`), never this file's.

export interface PlanOverlayDoorProps {
  planId: string;
  /** The plan's status, session and first anchor, when the caller already holds them. */
  known?: KnownPlanFacts;
  className?: string;
  'data-testid'?: string;
  'aria-label'?: string;
  children: ReactNode;
}

export function PlanOverlayDoor({
  planId,
  known,
  className,
  'data-testid': testId,
  'aria-label': ariaLabel,
  children,
}: PlanOverlayDoorProps) {
  const { href, open } = useOpenPlanOverlay(planId, known);
  return (
    <Link
      href={href}
      onClick={open}
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {children}
    </Link>
  );
}
