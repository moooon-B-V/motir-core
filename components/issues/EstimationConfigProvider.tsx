'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { EstimationConfigDto } from '@/lib/dto/estimation';

// EstimationConfigProvider (Story 4.3 · Subtask 4.3.4) — the project-scoped
// estimation config + edit capability, made available to every inline
// `EstimateBadge` on a surface (backlog / board / issue detail / list) WITHOUT
// each badge re-fetching it. The surface's SERVER page reads the config once
// (`estimationService.getEstimationConfig`, one bounded query already in the
// render) + the actor's `canEdit` capability, and wraps the client subtree in
// this provider — so N badges share one config and the value never flashes.
//
// The config decides WHICH statistic the badge displays (story points default ·
// time estimate · issue count) and WHICH deck the picker offers; `canEdit` gates
// the click-to-edit affordance (a viewer sees the static read-only chip — the
// server rejects the write regardless, this just keeps the affordance honest,
// the 6.4.6 pattern the detail rail uses).

export interface EstimationConfigContextValue extends EstimationConfigDto {
  /** Whether the current actor may edit estimates on this project (6.4.6). */
  canEdit: boolean;
}

// A safe default for any badge rendered OUTSIDE a provider (e.g. the board
// DragOverlay clone, or a unit test that renders a card directly): the agile
// default statistic + Fibonacci deck, read-only. The badge still DISPLAYS the
// value; it just can't be edited until a real provider supplies `canEdit`.
const DEFAULT_VALUE: EstimationConfigContextValue = {
  estimationStatistic: 'story_points',
  pointScale: 'fibonacci',
  customScaleValues: [],
  canEdit: false,
};

const EstimationConfigContext = createContext<EstimationConfigContextValue>(DEFAULT_VALUE);

export function EstimationConfigProvider({
  config,
  canEdit,
  children,
}: {
  config: EstimationConfigDto;
  canEdit: boolean;
  children: ReactNode;
}) {
  const value = useMemo<EstimationConfigContextValue>(
    () => ({
      estimationStatistic: config.estimationStatistic,
      pointScale: config.pointScale,
      customScaleValues: config.customScaleValues,
      canEdit,
    }),
    [config.estimationStatistic, config.pointScale, config.customScaleValues, canEdit],
  );
  return (
    <EstimationConfigContext.Provider value={value}>{children}</EstimationConfigContext.Provider>
  );
}

/** Read the active estimation config + edit capability. Falls back to the agile
 *  default (read-only) when no provider is mounted, so a badge never crashes. */
export function useEstimationConfig(): EstimationConfigContextValue {
  return useContext(EstimationConfigContext);
}
