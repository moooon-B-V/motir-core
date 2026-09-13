// The platform admin's Monitoring · Index allowance section (MOTIR-4595; design
// `platform-admin/design-notes.md` Panel 13). Internal accounting only — Motir does
// not charge for code indexing, and nothing here reaches a customer.

/** How a tier's crossing rate reads against the recalculate threshold. */
export type IndexTierReading = 'holds' | 'recalculate' | 'hard_stop' | 'unconfigured';

export interface IndexTierRowDTO {
  tierKey: string;
  tierName: string;
  cadence: 'one_time' | 'monthly';
  orgs: number;
  /** Paid tiers: orgs that crossed this period. `null` on a one-time tier. */
  crossed: number | null;
  /** One-time tiers: orgs at or past their grant. `null` on a monthly tier. */
  exhausted: number | null;
  /** `crossed / orgs` as a percentage, or `exhausted / orgs` on a one-time tier;
   *  `null` when the tier has no organisations. */
  ratePct: number | null;
  reading: IndexTierReading;
  allotmentCredits: number;
  /** `null` when no allowance is configured for the tier. */
  grantedCreditsPerOrg: number | null;
}

export type IndexAllowanceSummaryDTO =
  | { state: 'unknown' }
  | {
      state: 'read';
      window: string;
      tiers: IndexTierRowDTO[];
      /** Soft-gated tiers whose rate is over the threshold. */
      tiersOverThreshold: number;
      softGatedTiers: number;
      /** Organisations at their one-time limit, summed across one-time tiers. */
      oneTimeExhausted: number;
    };

/** The filter the Stopped orgs list is narrowed by. */
export type StoppedReasonFilter = 'all' | 'no_credit' | 'allowance_exhausted';

export interface StoppedOrgRowDTO {
  organizationId: string;
  organizationName: string;
  /** The org's motir-ai tier; `null` when motir-ai has never seen it; `'unknown'`
   *  when the tier lookup could not be made. */
  tierKey: string | null | 'unknown';
  /** `no_credit`, `allowance_exhausted`, or another `paused_index_*` stop. */
  reason: string;
  /** ISO-8601. */
  stoppedSince: string;
  /** The most commits any of its paused repositories' graphs is behind, or `null`
   *  when no current count exists. */
  graphBehind: number | null;
  pausedRepos: number;
}

export interface StoppedOrgsDTO {
  filter: StoppedReasonFilter;
  search: string | null;
  counts: { all: number; noCredit: number; allowanceExhausted: number };
  /** Stopped orgs matching the filter and search. */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  rows: StoppedOrgRowDTO[];
}

export type PlatformIndexAllowanceDTO =
  | { meter: 'disabled' }
  | {
      meter: 'enabled';
      threshold: { pct: number; provisional: boolean };
      summary: IndexAllowanceSummaryDTO;
      stopped: StoppedOrgsDTO;
    };
