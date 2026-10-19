'use client';

import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ResizableSplit } from '@/components/split/ResizableSplit';
import { PLANNING_FRAME_STACKED_ROWS } from '@/components/planning/planningFrameRows';
import { RAIL_WIDTH_STORAGE_KEY } from '@/lib/planning/railWidth';

/**
 * The planning workspace's RESIZABLE frame (MOTIR-6250) — now the host's adapter
 * over the shared `ResizableSplit` (MOTIR-9068), and nothing more.
 *
 * It exists so the four host facts stay on the planning side of the seam: the
 * divider's translated name (`planningWorkspace`), the persisted-width key, the
 * stacked row template and the reset signal. `PlanningWorkspace` is
 * server-renderable and the divider's label is translated copy that must stay
 * inside a client island, which is why this is a thin `'use client'` file rather
 * than a prop list the workspace fills in.
 */
export interface PlanningResizableFrameProps {
  canvas: ReactNode;
  chat: ReactNode;
  /**
   * Whether a plan PROPOSAL is present in the workspace's state. The reset fires
   * on the transition into `true` — the moment a proposal arrives — and not on a
   * route change, so it covers a plan being written as well as one that lands at
   * once.
   */
  proposalPresent?: boolean;
  /** Sizing for the frame, exactly as the fixed frame's `className` is. */
  className?: string;
}

export function PlanningResizableFrame({
  canvas,
  chat,
  proposalPresent = false,
  className,
}: PlanningResizableFrameProps) {
  const t = useTranslations('planningWorkspace');
  return (
    <ResizableSplit
      left={canvas}
      right={chat}
      storageKey={RAIL_WIDTH_STORAGE_KEY}
      dividerLabel={t('dividerAria')}
      stackedRows={PLANNING_FRAME_STACKED_ROWS}
      resetWhen={proposalPresent}
      className={className}
    />
  );
}
