// The operator console's CREDITS & PLAN card — MOTIR-747 · 10.3.2, design
// `platform-admin/design-notes.md` AMENDMENT 2026-10-03 Panels 1–2.
//
// Staff-facing only. The ledger is motir-ai's; these are the shapes core hands the
// Operations tab after reading it over the 7.1 boundary. Credits are Motir's
// internal unit, never a currency.

/** Who performed a staff ledger write, as motir-ai recorded it. */
export interface PlatformCreditActorDTO {
  userId: string;
  /** The display label captured when the action was taken (`Name <email>`). */
  label: string;
}

/** One ledger row, newest first on the card. */
export interface PlatformCreditLedgerEntryDTO {
  id: string;
  /** ISO-8601. */
  at: string;
  /**
   * Any `CreditTransaction` kind — `grant`, `adjustment`, `top_up`, `debit`,
   * `internal_offset`, … — not only the two staff kinds. The design's
   * `ops.ledger.kind.*` keys name the ones it draws; render an unknown kind by
   * its raw key rather than guessing.
   */
  kind: string;
  /** Signed. */
  credits: number;
  balanceAfter: number;
  reason: string | null;
  /** Null for a row no operator wrote (a debit, a top-up). */
  actor: PlatformCreditActorDTO | null;
}

/** A plan tier, as the credit service defines it. */
export interface PlatformCreditTierDTO {
  key: string;
  name: string;
  cadence: string;
  /** The tier's monthly (or per-cadence) allotment. */
  allotmentCredits: number;
}

/** One STAFF tier assignment. */
export interface PlatformCreditTierAssignmentDTO {
  id: string;
  at: string;
  fromTierKey: string | null;
  toTierKey: string;
  reason: string;
  actor: PlatformCreditActorDTO;
}

/**
 * The CREDITS & PLAN card's read: balance, plan, the latest staff plan change,
 * and one page of the ledger.
 */
export interface PlatformCreditLedgerPageDTO {
  organizationId: string;
  /**
   * False when motir-ai has never seen the org — it has not planned, been
   * charged, topped up or granted anything. `balanceCredits` is 0 and the ledger
   * empty, which the card renders as design Panel 8d, not as an error.
   */
  known: boolean;
  balanceCredits: number;
  /** Null for an org with no tier. */
  tier: PlatformCreditTierDTO | null;
  /**
   * The latest STAFF tier assignment, or null. Stripe also sets tiers, so this is
   * the reason for the current tier ONLY when `explainsCurrentTier` is true.
   */
  lastTierAssignment: PlatformCreditTierAssignmentDTO | null;
  /** True when `lastTierAssignment.toTierKey` is the tier the org is on now. */
  explainsCurrentTier: boolean;
  /** Newest first. */
  entries: PlatformCreditLedgerEntryDTO[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
  /** The large-grant threshold the dialog applies its typed confirm at. */
  largeGrantThresholdCredits: number;
}

/** What a grant or an adjustment reports back. */
export interface PlatformCreditWriteDTO {
  organizationId: string;
  /** The ledger row written (on a replay: the row written the first time). */
  entry: PlatformCreditLedgerEntryDTO;
  /** The balance as it stands now. */
  balanceCredits: number;
  /** True when this was a retry of an action that had already landed — nothing new was written. */
  idempotent: boolean;
  /** The action's idempotency key — reuse it to retry THIS action safely. */
  requestId: string;
}

/** What a plan change reports back. */
export interface PlatformPlanSetDTO {
  organizationId: string;
  assignment: PlatformCreditTierAssignmentDTO;
  tier: PlatformCreditTierDTO;
  /** False when the org was already on that tier (the assignment is still recorded). */
  changed: boolean;
  idempotent: boolean;
  requestId: string;
}
