import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';

// THE FLEET MONITOR (MOTIR-7316 · Story MOTIR-6905) — what platform staff read on
// /admin/monitoring and the tenant page: per organisation, what it is running and
// whether it is being charged for it, plus the reconciler's kill record.
//
// ⚠️ Motir's internal accounting. Nothing here reaches a customer.

/**
 * One organisation's verdict. A CLOSED union: the page renders each by name and
 * the alert job (MOTIR-7318) fingerprints by it, so a new member is a change to
 * both, never a silent fall-through.
 *
 * The three MISMATCHES are `running_not_debited`, `debited_nothing_running` and
 * `exhausted_still_running` ({@link FLEET_MISMATCH_VERDICTS}). `balance_unknown`
 * is SHOWN and never alerted (an unreadable balance stops nothing, §3);
 * `not_charged` is an org Motir never debits; `ok` is none of the above.
 */
export type FleetVerdict =
  | 'running_not_debited'
  | 'debited_nothing_running'
  | 'exhausted_still_running'
  | 'balance_unknown'
  | 'not_charged'
  | 'ok';

export const FLEET_MISMATCH_VERDICTS = [
  'running_not_debited',
  'debited_nothing_running',
  'exhausted_still_running',
] as const satisfies readonly FleetVerdict[];

export type FleetMismatchVerdict = (typeof FLEET_MISMATCH_VERDICTS)[number];

export function isFleetMismatch(verdict: FleetVerdict): verdict is FleetMismatchVerdict {
  return (FLEET_MISMATCH_VERDICTS as readonly FleetVerdict[]).includes(verdict);
}

/** One organisation's fleet row — the monitor's line and the tenant page's card. */
export interface FleetOrgRowDTO {
  organizationId: string;
  /** Null when the org row could not be read (deleted between the reads). */
  name: string | null;
  isMeta: boolean;
  /** Running containers per workload — the census the admission reads. */
  byWorkload: Record<FleetWorkloadKind, number>;
  /** Containers counted against the org's pool (shared-pool workloads only). */
  poolUsed: number;
  /** The org's pool, or null when it could not be read. */
  pool: number | null;
  /** Whole minutes the live charge accrued for the org in the window. */
  accruedMinutesInWindow: number;
  /** Credits motir-ai has CONFIRMED this month (`ci_period_charge.debited_credits`). */
  confirmedCreditsThisMonth: number;
  /** Credits booked locally and not yet confirmed (`charged − debited`). */
  pendingCredits: number;
  /** Every verdict that holds, mismatches first; `['ok']` when nothing does. */
  verdicts: FleetVerdict[];
}

/** The window every verdict is judged over, carried so the page can say it. */
export interface FleetWindowDTO {
  windowMinutes: number;
  periodMinutes: number;
  /** ISO — the instant the verdicts were judged at. */
  judgedAt: string;
}

export type FleetRunningOrgsDTO =
  /** Off-cloud: there is no fleet and no meter, and nothing was read. */
  | { meter: 'disabled' }
  | {
      meter: 'enabled';
      window: FleetWindowDTO;
      rows: FleetOrgRowDTO[];
      /** Orgs running anything — the whole set, not this page. */
      total: number;
      /** Of those, how many hold at least one mismatch. */
      mismatched: number;
      page: number;
      pageSize: number;
      pageCount: number;
    };

export type FleetOrgDTO =
  | { meter: 'disabled' }
  | { meter: 'enabled'; window: FleetWindowDTO; row: FleetOrgRowDTO };

/** One machine the reconciler destroyed or stopped. */
export interface FleetKillDTO {
  id: string;
  app: string;
  machineId: string;
  machineName: string;
  reason: string;
  action: string;
  workload: string | null;
  organizationId: string | null;
  organizationName: string | null;
  ageSeconds: number;
  decidedAt: string;
  completedAt: string | null;
  /** Why the provider refused — set on a kill that did not complete. */
  failureDetail: string | null;
}

export type FleetKillsDTO =
  | { meter: 'disabled' }
  | {
      meter: 'enabled';
      since: string;
      rows: FleetKillDTO[];
      total: number;
      page: number;
      pageSize: number;
      pageCount: number;
    };
