import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { fleetKillSwitchEngaged } from '@/lib/ciFleet/limits';
import {
  fleetCeilingService,
  describeFleetCensus,
  FLEET_KILL_SWITCH_DETAIL,
} from '@/lib/services/fleetCeilingService';

// THE PROVISIONING GATE (Story MOTIR-1916 · MOTIR-1922, re-cut by MOTIR-6906 ·
// MOTIR-6907) — the one place that answers *should this intent get a runner at
// all?*, decided under a lock before anything is spent.
// `docs/decisions/fleet-per-org-pool.md` is the record.
//
// The guards, one call site, because they are answers to the same question about
// the same intent:
//
//   1. THE KILL SWITCH — `MOTIR_FLEET_MAX_IN_FLIGHT=0` stops every boot (§6).
//      What the fleet-wide ceiling (MOTIR-1997) became; nothing else of it is
//      left.
//   2. THE ORGANISATION'S POOL (§2) — `MOTIR_FLEET_ORG_MAX_IN_FLIGHT`, default
//      500, or the org's enterprise number. It counts the org's CI runners,
//      hosted-agent runs and index containers (`fleetCeilingService.orgCensus`),
//      so a CI job can wait because the SAME org's indexing filled its pool —
//      and never because another org's did. It replaces MOTIR-1922's per-project
//      tier caps, which are retired (§6): how an org shares its pool between its
//      own projects is its own business.
//   3. THE CREDIT REFUSAL — `ci_credits_exhausted` declines to boot. The state
//      comes from the SHIPPED `ciAllowanceService.getEntitlementState` and is
//      never re-derived here, so the billing panel, MOTIR-1907's Actions pause,
//      and this gate cannot come to disagree about whether an org is exhausted.
//
// ⚠️ WHY THIS EXISTS AT ALL — the safety valve that was removed. Moving off
// GitHub-hosted runners removed the account-wide 60-concurrent-job cap, which
// had been bounding BOTH one tenant's spend and one tenant's ability to starve
// the others, by accident rather than by design. Nothing external replaces it.
// `notes.html` #185 is the lesson that says what must: enforcement expressed in
// terms the PRODUCT controls, so that changing provider changes nothing about
// what stops the spend.
//
// ── THE DELIBERATE ASYMMETRY ────────────────────────────────────────────────
// Guard 3 fails OPEN today: if the entitlement read throws, BOOT and log (the
// fail-closed credit admission of §3 is MOTIR-6911's). Guards 1–2 fail CLOSED: if
// the org's pool or its count cannot be established, do NOT boot — a queued job
// is recoverable while a container nothing bounds is not.
//
// ── WHY THE CREDIT READ IS NOT INSIDE THE LOCKED TRANSACTION ────────────────
// It cannot be, and it should not be. `getEntitlementState` opens its own
// transaction under the ORG GUC (its membership read has no `system_admin`
// escape) and crosses the open-core boundary to motir-ai for the balance. Holding
// the FLEET-WIDE lock — which every admission in the system queues behind —
// across an HTTP call to another service would serialize the entire fleet behind
// motir-ai's latency, and a motir-ai timeout would become a fleet outage. So the
// pool is decided and the slot is CLAIMED under the lock; the credit state is
// read after, and a refusal RELEASES the claim. The window between them is
// microseconds of local work and errs toward the pool, never past it: for that
// moment the intent occupies a slot it may not keep. The org's pool override is
// read BEFORE the lock for the same reason (it is an org-GUC read).

/** Why an intent was not admitted. Every one of these leaves the intent PENDING,
 *  so the provisioning sweep retries it — a deferral, never a rejection. */
export type AdmissionDeferralReason =
  /** The organisation has no paid AI plan (MOTIR-6909) — the fleet is
   *  paid-AI-plan only. */
  | 'ai_plan_required'
  /** The organisation's AI plan could not be read. FAIL-CLOSED. */
  | 'plan_unknown'
  /** The intent's organisation already holds its whole pool (§2). Only that org
   *  waits. */
  | 'org_pool'
  /** The operator's kill switch is engaged (`MOTIR_FLEET_MAX_IN_FLIGHT=0`). */
  | 'fleet_ceiling'
  /** The org is past its pool AND out of credits. */
  | 'ci_credits_exhausted'
  /** The gate itself could not decide. FAIL-CLOSED: an unestablished count is
   *  treated as a full pool, not an empty one. */
  | 'gate_unavailable';

export type AdmissionVerdict =
  /** Admitted AND CLAIMED — the intent is now `provisioning` and the caller owns
   *  it. `orgInFlight` is the org's pool count at the decision (runners + index
   *  + hosted runs), for the caller's log. */
  | { outcome: 'admitted'; orgInFlight: number; orgPool: number }
  /** Another provisioner claimed it first. Not an error; the compare-and-set
   *  worked. */
  | { outcome: 'already_claimed' }
  /** Not admitted. The intent is still `pending`. */
  | { outcome: 'deferred'; reason: AdmissionDeferralReason; detail: string };

