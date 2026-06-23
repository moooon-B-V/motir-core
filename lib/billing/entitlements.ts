// The §4 PM-core entitlement caps — the pure tier→limits POLICY half of cap
// enforcement (Story 8.1.11). Grounded ONE-TO-ONE in
// `docs/decisions/billing-tiering.md` §4 (the locked caps) and Axis B of §1 (the
// per-seat scaled-tracker line, distinct from the AI `PlanTier` of Axis A). This
// module is pure config + a tier resolver — NO DB, NO Stripe, NO cloud check; the
// gating + counting lives in `entitlementsService`, the cloud gate in
// `lib/billing/availability.ts` (`isCloudBilling`).
//
// ── Which signal drives these caps (read before touching) ──────────────────
// The PM-core scale caps key off the org's SCALED-TRACKER subscription
// (`Organization.scaledTrackerSubscription`, written by 8.1.4c — the schema
// comment names THIS subtask as its consumer), NOT the AI `PlanTier`. §4: the
// caps "are independent of the AI plan — an AI plan never lifts a cap." An ACTIVE
// scaled-tracker subscription lifts every cap (`scaled`); its absence / a
// past_due / a canceled state is the bounded `free` tier. (`enterprise` is a
// staff-set custom tier with no scaled-tracker representation yet — its caps are
// modelled here so the table is total, but `pmTierFromScaledTracker` only ever
// resolves `free`/`scaled` in v1.)

import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

/** The PM-core scale tier an org is on (Axis B — §1/§4). */
export type PmTier = 'free' | 'scaled' | 'enterprise' | 'meta';

/**
 * The kind of entitlement a create/upload hit — the machine-readable
 * `entitlement` field on `EntitlementExceededError` the UI keys its upgrade
 * prompt off (8.1.7/8.1.8).
 */
export type EntitlementKind =
  | 'work_items'
  | 'projects'
  | 'workspaces'
  | 'organizations'
  | 'file_size'
  | 'storage';

/** One tier's §4 caps. `null` = unlimited (the cap does not apply). */
export interface PmEntitlements {
  /** Max NON-archived-AND-archived work items across the org (§4.1 — a plain
   *  row count, NO archive filter; archiving does NOT free room). */
  maxWorkItems: number | null;
  /** Max projects across the org (§4.2). */
  maxProjects: number | null;
  /** Max workspaces in the org (§4.4). */
  maxWorkspaces: number | null;
  /** Per-file upload size in bytes (§4.3a). Always a concrete number. */
  maxUploadBytes: number;
  /** Total org storage in bytes — SUM(Attachment.sizeBytes) (§4.3b). `null` =
   *  unlimited (enterprise custom). */
  maxTotalStorageBytes: number | null;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * The v1 caps, exactly the §4 numbers (tunable seed policy — a later change is a
 * one-line edit here, no schema migration). `free` is the bounded default;
 * `scaled` lifts the scale caps and raises the upload limits; `enterprise` is
 * custom (uncapped scale + storage, 100 MB/file as the v1 default until a
 * staff-set value lands).
 */
export const PM_ENTITLEMENTS: Record<PmTier, PmEntitlements> = {
  free: {
    maxWorkItems: 250,
    maxProjects: 3,
    maxWorkspaces: 1,
    maxUploadBytes: 10 * MB,
    maxTotalStorageBytes: 2 * GB,
  },
  scaled: {
    maxWorkItems: null,
    maxProjects: null,
    maxWorkspaces: null,
    maxUploadBytes: 100 * MB,
    maxTotalStorageBytes: 100 * GB,
  },
  enterprise: {
    maxWorkItems: null,
    maxProjects: null,
    maxWorkspaces: null,
    maxUploadBytes: 100 * MB,
    maxTotalStorageBytes: null,
  },
  // The INTERNAL dogfood tier (moooon B.V., the meta org) — every cap lifted.
  // Kept as its OWN row (not an alias of `enterprise`) so the two can diverge:
  // `enterprise` is a future COMMERCIAL custom deal (negotiated/finite caps, a
  // real subscription, counts as revenue), whereas `meta` is never billed and
  // permanently unlimited. They coincide today; the separate row keeps a later
  // enterprise cap change from silently re-capping the meta org.
  meta: {
    maxWorkItems: null,
    maxProjects: null,
    maxWorkspaces: null,
    maxUploadBytes: 100 * MB,
    maxTotalStorageBytes: null,
  },
};

/** The caps for a tier. */
export function entitlementsFor(tier: PmTier): PmEntitlements {
  return PM_ENTITLEMENTS[tier];
}

/**
 * Resolve an org's PM tier from its scaled-tracker subscription (§4). An ACTIVE
 * subscription is `scaled` (caps lifted); null / past_due / canceled is `free`
 * (the bounded, non-destructive-downgrade state — §4: caps re-apply on read, no
 * data deleted). `enterprise` is not derivable from this column in v1.
 */
export function pmTierFromScaledTracker(sub: ScaledTrackerSubscription | null): PmTier {
  return sub?.status === 'active' ? 'scaled' : 'free';
}

/**
 * Resolve an org's PM tier from its full cap context. The META org (moooon B.V.,
 * `isMeta`) short-circuits to the internal `meta` tier — every cap lifted —
 * regardless of subscription; any other org defers to its scaled-tracker state
 * (`pmTierFromScaledTracker`). This is the SINGLE chokepoint the cap-enforcement
 * service resolves through, so the meta exemption (and every present/future §4
 * cap) is honoured here once rather than re-checked per gate.
 */
export function pmTierForOrg(input: {
  isMeta: boolean;
  scaledTrackerSubscription: ScaledTrackerSubscription | null;
}): PmTier {
  if (input.isMeta) return 'meta';
  return pmTierFromScaledTracker(input.scaledTrackerSubscription);
}
