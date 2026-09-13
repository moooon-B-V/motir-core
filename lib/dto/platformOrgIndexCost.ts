// The org page's Index & fleet cost card (MOTIR-5341; design
// `platform-admin/design-notes.md` Panel 14). Internal accounting only — Motir does
// not charge for code indexing, and nothing here reaches a customer.

/** How the org is indexing right now — the design's a / b / c states, plus the ones
 *  the allowance itself can report. */
export type OrgIndexStateDTO =
  | 'under'
  | 'over_still_indexing'
  | 'stopped_no_credit'
  | 'stopped_allowance_exhausted'
  | 'exempt'
  | 'not_configured'
  | 'not_granted_yet'
  | 'other';

export interface PoolFiguresDTO {
  remaining: number;
  /** `null` when there is no grant to measure against. */
  granted: number | null;
  consumed: number | null;
  /** consumed / granted, as a percentage; `null` without both. */
  pct: number | null;
}

export type OrgIndexPoolsDTO =
  /** motir-ai did not answer — both pools read unknown, never zero. */
  | { state: 'unknown' }
  /** motir-ai has never seen this organisation. */
  | { state: 'absent' }
  | {
      state: 'read';
      tierName: string | null;
      /** The VISIBLE pool — what the customer sees. */
      credit: PoolFiguresDTO;
      /** The INTERNAL pool; `null` when nothing has been granted yet. */
      index: (PoolFiguresDTO & { window: string }) | null;
      indexState: OrgIndexStateDTO;
    };

export interface WorkloadCostLineDTO {
  workload: string;
  /** `null` when no container ran under this line this period — ABSENT, not zero. */
  containerCount: number | null;
  containerSeconds: number | null;
  /** Decimal string, exactly as the rollup produced it. */
  costUsd: string | null;
}

export type PlatformOrgIndexCostDTO =
  | { meter: 'disabled' }
  | {
      meter: 'enabled';
      pools: OrgIndexPoolsDTO;
      /** Credits spent by the planner and the hosted agent this month, or `null`
       *  when the usage read failed. */
      tokenSpendCredits: number | null;
      workloads: WorkloadCostLineDTO[];
      /** The recorded pause on the org's repositories, when indexing is stopped. */
      pause: { reason: string; since: string } | null;
    };