/** The words an `org_pool` CI deferral carries (`fleet-per-org-pool.md` §4). */
export function orgPoolCiDetail(inFlight: number, pool: number): string {
  return `Your organization is running ${inFlight} of its ${pool} CI containers. This job starts when one finishes.`;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const ciRunnerAdmissionService = {
  /**
   * Decide whether ONE provisioning intent may boot, and CLAIM it if so.
   *
   * The claim is part of the decision rather than a separate step the caller
   * takes afterwards, and that is the load-bearing detail: the claim is what
   * makes the intent count as in-flight, so a gate that decided and then let
   * someone else claim would be deciding from a count that does not yet include
   * the decisions already made. Deciding and claiming in ONE transaction, under
   * the lock, is what makes the caps exact.
   *
   * Never throws. Every refusal is a typed verdict, because the caller is a
   * background job: a throw becomes an Inngest retry, and retrying "the fleet is
   * full" achieves nothing a queued intent and the next sweep do not.
   */
  async admit(intent: CiRunnerProvisioningIntent): Promise<AdmissionVerdict> {
    // ONE instant for the whole decision. The census compares slot expiries
    // against it, and a gate that re-read the clock per workload could count a
    // slot as live for one workload and expired for the next.
    const now = new Date();

    // ── 1 · THE KILL SWITCH ───────────────────────────────────────────────────
    if (fleetKillSwitchEngaged()) {
      return { outcome: 'deferred', reason: 'fleet_ceiling', detail: FLEET_KILL_SWITCH_DETAIL };
    }

    // ── 1b · THE PAID-AI-PLAN GATE (MOTIR-6909) — plan, then pool, then credits ─
    const refused = await fleetCeilingService.planDeferral(intent.organizationId);
    if (refused) return refused;

    const pool = await fleetCeilingService.resolveOrgPool(intent.organizationId);
    if (pool === null) {
      // FAIL CLOSED: an org whose pool cannot be established must not be handed
      // the default by accident.
      console.error('[ciRunnerAdmissionService] could not resolve the org pool — not booting', {
        intentId: intent.id,
        organizationId: intent.organizationId,
      });
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: "could not resolve the organization's fleet pool",
      };
    }

    // ── 2 · The org's pool, and the claim — one locked transaction ────────────
    let claimed: AdmissionVerdict;
    try {
      claimed = await withSystemContext(async (tx) => {
        await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
        if (!(await locks.lockScope(FLEET_ADMISSION_SCOPE, tx))) {
          throw new Error('the fleet admission lock could not be taken');
        }

        // Counted from inside this transaction rather than through
        // `fleetCeilingService.reserve` precisely because it ALREADY holds
        // `FLEET_ADMISSION_SCOPE` and is mid-claim — re-entering would deadlock
        // the gate against itself. Not bypassed by `isMeta` (§1: meta keeps the
        // same pool).
        const census = await fleetCeilingService.orgCensus(intent.organizationId, now, tx);
        if (census.total >= pool) {
          return {
            outcome: 'deferred' as const,
            reason: 'org_pool' as const,
            detail: `${orgPoolCiDetail(census.total, pool)} (${describeFleetCensus(census)})`,
          };
        }

        // TAKE THE SLOT. The compare-and-set on `pending` is what makes the
        // count above true of the world the moment this transaction commits.
        const took = await intents.claimPending(intent.id, tx);
        if (!took) return { outcome: 'already_claimed' as const };

        return { outcome: 'admitted' as const, orgInFlight: census.total, orgPool: pool };
      });
    } catch (err) {
      // FAIL CLOSED. The transaction rolled back, so nothing was claimed and the
      // intent is still pending — the next sweep retries it. A count that could
      // not be established is treated as a full pool.
      console.error('[ciRunnerAdmissionService] the admission gate failed — not booting', {
        intentId: intent.id,
        organizationId: intent.organizationId,
        detail: detailOf(err),
      });
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: `the in-flight counts could not be established: ${detailOf(err)}`,
      };
    }

    if (claimed.outcome !== 'admitted') return claimed;

    // ── 3 · the credit refusal, on the claim we now hold ──────────────────────
    const exhausted = await this.isCreditsExhausted(intent.organizationId);
    if (exhausted) {
      // Give the slot back. A refusal must not leave the intent occupying
      // capacity it is not using.
      await this.releaseClaim(intent.id);
      return {
        outcome: 'deferred',
        reason: 'ci_credits_exhausted',
        detail: 'the org is past its included pool and out of credits',
      };
    }

    return claimed;
  },

  /**
   * Is this org in the `ci_credits_exhausted` state?
   *
   * ⚠️ FAILS OPEN, and the log is the point: a false here can mean either "the
   * org has credit" or "Motir could not tell", and only the log distinguishes
   * them. Refusing on a failed read would turn a motir-ai blip into every
   * tenant's CI stopping, which is precisely the outcome `getEntitlementState`'s
   * own `balance: null` treatment exists to avoid — this gate must not undo it
   * one layer up.
   *
   * Off-cloud and the meta org need no special case HERE: the shipped service
   * answers `bypassed` for both, which is not `ci_credits_exhausted` and
   * therefore boots. Re-deriving either condition locally is what the card
   * forbids ("do not re-derive the state").
   */
  async isCreditsExhausted(organizationId: string): Promise<boolean> {
    try {
      const state = await ciAllowanceService.getEntitlementState(organizationId, new Date());
      return state.state === 'ci_credits_exhausted';
    } catch (err) {
      console.error(
        '[ciRunnerAdmissionService] could not read CI entitlement — booting anyway (fail-open)',
        { organizationId, detail: detailOf(err) },
      );
      return false;
    }
  },

  /** Put a claimed intent back in the pending pool. Best-effort: the worst case
   *  is an intent that sits in `provisioning` until the stale-claim sweep writes
   *  it off, which is visible and bounded — a throw here would be neither. */
  async releaseClaim(intentId: string): Promise<void> {
    try {
      await withSystemContext((tx) => intents.releaseClaim(intentId, tx));
    } catch (err) {
      console.error('[ciRunnerAdmissionService] could not release a claim', {
        intentId,
        detail: detailOf(err),
      });
    }
  },
};
